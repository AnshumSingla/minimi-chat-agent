# Architecture

A chat agent with exactly one tool: **web search**. It must answer fast, get things right, be good to
talk to, and remember what the user asked earlier, so it can answer "What did I ask you on 3 November?
Is your answer still correct today?"

## Stack

| Concern        | Choice                                          | Why |
|----------------|-------------------------------------------------|-----|
| Runtime        | Node 20+ / TypeScript                           | Challenge rule |
| App            | Next.js (App Router), one process               | UI and API in one `npm run dev`, streaming route handlers |
| LLM            | Anthropic Claude via `@anthropic-ai/sdk`        | Sonnet 5.5 answers (fast, strong tool use); model is set by env |
| Web search     | Exa REST API (`/search`)                        | Returns page **text** and **published dates**, filters by date (`startPublishedDate`), which suits "has X changed since Monday?" |
| Memory         | Local SQLite file (`better-sqlite3`) + FTS5     | Zero setup, all data stays on the machine, full-text and date queries |
| Date parsing   | `chrono-node`                                   | Parses "last Tuesday", "on 3 November", "Monday" deterministically |
| Validation     | `zod`                                           | Tool inputs are untrusted model output |

**Rejected:**
- **DuckDuckGo:** no official API. Scraping is brittle, rate-limited and gives no page content or dates.
- **Anthropic's server-side `web_search` tool:** less control over sources, dates and caching, and the
  search step is hidden from our code.
- **Postgres/pgvector:** requires a running database, which breaks the plain `npm install && npm run dev`.
- **A vector DB for memory:** recall here is mostly *by date* and *by named entity*, which SQL and FTS
  handle exactly. Embeddings would add an API dependency and send user history to another vendor.
- **LangChain / Vercel AI SDK:** a ~150-line hand-written loop is easier to explain and debug, and
  it lets us check `stop_reason` precisely.

## Request flow

```
Browser (page.tsx)
  │  POST /api/chat {conversationId, message, timezone}
  ▼
route.ts ──► 1. persist user message (SQLite)
          ├► 2. RECALL (harness, not a tool)
          │     ├ chrono-node resolves dates in the message against "now" in the user's timezone
          │     ├ SQL: past turns inside those day windows
          │     ├ FTS5: past turns matching the topic ("Postgres hosting", "CRM")
          │     └ builds a <memory> block: past Q&A with timestamps + the sources used then
          ├► 3. build context: system prompt (static, cached) + history + [now, memory, user msg]
          ├► 4. AGENT LOOP (streaming)
          │     Claude ──tool_use: web_search──► Exa ──results──► Claude ──► … ──► final answer
          │     every event is streamed to the browser as NDJSON
          └► 5. persist assistant message + sources (url, title, published date, retrieved_at)
```

### Why recall is not a tool

The challenge says the agent has **one tool: web search**. Memory lookups therefore happen in the
harness *before* the model runs. This also helps:

- **Latency:** no extra model round-trip just to decide whether to look at memory.
- **Reliability:** date maths runs in deterministic code, not in the model. "Last Tuesday" resolves the same
  way every time, in the user's timezone.
- **Honesty:** if recall finds nothing, the memory block says so explicitly. The model is told to say "I
  don't have a record of that" instead of inventing a past conversation.

### Re-verification ("is your answer still correct today?")

Every stored assistant answer keeps its **sources with `retrieved_at`** and `published_date`. When a
past answer is recalled, the model sees *what it said, when, and from which pages*. It then searches
again, using `start_published_date` = the date of the original answer, to find what changed since. The
reply is shaped as: what I said then → what's true now → what changed (with sources).

## Agent loop

`src/lib/agent/loop.ts` is a hand-written streaming loop over `client.messages.stream()`:

- One tool, `web_search(query, start_published_date?, include_domains?, num_results?)`.
  Inputs are validated with zod and invalid input returns an `is_error` tool result.
