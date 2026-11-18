import { deleteAll, listConversations } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(listConversations());
}

/** Wipe all local data. */
export function DELETE() {
  deleteAll();
  return new Response(null, { status: 204 });
}
