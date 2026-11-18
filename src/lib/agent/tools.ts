import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { exaSearch, type SearchHit } from "../search/exa";
import { scrubQuery } from "../search/scrub";

const CATEGORIES = ["news", "company", "github", "pdf", "research paper"] as const;

/** The agent's one and only tool. */
export const webSearchTool: Anthropic.Beta.Messages.BetaTool = {
  name: "web_search",
  description:
    "Search the live web. Returns the top pages with title, URL, published date, the passages most relevant to the query (lines starting with '>'), and a short extract. " +
    "Use it for anything that may have changed since your training data: prices, releases, news, product features, people's roles, availability. " +
    "Issue several searches in parallel when comparing several things (one per vendor/product). " +
    "Queries must name only public topics (products, companies, events), never personal details about the user; identifiers like emails and phone numbers are stripped automatically.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "A specific search-engine query, e.g. 'Neon Postgres pricing change 2026'.",
      },
      start_published_date: {
        type: "string",
        description:
          "Optional ISO date (YYYY-MM-DD). Only return pages with a publish date on/after it. Good for news, announcements and changelogs since an earlier answer. " +
          "Warning: undated pages (most pricing pages) are excluded, so to check CURRENT prices search without this filter (ideally with fresh=true).",
      },
      include_domains: {
        type: "array",
        items: { type: "string" },
        description: "Optional domains to restrict to, e.g. ['hubspot.com'] for official pricing pages.",
      },
      category: {
        type: "string",
        enum: [...CATEGORIES],
        description: "Optional: 'news' for announcements and launches; 'company' for company pages; 'github' for repos/releases.",
      },
      fresh: {
        type: "boolean",
        description: "Optional: crawl pages live instead of using cached copies. Use for current prices/plans; adds a few seconds.",
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
  category: z.enum(CATEGORIES).optional(),
  fresh: z.boolean().optional(),
  num_results: z.number().int().min(1).max(8).optional(),
});

export type ToolOutcome =
  | { ok: true; query: string; hits: SearchHit[] }
  | { ok: false; query: string; content: string };

/** Validate the model's input, scrub the query and run the search. Never throws. */
export async function runWebSearch(rawInput: unknown, signal?: AbortSignal): Promise<ToolOutcome> {
  const parsed = WebSearchInput.safeParse(rawInput);
  const rawQuery = typeof (rawInput as { query?: unknown })?.query === "string" ? (rawInput as { query: string }).query : "";
  if (!parsed.success) {
    return { ok: false, query: rawQuery, content: `Invalid input: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const { query, removed } = scrubQuery(parsed.data.query);
  if (query.length < 2) {
    return { ok: false, query, content: "The query contained only personal identifiers, so it was not sent. Search for the public topic instead." };
  }
  if (removed.length) console.info(`[search] scrubbed from query: ${removed.join(", ")}`);
  try {
    const hits = await exaSearch(
      {
        query,
        numResults: parsed.data.num_results,
        startPublishedDate: parsed.data.start_published_date,
        includeDomains: parsed.data.include_domains,
        category: parsed.data.category,
        fresh: parsed.data.fresh,
      },
      signal,
    );
    return { ok: true, query, hits };
  } catch (err) {
    return { ok: false, query, content: `Search failed: ${(err as Error).message}` };
  }
}

/**
 * Render hits for the model. Pages already shown earlier in this turn are referenced by number
 * instead of repeated, which saves tokens when parallel or follow-up searches overlap.
 */
export function renderHits(hits: SearchHit[], seen: Map<string, number>, note?: string): string {
  if (hits.length === 0) return "No results. Try a broader or differently worded query, or drop the date filter.";
  const parts = hits.map((h) => {
    const prev = seen.get(h.url);
    if (prev !== undefined) return `[${prev}] ${h.title}\nURL: ${h.url}\n(same page as result [${prev}] above)`;
    const n = seen.size + 1;
    seen.set(h.url, n);
    return `[${n}] ${h.title}\nURL: ${h.url}\nPublished: ${h.publishedDate ?? "unknown"}\n${h.text}`;
  });
  return (note ? note + "\n\n" : "") + parts.join("\n\n");
}
