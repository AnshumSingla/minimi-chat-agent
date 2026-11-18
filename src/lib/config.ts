import path from "node:path";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type Effort = "low" | "medium" | "high";

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  /** Server-side refusal fallback is available for this model. */
  serverFallback: boolean;
}

/** Allowlist shown in the UI picker. The browser can only choose from these. */
export const MODELS: ModelOption[] = [
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "Balanced: fast and accurate", serverFallback: true },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", hint: "Fastest and cheapest", serverFallback: false },
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "Deepest research, slower", serverFallback: true },
];

export function resolveModel(requested?: string | null): ModelOption {
  return (
    MODELS.find((m) => m.id === requested) ??
    MODELS.find((m) => m.id === config.model) ?? {
      id: config.model,
      label: config.model,
      hint: "Custom (from ANTHROPIC_MODEL)",
      serverFallback: false,
    }
  );
}

export const config = {
  /** Default model; the user can switch per message in the UI. */
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
    /** Minimum cosine similarity for a semantic (MiniLM) recall hit. */
    semanticThreshold: 0.35,
    /** Don't hold up a reply waiting for the local model to load. */
    embedTimeoutMs: 1500,
  },
  /** How many prior messages of the current conversation are replayed to the model. */
  historyMessages: 30,
};

export function requireEnv(name: "ANTHROPIC_API_KEY" | "EXA_API_KEY"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`);
  return v;
}
