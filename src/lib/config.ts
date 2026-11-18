import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type Effort = "low" | "medium" | "high";

export const config = {
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  // Chat answers don't benefit much from deep thinking; low keeps latency down.
  effort: (["low", "medium", "high"].includes(process.env.AGENT_EFFORT ?? "")
    ? process.env.AGENT_EFFORT
    : "low") as Effort,
  maxIterations: int("AGENT_MAX_ITERATIONS", 6),
  maxTokens: 16000,
  dbPath: path.resolve(process.env.MINIMI_DB_PATH || "./data/minimi.db"),
  search: {
    defaultResults: 5,
    maxResults: 8,
    maxCharsPerResult: 1500,
    timeoutMs: 12_000,
  },
  memory: {
    maxRecalledTurns: 6,
    maxCharsPerTurn: 1800,
  },
  /** How many prior messages of the current conversation are replayed to the model. */
  historyMessages: 30,
};

export function requireEnv(name: "ANTHROPIC_API_KEY" | "EXA_API_KEY"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return v;
}
