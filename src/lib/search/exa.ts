import { config, requireEnv } from "../config";
import type { SourceRef } from "../types";

/**
 * Thin client over Exa's REST search endpoint. Only the (scrubbed) query string leaves the machine.
 *
 * - Content: query-relevant highlights first, then a short page extract. Taking only the first N
 *   characters of a page mostly returns navigation; highlights get the pricing table or changelog entry.
 * - Cache: identical searches within a few minutes (retries, follow-ups, parallel duplicates) are
 *   answered from memory. In-memory only, never written to disk.
 * - Resilience: one retry on 429/5xx/timeouts; if Exa rejects an optional parameter (400), retry
 *   with the plain query instead of failing the tool call.
 */

export type SearchCategory = "news" | "company" | "github" | "pdf" | "research paper";

export interface SearchParams {
  query: string;
  numResults?: number;
  startPublishedDate?: string; // ISO date
  includeDomains?: string[];
  category?: SearchCategory;
  /** Prefer a live crawl over Exa's cached copy (current prices/plans). Slower. */
  fresh?: boolean;
}

export interface SearchHit extends SourceRef {
  text: string;
}

interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  text?: string | null;
  highlights?: string[] | null;
}

const cache = new Map<string, { at: number; hits: SearchHit[] }>();
const inflight = new Map<string, Promise<SearchHit[]>>();

function cacheKey(p: SearchParams): string {
  return JSON.stringify([p.query.toLowerCase().trim(), p.numResults, p.startPublishedDate, p.includeDomains, p.category, p.fresh]);
}

function buildBody(p: SearchParams, minimal: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query: p.query,
    type: "auto",
    numResults: Math.min(p.numResults ?? config.search.defaultResults, config.search.maxResults),
    contents: {
      text: { maxCharacters: config.search.maxTextChars },
      highlights: { query: p.query, numSentences: 3, highlightsPerUrl: 3 },
      ...(p.fresh && !minimal ? { livecrawl: "preferred" } : {}),
    },
  };
  if (minimal) return body;
  if (p.startPublishedDate) body.startPublishedDate = p.startPublishedDate;
  if (p.includeDomains?.length) body.includeDomains = p.includeDomains;
  if (p.category) body.category = p.category;
  return body;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function post(body: Record<string, unknown>, signal?: AbortSignal): Promise<ExaResult[]> {
  const timeout = AbortSignal.timeout(config.search.timeoutMs);
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": requireEnv("EXA_API_KEY") },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new HttpError(res.status, `Exa search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { results?: ExaResult[] }).results ?? [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(p: SearchParams, signal?: AbortSignal): Promise<ExaResult[]> {
  try {
    return await post(buildBody(p, false), signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    const status = err instanceof HttpError ? err.status : 0; // 0 = network error / timeout
    if (status === 400) return post(buildBody(p, true), signal); // an optional field was rejected
    if (status === 429 || status >= 500 || status === 0) {
      await sleep(600);
      return post(buildBody(p, false), signal);
    }
    throw err;
  }
}

function toHit(r: ExaResult): SearchHit {
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const highlights = (r.highlights ?? []).map(clean).filter(Boolean);
  const text = clean(r.text ?? "");
  // Highlights carry the query-relevant passages; the extract adds context. Cap the total.
  const body = [highlights.length ? highlights.map((h) => `> ${h}`).join("\n") : "", text]
    .filter(Boolean)
    .join("\n")
    .slice(0, config.search.maxCharsPerResult);
  return {
    url: r.url,
    title: (r.title || r.url).trim(),
    publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : null,
    text: body,
  };
}

export async function exaSearch(p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const key = cacheKey(p);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.search.cacheTtlMs) return hit.hits;

  let pending = inflight.get(key);
  if (!pending) {
    pending = fetchWithRetry(p, signal)
      .then((results) => results.map(toHit))
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const hits = await pending;

  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string); // oldest first (insertion order)
  return hits;
}
