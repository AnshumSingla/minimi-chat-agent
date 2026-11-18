import { z } from "zod";
import { runAgent, type MessageParam } from "@/lib/agent/loop";
import { turnContext } from "@/lib/agent/prompt";
import { config } from "@/lib/config";
import { addMessage, addSources, conversationExists, createConversation, recentMessages } from "@/lib/db";
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
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }
  const { message, tzOffsetMinutes, timeZone } = parsed.data;
  let conversationId = parsed.data.conversationId ?? null;
  if (!conversationId || !conversationExists(conversationId)) {
    conversationId = createConversation(message);
  }
  const convId = conversationId;
  const now = new Date();

  // History of this conversation (text-only replay; past turns' tool traffic is not resent).
  const history = recentMessages(convId, config.historyMessages);
  const memory = recall(message, convId, tzOffsetMinutes, now);
  addMessage(convId, "user", message, undefined, now.toISOString());

  const messages: MessageParam[] = history.map((m) => ({ role: m.role, content: m.text }));
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
        const result = await runAgent(messages, emit, req.signal);
        const messageId = addMessage(convId, "assistant", result.text);
        addSources(messageId, result.sources);
        emit({ type: "done", messageId });
      } catch (err) {
        if (!req.signal.aborted) {
          console.error("[chat] agent error:", (err as Error).message);
          emit({ type: "error", message: "Something went wrong while answering. Please try again." });
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
