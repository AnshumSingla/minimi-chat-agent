import { config, requireEnv } from "../config";
import type { SourceRef } from "../types";

/** Thin client over Exa's REST search endpoint. Only the query string leaves the machine. */

export interface SearchParams {
  query: string;
  numResults?: number;
  startPublishedDate?: string; // ISO date
  includeDomains?: string[];
}

export interface SearchHit extends SourceRef {
  text: string;
}

interface ExaResult {
  title?: string | null;
  url: string;
  publishedDate?: string | null;
  text?: string | null;
}

export async function exaSearch(p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    query: p.query,
    type: "auto",
    numResults: Math.min(p.numResults ?? config.search.defaultResults, config.search.maxResults),
    contents: { text: { maxCharacters: config.search.maxCharsPerResult } },
  };
  if (p.startPublishedDate) body.startPublishedDate = p.startPublishedDate;
  if (p.includeDomains?.length) body.includeDomains = p.includeDomains;

  const timeout = AbortSignal.timeout(config.search.timeoutMs);
  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": requireEnv("EXA_API_KEY") },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    throw new Error(`Exa search failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: ExaResult[] };
  return (json.results ?? []).map((r) => ({
    url: r.url,
    title: (r.title || r.url).trim(),
    publishedDate: r.publishedDate ? r.publishedDate.slice(0, 10) : null,
    text: (r.text ?? "").replace(/\s+/g, " ").trim(),
  }));
}