- **Parallel searches:** the model may emit several `tool_use` blocks in one turn (e.g. one per CRM
  vendor). We run them concurrently and return all results in a single user message.
- **Iteration cap** (default 6) keeps latency bounded. On the last iteration tools are removed, so the
  model must answer with what it has.
- `stop_reason` is handled explicitly: `end_turn`, `tool_use`, `max_tokens`, `refusal`, `pause_turn`.
- Search results are trimmed per result (title, url, published date, ~1.5k chars of text) to keep
  context small and responses fast.

### Prompt and caching

- **System prompt is static** (persona, answer style, citation rules, search privacy rule). Nothing
  volatile goes in it, so it stays prompt-cacheable.
- **Volatile context goes in the user turn:** current date/time and timezone, and the `<memory>` block.
- Answer style: lead with the answer, short paragraphs or bullets, cite sources inline as
  `[title](url)`, state dates explicitly ("as of 19 Nov 2026"), and say what you're unsure about.

## Data model (SQLite, `./data/minimi.db`)

```
conversations(id, title, created_at, updated_at)
messages(id, conversation_id, role, text, content_json, created_at)
     -- text: plain text for display/search; content_json: full API blocks for faithful replay
sources(id, message_id, url, title, published_date, retrieved_at, query)
messages_fts  (FTS5 virtual table over messages.text, kept in sync by triggers)
```

Timestamps are stored in UTC ISO-8601. Day windows are computed in the user's timezone, which the
browser sends with each request.

## Privacy

- **All conversation data stays local** in `./data/` (gitignored). No cloud database, analytics or logging of
  message contents.
- Next.js telemetry is disabled in the `dev` script.
- Only two services receive data:
  1. **Anthropic:** the conversation context needed to answer.
  2. **Exa:** *search queries only*. The system prompt requires queries to contain only the public topic
     (e.g. `"HubSpot Sales Hub pricing change November 2026"`), never names or other personal details from
     the chat.
- Users can delete a conversation or wipe all data from the UI (`DELETE /api/conversations[/id]`).
  Deletion is a hard delete from SQLite, followed by `VACUUM`.

## Streaming protocol (server → browser)

NDJSON, one event per line:

```
{"type":"meta","conversationId":"…","memoryHits":2}
{"type":"search","id":"toolu_…","query":"…"}
{"type":"sources","id":"toolu_…","results":[{url,title,publishedDate}]}
{"type":"text","delta":"…"}
{"type":"done","messageId":"…"}
{"type":"error","message":"…"}
```

The UI shows "Searching: …" chips as they happen, so the user sees progress during multi-search turns.

## Layout

```
src/
  app/
    page.tsx                         chat UI (client component)
    layout.tsx, globals.css
    api/chat/route.ts                POST: run a turn, stream NDJSON
    api/conversations/route.ts       GET list, DELETE all
    api/conversations/[id]/route.ts  GET messages, DELETE one
  lib/
    config.ts                        env + model settings
    db.ts                            SQLite schema + queries
    memory.ts                        temporal resolution + recall
    search/exa.ts                    Exa client
    agent/prompt.ts                  system prompt + per-turn context
    agent/tools.ts                   web_search tool schema + executor
    agent/loop.ts                    streaming agent loop
    types.ts                         shared stream event types
scripts/seed-demo.ts                 optional: seed dated past conversations for testing recall
```

## With another week

- **Eval harness:** replay the challenge-style prompts against a seeded history and grade them with an
  LLM judge (correctness, freshness, citation quality, latency p50/p95).
- **Fact snapshots:** extract structured claims (vendor, price, date) from each answer so "has pricing
  changed?" becomes a precise diff instead of relying on the model's re-reading.
- **Page fetch / re-rank:** a second pass that pulls full text for the top 1–2 results when snippets
  aren't enough.
- **Encryption at rest** (SQLCipher) behind a local passphrase.
- **Conversation compaction** for very long threads.
