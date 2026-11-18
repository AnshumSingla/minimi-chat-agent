/**
 * Deterministic last line of defence before a query leaves the machine. The system prompt already
 * tells the model to search only public topics; this removes identifiers that slip through anyway.
 * It is deliberately conservative: it removes things that are never useful in a web search
 * (emails, phone numbers, card/ID-like digit runs, IPs, URL query strings) and leaves the topic alone.
 */

const RULES: { name: string; re: RegExp; replace: string }[] = [
  { name: "email", re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, replace: "" },
  // URL query strings and fragments often carry tokens / tracking ids; keep the host + path.
  { name: "url-query", re: /(https?:\/\/[^\s?#]+)[?#]\S*/gi, replace: "$1" },
  { name: "ip", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace: "" },
  // 13–19 digit runs (cards), allowing spaces/dashes between groups.
  { name: "card", re: /\b(?:\d[ -]?){13,19}\b/g, replace: "" },
  // Phone numbers: optional +country, 9+ digits with separators. Years like 2026 are untouched.
  { name: "phone", re: /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){2,}\d{3,4}\b/g, replace: "" },
  // Long opaque tokens (API keys, ids): 24+ chars of mixed letters and digits.
  { name: "token", re: /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, replace: "" },
];

export function scrubQuery(query: string): { query: string; removed: string[] } {
  let q = query;
  const removed: string[] = [];
  for (const r of RULES) {
    const next = q.replace(r.re, (m, ...groups) => {
      // Phone rule: ignore matches with fewer than 9 digits (e.g. "2026 11 19" date fragments are fine).
      if (r.name === "phone" && m.replace(/\D/g, "").length < 9) return m;
      removed.push(r.name);
      return r.replace === "$1" ? String(groups[0]) : r.replace;
    });
    q = next;
  }
  return { query: q.replace(/\s{2,}/g, " ").trim(), removed: [...new Set(removed)] };
}
