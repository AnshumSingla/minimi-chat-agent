import { MODELS, resolveModel } from "@/lib/config";
import { guard } from "@/lib/guard";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const denied = guard(req);
  if (denied) return denied;
  return Response.json({
    models: MODELS.map(({ id, label, hint }) => ({ id, label, hint })),
    default: resolveModel(null).id,
  });
}
