import { deleteAll, listConversations } from "@/lib/db";
import { guard } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  return Response.json(listConversations());
}

/** Wipe all local data. */
export function DELETE(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  deleteAll();
  return new Response(null, { status: 204 });
}
