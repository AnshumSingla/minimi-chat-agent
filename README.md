# Minimi chat agent

A chat agent with one tool, **web search**, and **private, local memory** of past conversations, so it
can answer "What did I ask you on 3 November? Is your answer still correct today?"

- How it works and why: [DESIGN.md](DESIGN.md)
- Full architecture: [ARCHITECTURE.md](ARCHITECTURE.md)

## Run

```bash
npm install
cp .env.example .env.local   # then add ANTHROPIC_API_KEY and EXA_API_KEY
npm run dev
```

Open http://localhost:3000.

Optional: `npm run seed:demo` adds three dated past conversations (last Monday, last Tuesday and
3 November), so you can try recall right away.

## Privacy

Conversations are stored only in `./data/minimi.db` on your machine (gitignored). Anthropic receives the
chat context needed to answer. Exa receives search queries only. Delete a conversation, or all local data,
from the sidebar.
