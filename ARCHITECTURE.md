# Architecture

A chat agent with exactly one tool: **web search**. It must answer fast, get things right, be good to
talk to, and remember what the user asked earlier, so it can answer "What did I ask you on 3 November?
Is your answer still correct today?"

## Stack

| Concern        | Choice                                          | Why |
|----------------|-------------------------------------------------|-----|
| Runtime        | Node 20+ / TypeScript                           | Challenge rule |
| App            | Next.js (App Router), one process               | UI and API in one `npm run dev`, streaming route handlers |
| LLM            | Anthropic Claude via `@anthropic-ai/sdk`        | Model picker in the UI: Sonnet 5.5 (default), Haiku 5.5 (fastest), Opus 5.5 (deepest). Server-side allowlist |
| Web search     | Exa REST API (`/search`)                        | Returns page **text** and **published dates**, filters by date (`startPublishedDate`), which suits "has X changed since Monday?" |
| Memory         | Local SQLite file (`better-sqlite3`) + FTS5     | Zero setup, all data stays on the machine, full-text and date queries |
| Semantic recall| `all-MiniLM-L6-v2` on-device (`@huggingface/transformers`, ONNX) | 23 MB embedding model that runs locally (the same model Prism uses), so history is never sent to an embeddings API |
| Date parsing   | `chrono-node`                                   | Parses "last Tuesday", "on 3 November", "Monday" deterministically |
| Validation     | `zod`                                           | Tool inputs are untrusted model output |

**Rejected:**
- **DuckDuckGo:** no official API. Scraping is brittle, rate-limited and gives no page content or dates.
- **Anthropic's server-side `web_search` tool:** less control over sources, dates and caching, and the
  search step is hidden from our code.
- **Postgres/pgvector:** requires a running database, which breaks the plain `npm install && npm run dev`.
- **A hosted embeddings API or vector DB:** it would send user history to another vendor. Vectors are
  computed on-device by MiniLM and stored as BLOBs in the same SQLite file. A brute-force cosine scan is
  instant for a personal history (thousands of rows).
- **A small local model as the chat model** (e.g. MiniLM, or a 3–8B model via Ollama): MiniLM is an
  embedding model and can't generate text or call tools. Small generative models are much worse at
  multi-step search and synthesis, and Ollama is an extra install that breaks `npm run dev`. The privacy
  gain comes from keeping *storage and recall* local instead.
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
          │     ├ MiniLM (on-device) + FTS5: past turns matching the topic by meaning and keywords
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

### Hybrid recall

When the message refers to the past but gives no date ("earlier I asked you which sales software to buy"),
the user turns from other conversations are scored two ways:

- **Meaning:** cosine similarity of local MiniLM vectors, with a threshold of 0.35. Measured: a paraphrase
  such as "sales software" vs a "CRM shortlist" scores ~0.43, while unrelated chats score ≤0.3.
- **Keywords:** FTS5 / BM25 for exact terms such as product names, which small embedding models handle
  poorly.

Hits from both are merged; a turn that matches both ways is ranked higher. When a date is given, the
same scores rank turns from that day. The model loads at server start (`src/instrumentation.ts`). Recall
waits at most 1.5 s for it, and if it isn't ready, recall falls back to keywords only. Vectors missing
for older messages are filled in on later turns.

### Re-verification

Every stored answer keeps its **sources with `retrieved_at`** and `published_date`. When a
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
message_embeddings(message_id, vec BLOB)   -- MiniLM vectors for user messages
```

Timestamps are stored in UTC ISO-8601. Day windows are computed in the user's timezone, which the
browser sends with each request.

## Privacy

- **All conversation data stays local** in `./data/` (gitignored). No cloud database, analytics or logging of
  message contents.
- Next.js telemetry is disabled in the `dev` script.
- Embeddings are computed on-device. The model weights (~23 MB) are downloaded once from the Hugging
  Face hub into `./data/models`; no text is sent.
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
    api/models/route.ts              GET model allowlist for the picker
  instrumentation.ts                 warms up the local embedding model at server start
  lib/
    config.ts                        env, model allowlist, tuning knobs
    embeddings.ts                    on-device MiniLM embeddings
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
