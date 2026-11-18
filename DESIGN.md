# DESIGN.md

> Draft. Keep to one page and update it as the build changes. Full detail is in [ARCHITECTURE.md](ARCHITECTURE.md).

## How it works

A Next.js app in a single process. Each user message goes through four steps:

1. **Recall (in code).** Dates in the message ("last Tuesday", "3 November") are resolved
   deterministically in the user's timezone. Past turns from those days, plus full-text matches on the
   topic, are pulled from a local SQLite database.
2. **Context.** A static, cacheable system prompt, the conversation history, and a per-turn block with
   the current date and the recalled memory (what was asked, what was answered, when, and from which
   sources).
3. **Agent loop.** Claude streams its answer and calls one tool, `web_search` (Exa), as often as it
   needs. Calls can run in parallel and are capped per turn. Searches can be filtered to "published
   since <date of the original answer>".
4. **Persist.** The answer and every source used (with `retrieved_at`) are stored, so a later "is
   that still true?" can be checked against them.

## Why this way

- **Only one tool.** Memory lookup is harness logic, not a second tool. It is also faster (no extra
  model hop), and date maths is more reliable in code than in the model.
- **Right over fast, but fast.** Sonnet-class model, parallel searches, trimmed results, streaming
  progress ("Searching: …") and an iteration cap.
- **Freshness is explicit.** Every claim carries a date. The agent re-searches with a date filter when
  asked whether something changed.
- **Private by default.** Conversations live in a local SQLite file. Exa receives only topic-level
  queries, and telemetry is off.

## Considered and rejected

- DuckDuckGo (no API, no content or dates), Anthropic's server-side search (less control), vector DB
  memory (recall here is by date and entity), Postgres (breaks `npm run dev`), agent frameworks (a
  hand-written loop is easier to explain).

## With another week

Eval harness with an LLM judge over seeded histories, structured fact snapshots for exact price diffs,
full-page fetch for top results, SQLCipher encryption, and conversation compaction.
