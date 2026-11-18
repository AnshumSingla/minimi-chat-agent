import { z } from "zod";
import { runAgent, type MessageParam } from "@/lib/agent/loop";
import { turnContext } from "@/lib/agent/prompt";
import { config, resolveModel } from "@/lib/config";
import { addMessage, addSources, conversationExists, createConversation, recentMessages, type StoredMessage } from "@/lib/db";
import { guard } from "@/lib/guard";
import { recall } from "@/lib/memory";
import type { StreamEvent } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1).max(8000),
  /** Minutes east of UTC, i.e. -new Date().getTimezoneOffset() in the browser. */
  tzOffsetMinutes: z.number().int().min(-840).max(840).default(0),
  timeZone: z.string().max(64).optional(),
  /** Must be one of the allowlisted MODELS; anything else falls back to the default. */
  model: z.string().max(64).optional(),
});

/**
 * Replay recent history as plain text within a character budget (newest kept first).
 * Also guarantees a valid shape: starts with a user turn, no two consecutive turns from the same
 * role (e.g. a user message whose answer failed or was aborted).
 */
function historyToMessages(history: StoredMessage[]): MessageParam[] {
  const kept: StoredMessage[] = [];
  let budget = config.historyChars;
  for (let i = history.length - 1; i >= 0; i--) {
    budget -= history[i].text.length;
    if (budget < 0) break;
    kept.unshift(history[i]);
  }
  while (kept.length && kept[0].role !== "user") kept.shift();

  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of kept) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.text;
    else out.push({ role: m.role, content: m.text });
  }
  // The new user turn is appended next; don't end on a user turn ourselves.
  if (out.length && out[out.length - 1].role === "user") out.push({ role: "assistant", content: "(no answer was recorded)" });
  return out;
}

export async function POST(req: Request) {
  const denied = guard(req, { json: true });
  if (denied) return denied;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { message, tzOffsetMinutes, timeZone } = parsed.data;
  const model = resolveModel(parsed.data.model);
  let conversationId = parsed.data.conversationId ?? null;
  if (!conversationId || !conversationExists(conversationId)) {
    conversationId = createConversation(message);
  }
  const convId = conversationId;
  const now = new Date();

  // History of this conversation: text-only replay. Past turns' search results are not resent,
  // which keeps follow-up turns small; the model can search again if it needs the evidence.
  const history = recentMessages(convId, config.historyMessages);
  const memory = await recall(message, convId, tzOffsetMinutes, now);
  addMessage(convId, "user", message, undefined, now.toISOString());

  const messages: MessageParam[] = historyToMessages(history);
  messages.push({
    role: "user",
    content: [
      { type: "text", text: turnContext({ now, offsetMin: tzOffsetMinutes, timeZone, memoryBlock: memory.block }) },
      { type: "text", text: message },
    ],
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: StreamEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      emit({ type: "meta", conversationId: convId, memoryHits: memory.hits });
      try {
        const result = await runAgent(messages, emit, { model, signal: req.signal });
        const messageId = addMessage(convId, "assistant", result.text);
        addSources(messageId, result.sources);
        emit({
          type: "done",
          messageId,
          sources: result.sources.map(({ url, title, publishedDate }) => ({ url, title, publishedDate })),
        });
      } catch (err) {
        if (!req.signal.aborted) {
          const msg = (err as Error).message;
          console.error("[chat] agent error:", msg.slice(0, 300));
          // Setup problems (missing keys) are safe and useful to show; anything else stays generic.
          emit({
            type: "error",
            message: /is not set/.test(msg) ? msg : "Something went wrong while answering. Please try again.",
          });
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}
