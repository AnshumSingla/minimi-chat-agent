import { conversationExists, deleteConversation, uiMessages } from "@/lib/db";
import { guard } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  if (!conversationExists(id)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(uiMessages(id));
}

export async function DELETE(req: Request, { params }: Ctx) {
  const denied = guard(req);
  if (denied) return denied;
  const { id } = await params;
  deleteConversation(id);
  return new Response(null, { status: 204 });
}
