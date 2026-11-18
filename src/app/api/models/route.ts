import { MODELS, resolveModel } from "@/lib/config";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({
    models: MODELS.map(({ id, label, hint }) => ({ id, label, hint })),
    default: resolveModel(null).id,
  });
}
