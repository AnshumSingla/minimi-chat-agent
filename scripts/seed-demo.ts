/**
 * Seeds a few dated past conversations so recall can be tried immediately:
 *   npm run seed:demo
 * Titles are prefixed with [demo]. Delete them from the UI or with "Delete all local data".
 * Seeded answers are intentionally light on numbers: the agent should re-verify them via search.
 */
import { addMessage, addSources, createConversation } from "../src/lib/db";

const DAY = 86_400_000;

function lastWeekday(target: number, hour: number): Date {
  // Most recent past `target` weekday (0=Sun), strictly before today.
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  let back = (d.getDay() - target + 7) % 7;
  if (back === 0) back = 7;
  return new Date(d.getTime() - back * DAY);
}

function nov3(): Date {
  const now = new Date();
  const d = new Date(now.getFullYear(), 10, 3, 11, 30);
  return d < now ? d : new Date(now.getFullYear() - 1, 10, 3, 11, 30);
}

function seed(title: string, at: Date, user: string, assistant: string, sources: { url: string; title: string }[]) {
  const t0 = at.toISOString();
  const t1 = new Date(at.getTime() + 20_000).toISOString();
  const conv = createConversation(`[demo] ${title}`, t0);
  addMessage(conv, "user", user, undefined, t0);
  const mid = addMessage(conv, "assistant", assistant, undefined, t1);
  addSources(
    mid,
    sources.map((s) => ({ ...s, publishedDate: null, retrievedAt: t1, query: title })),
  );
  console.log(`seeded "${title}" at ${at.toString()}`);
}

seed(
  "CRM shortlist",
  lastWeekday(1, 10),
  "We're a 20-person sales team picking a CRM. Shortlist 5 for us with pricing.",
  "Shortlist for a 20-seat sales team: 1) HubSpot Sales Hub (Professional tier), 2) Pipedrive (Advanced/Professional), " +
    "3) Salesforce Sales Cloud (Pro Suite), 4) Attio (Pro), 5) Close (Growth). All price per seat per month with annual " +
    "discounts; HubSpot and Salesforce are the priciest at this size, Pipedrive and Close the most affordable.",
  [
    { url: "https://www.hubspot.com/pricing/sales", title: "HubSpot Sales Hub pricing" },
    { url: "https://www.pipedrive.com/en/pricing", title: "Pipedrive pricing" },
    { url: "https://www.salesforce.com/sales/pricing/", title: "Salesforce Sales Cloud pricing" },
    { url: "https://attio.com/pricing", title: "Attio pricing" },
    { url: "https://www.close.com/pricing", title: "Close pricing" },
  ],
);

seed(
  "Postgres hosting",
  lastWeekday(2, 15),
  "What's the best managed Postgres hosting for a small startup, and what does it cost?",
  "For a small startup: Neon (serverless, generous free tier, usage-based), Supabase (Postgres plus auth/storage, " +
    "Pro plan per project), AWS RDS (most control, pay per instance hour) and Render (simple flat instance pricing). " +
    "Start with Neon or Supabase; move to RDS when you need fine-grained tuning.",
  [
    { url: "https://neon.com/pricing", title: "Neon pricing" },
    { url: "https://supabase.com/pricing", title: "Supabase pricing" },
    { url: "https://aws.amazon.com/rds/postgresql/pricing/", title: "Amazon RDS for PostgreSQL pricing" },
    { url: "https://render.com/pricing", title: "Render pricing" },
  ],
);

seed(
  "Latest Node LTS",
  nov3(),
  "Which Node.js version is the current LTS?",
  "The current Active LTS line is listed on the Node.js releases page; even-numbered majors become LTS in October.",
  [{ url: "https://nodejs.org/en/about/previous-releases", title: "Node.js releases" }],
);
