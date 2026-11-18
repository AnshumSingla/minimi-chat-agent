import Anthropic from "@anthropic-ai/sdk";
import { config, requireEnv, type ModelOption } from "../config";
import { scrubQuery } from "../search/scrub";
import type { SourceRef, StreamEvent } from "../types";
import { SYSTEM_PROMPT } from "./prompt";
import { renderHits, runWebSearch, webSearchTool, type ToolOutcome } from "./tools";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return client;
}

type SavedSource = SourceRef & { query: string; retrievedAt: string };

export interface AgentResult {
  text: string;
  /** Sources the answer cites (falls back to everything retrieved if it cites none by URL). */
  sources: SavedSource[];
  stopReason: string | null;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Hand-written streaming agent loop.
 * - Streams text deltas and search progress through `emit`.
 * - Runs all web_search calls of one model step in parallel, returns them in one user message.
 * - Caps model<->tool round trips; on the last step tools are disabled so the model must answer.
 * - Messages are append-only within the turn: required to replay thinking blocks, and it is what
 *   makes the automatic prompt cache hit on every step after the first.
 */
export async function runAgent(
  messages: MessageParam[],
  emit: (e: StreamEvent) => void,
  opts: { model: ModelOption; signal?: AbortSignal },
): Promise<AgentResult> {
  const { model, signal } = opts;
  const started = Date.now();
  const retrieved: SavedSource[] = [];
  const seen = new Map<string, number>(); // url -> result number shown to the model this turn
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let text = "";
  let stopReason: string | null = null;
  let steps = 0;
  let searches = 0;

  for (let step = 0; step < config.maxIterations; step++) {
    const lastStep = step === config.maxIterations - 1;
    steps++;

    const stream = anthropic().beta.messages.stream(
      {
        model: model.id,
        max_tokens: config.maxTokens,
        system: [{ type: "text", text: SYSTEM_PROMPT }],
        tools: [webSearchTool],
        // On the final allowed step, keep the tool defined (history contains tool_use blocks)
        // but forbid calling it, so the model answers with what it has.
        tool_choice: { type: lastStep ? "none" : "auto" },
        messages,
        // Automatic caching: the breakpoint moves to the end of the conversation each request, so
        // step N+1 reads steps 1..N (incl. all search results) from cache at ~10% of the input price.
        // The system prompt alone is below the minimum cacheable length, so a breakpoint there did nothing.
        cache_control: { type: "ephemeral" },
        output_config: { effort: config.effort },
        // Server-side fallback: if the model declines (safety classifier false positive), the API
        // retries on a fallback model instead of returning an empty refusal. Not offered for Haiku.
        ...(model.serverFallback
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal },
    );

    stream.on("text", (delta) => {
      text += delta;
      emit({ type: "text", delta });
    });

    const message = await stream.finalMessage();
    stopReason = message.stop_reason;
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use",
    );
    if (message.stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Separate consecutive text segments (e.g. preamble before a search) in the rendered answer.
    if (text && !text.endsWith("\n")) {
      text += "\n\n";
      emit({ type: "text", delta: "\n\n" });
    }

    // Run searches in parallel, then render in call order so result numbering is deterministic.
    const retrievedAt = new Date().toISOString();
    searches += toolUses.length;
    const outcomes: ToolOutcome[] = await Promise.all(
      toolUses.map(async (tu) => {
        const shown = scrubQuery(String((tu.input as { query?: unknown })?.query ?? "")).query;
        emit({ type: "search", id: tu.id, query: shown });
        const outcome = await runWebSearch(tu.input, signal);
        if (outcome.ok) {
          emit({
            type: "sources",
            id: tu.id,
            results: outcome.hits.map(({ url, title, publishedDate }) => ({ url, title, publishedDate })),
          });
        }
        return outcome;
      }),
    );

    const results = toolUses.map((tu, i) => {
      const outcome = outcomes[i];
      if (!outcome.ok) {
        return { type: "tool_result" as const, tool_use_id: tu.id, content: outcome.content, is_error: true };
      }
      for (const h of outcome.hits) {
        retrieved.push({ url: h.url, title: h.title, publishedDate: h.publishedDate, query: outcome.query, retrievedAt });
      }
      return { type: "tool_result" as const, tool_use_id: tu.id, content: renderHits(outcome.hits, seen) };
    });
    messages.push({ role: "user", content: results });
  }

  if (!text.trim()) {
    const fallback =
      stopReason === "refusal"
        ? "Sorry, I can't help with that one."
        : "I couldn't finish that answer. Could you try rephrasing or narrowing the question?";
    text = fallback;
    emit({ type: "text", delta: fallback });
  }

  // Metrics only, never content: lets you see what a turn cost and whether the cache is working.
  console.info(
    `[turn] model=${model.id} steps=${steps} searches=${searches} ms=${Date.now() - started} ` +
      `in=${usage.input} cache_read=${usage.cacheRead} cache_write=${usage.cacheWrite} out=${usage.output} stop=${stopReason}`,
  );

  return { text: text.trim(), sources: citedSources(text, dedupe(retrieved)), stopReason };
}

function dedupe<T extends { url: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}

const norm = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/[/#?]+$/, "").toLowerCase();

/**
 * Keep the sources the answer actually links to: they are what gets shown and stored for later
 * "is that still true?" checks. If the answer cites nothing by URL, keep the top retrieved pages.
 */
function citedSources(text: string, all: SavedSource[]): SavedSource[] {
  const body = text.toLowerCase();
  const cited = all.filter((s) => body.includes(norm(s.url)));
  return cited.length ? cited : all.slice(0, 6);
}
