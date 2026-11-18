import Anthropic from "@anthropic-ai/sdk";
import { config, requireEnv } from "../config";
import type { SourceRef, StreamEvent } from "../types";
import { SYSTEM_PROMPT } from "./prompt";
import { runWebSearch, webSearchTool } from "./tools";

export type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: requireEnv("ANTHROPIC_API_KEY") });
  return client;
}

export interface AgentResult {
  text: string;
  sources: (SourceRef & { query: string; retrievedAt: string })[];
  stopReason: string | null;
}

/**
 * Hand-written streaming agent loop.
 * - Streams text deltas and search progress through `emit`.
 * - Runs all web_search calls of one model step in parallel, returns them in one user message.
 * - Caps model<->tool round trips; the final allowed step runs without tools so the model must answer.
 * - Messages are append-only within the turn (required to replay thinking blocks safely).
 */
export async function runAgent(
  messages: MessageParam[],
  emit: (e: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<AgentResult> {
  const sources: AgentResult["sources"] = [];
  let text = "";
  let stopReason: string | null = null;

  for (let step = 0; step < config.maxIterations; step++) {
    const lastStep = step === config.maxIterations - 1;

    const stream = anthropic().beta.messages.stream(
      {
        model: config.model,
        max_tokens: config.maxTokens,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [webSearchTool],
        // On the final allowed step, keep the tool defined (history contains tool_use blocks)
        // but forbid calling it, so the model answers with what it has.
        tool_choice: { type: lastStep ? "none" : "auto" },
        messages,
        output_config: { effort: config.effort },
        // Server-side fallback: if the model declines (safety classifier false positive), the API
        // retries on a fallback model instead of returning an empty refusal.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );

    stream.on("text", (delta) => {
      text += delta;
      emit({ type: "text", delta });
    });

    const message = await stream.finalMessage();
    stopReason = message.stop_reason;
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

    const retrievedAt = new Date().toISOString();
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const q = (tu.input as { query?: string })?.query ?? "";
        emit({ type: "search", id: tu.id, query: q });
        const outcome = await runWebSearch(tu.input, signal);
        if (outcome.ok) {
          const refs = outcome.hits.map(({ url, title, publishedDate }) => ({ url, title, publishedDate }));
          emit({ type: "sources", id: tu.id, results: refs });
          for (const r of refs) sources.push({ ...r, query: outcome.query, retrievedAt });
        }
        return {
          type: "tool_result" as const,
          tool_use_id: tu.id,
          content: outcome.content,
          ...(outcome.ok ? {} : { is_error: true }),
        };
      }),
    );
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

  return { text: text.trim(), sources: dedupe(sources), stopReason };
}

function dedupe<T extends { url: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((s) => (seen.has(s.url) ? false : (seen.add(s.url), true)));
}
