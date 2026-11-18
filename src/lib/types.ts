/** Shared between server and browser. */

export interface SourceRef {
  url: string;
  title: string;
  publishedDate: string | null;
}

/** NDJSON events streamed from POST /api/chat. */
export type StreamEvent =
  | { type: "meta"; conversationId: string; memoryHits: number }
  | { type: "search"; id: string; query: string }
  | { type: "sources"; id: string; results: SourceRef[] }
  | { type: "text"; delta: string }
  | { type: "done"; messageId: string; sources: SourceRef[] }
  | { type: "error"; message: string };

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  sources: SourceRef[];
}
