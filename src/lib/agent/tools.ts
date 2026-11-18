import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { exaSearch, type SearchHit } from "../search/exa";

/** The agent's one and only tool. */
export const webSearchTool: Anthropic.Beta.Messages.BetaTool = {
  name: "web_search",
  description:
    "Search the live web. Returns the top pages with title, URL, published date and an extract of the page text. " +
    "Use it for anything that may have changed since your training data: prices, releases, news, product features, " +
    "people's roles, availability. Issue several searches in parallel when comparing several things (one per vendor/product). " +
    "Use start_published_date to find only pages published after a date, e.g. to check what changed since an earlier answer. " +
    "Queries must name only public topics (products, companies, events), never personal details about the user.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A specific search-engine query, e.g. 'Neon Postgres pricing change 2026'.",
      },
      start_published_date: {
        type: "string",
        description: "Optional ISO date (YYYY-MM-DD). Only return pages published on/after this date.",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description: "Optional list of domains to restrict to, e.g. ['hubspot.com'] for official pricing pages.",
      },
      num_results: {
        type: "integer",
        minimum: 1,
        maximum: 8,
        description: "How many results (default 5).",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const WebSearchInput = z.object({
  query: z.string().min(2).max(400),
  start_published_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  include_domains: z.array(z.string().min(3)).max(10).optional(),
  num_results: z.number().int().min(1).max(8).optional(),
});

export type ToolOutcome =
  | { ok: true; query: string; hits: SearchHit[]; content: string }
  | { ok: false; query: string; content: string };

/** Validate the model's input and run the search. Never throws: errors become is_error tool results. */
export async function runWebSearch(rawInput: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  const parsed = WebSearchInput.safeParse(rawInput);
  const query = typeof (rawInput as { query?: unknown })?.query === "string" ? (rawInput as { query: string }).query : "";
  if (!parsed.success) {
    return { ok: false, query, content: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  try {
    const hits = await exaSearch(
      {
        query: parsed.data.query,
        numResults: parsed.data.num_results,
        startPublishedDate: parsed.data.start_published_date,
        includeDomains: parsed.data.include_domains,
      },
      signal,
    );
    if (hits.length === 0) {
      return { ok: true, query: parsed.data.query, hits, content: "No results. Try a broader or differently worded query." };
    }
    const content = hits
      .map(
        (h, i) =>
          `[${i + 1}] ${h.title}\nURL: ${h.url}\nPublished: ${h.publishedDate ?? "unknown"}\n${h.text}`,
      )
      .join("\n\n");
    return { ok: true, query: parsed.data.query, hits, content };
  } catch (err) {
    return { ok: false, query: parsed.data.query, content: `Search failed: ${(err as Error).message}` };
  }
}
