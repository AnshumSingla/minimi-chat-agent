import { conversationExists, deleteConversation, uiMessages } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  if (!conversationExists(id)) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(uiMessages(id));
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  deleteConversation(id);
  return new Response(null, { status: 204 });
}
