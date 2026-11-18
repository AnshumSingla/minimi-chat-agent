import * as chrono from "chrono-node";
import { config } from "./config";
import {
  replyTo,
  saveEmbeddings,
  searchUserMessages,
  sourcesFor,
  userEmbeddings,
  userMessagesBetween,
  userMessagesMissingEmbeddings,
  type StoredMessage,
} from "./db";
import { cosine, embed } from "./embeddings";

/**
 * Recall runs in the harness, before the model: the agent's only tool is web search.
 *
 * 1. Resolve date references ("last Tuesday", "on 3 November", "on Monday") to local-day windows
 *    in the user's timezone. Date maths lives in code, not in the model.
 * 2. Pull past user turns from those windows, plus the assistant replies and the sources used then.
 * 3. If there's no date but the message points at the past ("I asked you", "we shortlisted"),
 *    match past turns by meaning (local MiniLM embeddings) and by keywords (SQLite FTS5).
 *    Embeddings run on this machine; if the model isn't available, keyword search alone is used.
 */

const DAY_MS = 86_400_000;

export interface RecallResult {
  /** Rendered <memory> block for the model, or null when the message doesn't refer to the past. */
  block: string | null;
  hits: number;
}

interface DayWindow {
  label: string; // e.g. "Tue 11 Nov 2026"
  fromIso: string;
  toIso: string;
  /** Bare weekday ("last Tuesday"): ambiguous between this week and the week before. */
  weekdayOnly: boolean;
}

const PAST_REFERENCE =
  /\b(i|we)\s+(asked|discussed|talked|mentioned|shortlisted|looked|compared|said|told)\b|\byou\s+(said|told|answered|recommended|suggested)\b|\b(last time|earlier|previously|before|since then|the other day|again)\b/i;

const STOPWORDS = new Set(
  (
    "the a an and or but if then than that this those these what which who whom whose when where why how " +
    "is are was were be been being do does did have has had i you we they he she it me us them my your our " +
    "their its of on in at to for from by with about into over after before since until any some all each " +
    "can could would should will shall may might must just still also really very more most much many " +
    "asked ask said tell told answer answers answered correct today yesterday tomorrow monday tuesday " +
    "wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december last next week month year changed change since anything something"
  ).split(" "),
);

/** Local midnight (as a UTC instant) of the day containing `instant`, for a tz offset in minutes east of UTC. */
function localDayStart(instant: Date, offsetMin: number): number {
  const shifted = instant.getTime() + offsetMin * 60_000;
  return Math.floor(shifted / DAY_MS) * DAY_MS - offsetMin * 60_000;
}

export function formatLocal(iso: string, offsetMin: number, withTime = true): string {
  const d = new Date(new Date(iso).getTime() + offsetMin * 60_000);
  const wd = d.toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toISOString().slice(11, 16);
  return withTime ? `${wd} ${date} ${time}` : `${wd} ${date}`;
}

/** Extract past local-day windows referenced in the text. Future or today-only references are ignored. */
export function resolveDayWindows(text: string, now: Date, offsetMin: number): DayWindow[] {
  const results = chrono.parse(text, { instant: now, timezone: offsetMin }, { forwardDate: false });
  const todayStart = localDayStart(now, offsetMin);
  const windows = new Map<number, DayWindow>();

  for (const r of results) {
    const c = r.start;
    if (!c.isCertain("day") && !c.isCertain("weekday")) continue; // "this morning", bare times etc.
    let d = c.date();
    // "on Monday" / "3 November" with no year can resolve forward; snap to the most recent past one.
    if (d.getTime() >= todayStart + DAY_MS) {
      d = c.isCertain("year") ? d : new Date(d.getTime() - (c.isCertain("month") ? 365 : 7) * DAY_MS);
    }
    const start = localDayStart(d, offsetMin);
    if (start >= todayStart) continue; // "today" means now, not a memory lookup
    const end = r.end ? localDayStart(r.end.date(), offsetMin) + DAY_MS : start + DAY_MS;
    windows.set(start, {
      label: formatLocal(new Date(start).toISOString(), offsetMin, false),
      fromIso: new Date(start).toISOString(),
      toIso: new Date(Math.min(end, todayStart)).toISOString(),
      weekdayOnly: !c.isCertain("month") && c.isCertain("weekday"),
    });
  }
  return [...windows.values()];
}

export function keywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+(st|nd|rd|th)?$/.test(w));
  return [...new Set(words)].slice(0, 8);
}

function ftsQuery(words: string[]): string {
  return words.map((w) => `"${w.replace(/"/g, "")}"`).join(" OR ");
}

function overlap(text: string, words: string[]): number {
  const t = text.toLowerCase();
  return words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n).trimEnd() + " …";
}

