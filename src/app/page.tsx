"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationSummary, SourceRef, StreamEvent, UiMessage } from "@/lib/types";

interface LiveSearch {
  id: string;
  query: string;
  done: boolean;
}

interface ViewMessage extends UiMessage {
  searches?: LiveSearch[];
  memoryHits?: number;
  error?: string;
  pending?: boolean;
}

const EXAMPLES = [
  "What's new in Postgres hosting pricing this month?",
  "Compare HubSpot, Pipedrive and Attio for a 20-person sales team",
  "What did I ask you last Tuesday? Is your answer still correct?",
];

export default function Chat() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshList = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) setConversations(await res.json());
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  async function openConversation(id: string) {
    if (busy) return;
    setActiveId(id);
    const res = await fetch(`/api/conversations/${id}`);
    setMessages(res.ok ? await res.json() : []);
  }

  function newChat() {
    if (busy) abortRef.current?.abort();
    setActiveId(null);
    setMessages([]);
  }

  async function removeConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (id === activeId) newChat();
    refreshList();
  }

  async function wipeAll() {
    if (!confirm("Delete all conversations stored on this machine? This can't be undone.")) return;
    await fetch("/api/conversations", { method: "DELETE" });
    newChat();
    refreshList();
  }

  function patchLast(fn: (m: ViewMessage) => ViewMessage) {
    setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    const nowIso = new Date().toISOString();
    setMessages((ms) => [
      ...ms,
      { id: `u-${nowIso}`, role: "user", text: message, createdAt: nowIso, sources: [] },
      { id: `a-${nowIso}`, role: "assistant", text: "", createdAt: nowIso, sources: [], searches: [], pending: true },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          conversationId: activeId,
          message,
          tzOffsetMinutes: -new Date().getTimezoneOffset(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) handleEvent(JSON.parse(line) as StreamEvent);
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        patchLast((m) => ({ ...m, error: "Connection lost. Please try again." }));
      }
    } finally {
      patchLast((m) => ({ ...m, pending: false }));
      setBusy(false);
      refreshList();
    }
  }

  function handleEvent(e: StreamEvent) {
    switch (e.type) {
      case "meta":
        setActiveId(e.conversationId);
        patchLast((m) => ({ ...m, memoryHits: e.memoryHits }));
        break;
      case "search":
        patchLast((m) => ({ ...m, searches: [...(m.searches ?? []), { id: e.id, query: e.query, done: false }] }));
        break;
      case "sources":
        patchLast((m) => ({
          ...m,
          searches: (m.searches ?? []).map((s) => (s.id === e.id ? { ...s, done: true } : s)),
          sources: mergeSources(m.sources, e.results),
        }));
        break;
      case "text":
        patchLast((m) => ({ ...m, text: m.text + e.delta }));
        break;
      case "done":
        patchLast((m) => ({ ...m, id: e.messageId, searches: (m.searches ?? []).map((s) => ({ ...s, done: true })) }));
        break;
      case "error":
        patchLast((m) => ({ ...m, error: e.message }));
        break;
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Minimi</h1>
        <button className="btn" onClick={newChat}>
          + New chat
        </button>
        <div className="list">
          {conversations.map((c) => (
            <div key={c.id} className={`conv ${c.id === activeId ? "active" : ""}`}>
              <button className="conv-title" onClick={() => openConversation(c.id)} title={c.title}>
                <span>{c.title}</span>
              </button>
              <button className="del" aria-label="Delete conversation" onClick={() => removeConversation(c.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
        <p className="privacy">Conversations are stored only on this machine. Search queries go to Exa; answers come from Claude.</p>
        <button className="btn subtle" onClick={wipeAll}>
          Delete all local data
        </button>
      </aside>

      <main className="main">
        <div className="thread">
          <div className="thread-inner">
            {messages.length === 0 && (
              <div className="empty">
                <h2>Ask me anything current.</h2>
                <p>I search the web and remember what we talked about, on this machine only.</p>
                <div className="activity" style={{ justifyContent: "center" }}>
                  {EXAMPLES.map((q) => (
                    <button key={q} className="chip" style={{ border: 0 }} onClick={() => send(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) =>
              m.role === "user" ? (
                <div key={m.id} className="msg user">
                  {m.text}
                </div>
              ) : (
                <div key={m.id} className="msg assistant">
                  {(m.memoryHits || m.searches?.length) ? (
                    <div className="activity">
                      {m.memoryHits ? <span className="chip">Recalled {m.memoryHits} past message(s)</span> : null}
                      {m.searches?.map((s) => (
                        <span key={s.id} className={`chip ${s.done ? "" : "live"}`}>
                          {s.done ? "Searched" : "Searching"}: {s.query}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {m.pending && !m.text && !m.searches?.length && <div className="meta">Thinking…</div>}
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
                  >
                    {m.text}
                  </ReactMarkdown>
                  {!m.pending && m.sources.length > 0 && (
                    <div className="sources">
                      {m.sources.slice(0, 8).map((s) => (
                        <a key={s.url} href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                          {s.title}
                          {s.publishedDate ? ` · ${s.publishedDate}` : ""}
                        </a>
                      ))}
                    </div>
                  )}
                  {m.error && <div className="error">{m.error}</div>}
                </div>
              ),
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        <div className="composer">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              rows={1}
              value={input}
              placeholder="Message Minimi…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
            />
            {busy ? (
              <button type="button" className="send" onClick={() => abortRef.current?.abort()}>
                Stop
              </button>
            ) : (
              <button type="submit" className="send" disabled={!input.trim()}>
                Send
              </button>
            )}
          </form>
        </div>
      </main>
    </div>
  );
}

function mergeSources(a: SourceRef[], b: SourceRef[]): SourceRef[] {
  const seen = new Set(a.map((s) => s.url));
  return [...a, ...b.filter((s) => !seen.has(s.url) && (seen.add(s.url), true))];
}
