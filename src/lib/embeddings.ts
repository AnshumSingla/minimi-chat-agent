import path from "node:path";
import { config } from "./config";

/**
 * On-device sentence embeddings with all-MiniLM-L6-v2 (the same model Prism uses), via
 * transformers.js on onnxruntime-node. ~23 MB, 384 dims, ~20 ms per call on CPU.
 *
 * Privacy: the model weights are downloaded once from the Hugging Face hub into ./data/models;
 * text is never sent anywhere. If the model can't load (e.g. offline on first run),
 * every function here returns null and recall falls back to date + full-text search.
 */

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

type Extractor = (texts: string[], opts: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

const g = globalThis as unknown as { __minimiEmbedder?: Promise<Extractor | null> };

function load(): Promise<Extractor | null> {
  g.__minimiEmbedder ??= (async () => {
    try {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = path.join(path.dirname(config.dbPath), "models");
      const fe = await pipeline("feature-extraction", MODEL_ID, { dtype: "q8" });
      return fe as unknown as Extractor;
    } catch (err) {
      console.warn("[embeddings] local model unavailable, using full-text recall only:", (err as Error).message);
      g.__minimiEmbedder = undefined; // allow a retry on a later request
      return null;
    }
  })();
  return g.__minimiEmbedder;
}

/** Start loading in the background (first run downloads the weights). */
export function warmUp(): void {
  void load();
}

/** Embed texts; returns null if the model isn't ready within `timeoutMs`. */
export async function embed(texts: string[], timeoutMs = config.memory.embedTimeoutMs): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
  const fe = await Promise.race([load(), timeout]);
  if (!fe) return null;
  const out = await fe(texts.map((t) => t.slice(0, 2000)), { pooling: "mean", normalize: true });
  return out.tolist().map((v) => Float32Array.from(v));
}

/** Vectors are L2-normalised, so the dot product is the cosine similarity. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