/**
 * Cosine similarity of the message to every stored user message (other conversations).
 * Also backfills vectors for messages stored before the model was ready. Null if the local model
 * isn't available within the timeout.
 */
async function semanticScores(
  message: string,
  conversationId: string,
): Promise<Map<string, { message: StoredMessage; score: number }> | null> {
  const missing = userMessagesMissingEmbeddings(64);
  const vecs = await embed([message, ...missing.map((m) => m.text)]);
  if (!vecs) return null;
  if (missing.length) saveEmbeddings(missing.map((m, i) => ({ messageId: m.id, vec: vecs[i + 1] })));
  const q = vecs[0];
  return new Map(
    userEmbeddings(conversationId).map(({ message: m, vec }) => [m.id, { message: m, score: cosine(q, vec) }]),
  );
}

export async function recall(
  message: string,
  conversationId: string,
  offsetMin: number,
  now = new Date(),
): Promise<RecallResult> {
  const windows = resolveDayWindows(message, now, offsetMin);
  const words = keywords(message);
  const refersToPast = windows.length > 0 || PAST_REFERENCE.test(message);
  if (!refersToPast) return { block: null, hits: 0 };

  const semantic = await semanticScores(message, conversationId);
  const relevance = (m: StoredMessage) => semantic?.get(m.id)?.score ?? overlap(m.text, words) / 10;

  let candidates: StoredMessage[] = [];
  const lines: string[] = [];

  if (windows.length > 0) {
    for (const w of windows) {
      let found = userMessagesBetween(w.fromIso, w.toIso, conversationId);
      lines.push(`Date reference resolved: ${w.label} → ${found.length} stored message(s) that day.`);
      if (found.length === 0 && w.weekdayOnly) {
        const from = new Date(new Date(w.fromIso).getTime() - 7 * DAY_MS).toISOString();
        const to = new Date(new Date(w.toIso).getTime() - 7 * DAY_MS).toISOString();
        found = userMessagesBetween(from, to, conversationId);
        lines.push(`Also checked the week before, ${formatLocal(from, offsetMin, false)} → ${found.length} stored message(s).`);
      }
      candidates.push(...found);
    }
    // Several turns that day: prefer the ones about the same topic, keep chronological order.
    if (candidates.length > config.memory.maxRecalledTurns) {
      const ranked = [...candidates].sort((a, b) => relevance(b) - relevance(a));
      const keep = new Set(ranked.slice(0, config.memory.maxRecalledTurns).map((m) => m.id));
      candidates = candidates.filter((m) => keep.has(m.id));
    }
  } else {
    // Hybrid: semantic hits above the threshold, plus keyword hits; boost what both agree on.
    const scored = new Map<string, { message: StoredMessage; score: number }>();
    if (semantic) {
      for (const hit of semantic.values()) {
        if (hit.score >= config.memory.semanticThreshold) scored.set(hit.message.id, { ...hit });
      }
    }
    for (const m of searchUserMessages(ftsQuery(words), conversationId, config.memory.maxRecalledTurns)) {
      const base = scored.get(m.id)?.score ?? semantic?.get(m.id)?.score ?? 0.3;
      scored.set(m.id, { message: m, score: base + 0.15 });
    }
    candidates = [...scored.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, config.memory.maxRecalledTurns)
      .map((h) => h.message)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    lines.push(
      `No explicit date; matched past conversations ${semantic ? "by meaning (on-device model) and " : ""}by keywords: ${words.join(", ") || "(none)"}.`,
    );
  }

  candidates = candidates.slice(0, config.memory.maxRecalledTurns);
  const replies = candidates.map((u) => replyTo(u));
  const sources = sourcesFor(replies.filter((r): r is StoredMessage => !!r).map((r) => r.id));

  candidates.forEach((u, i) => {
    const r = replies[i];
    lines.push("");
    lines.push(`[${i + 1}] ${formatLocal(u.createdAt, offsetMin)} (user's local time)`);
    lines.push(`User asked: ${clip(u.text, 600)}`);
    if (r) {
      lines.push(`You answered (${formatLocal(r.createdAt, offsetMin)}): ${clip(r.text, config.memory.maxCharsPerTurn)}`);
      const src = sources.get(r.id) ?? [];
      if (src.length) {
        lines.push("Sources you used then:");
        for (const s of src.slice(0, 8)) {
          lines.push(`  - ${s.title} <${s.url}> published ${s.publishedDate ?? "unknown"}, retrieved ${s.retrievedAt.slice(0, 10)}`);
        }
      }
    } else {
      lines.push("(No stored answer for this message.)");
    }
  });

  if (candidates.length === 0) {
    lines.push("", "No matching past conversation is stored. Say so plainly; do not invent one.");
  }

  return { block: `<memory>\n${lines.join("\n")}\n</memory>`, hits: candidates.length };
}
