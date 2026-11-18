/**
 * The API serves private, local data and has no login, so it must only answer the local user.
 * - Host must be a loopback name: blocks DNS-rebinding attacks from other websites.
 * - Origin, when present, must match Host: blocks cross-site requests from other tabs.
 * - Bodies must be application/json: rules out "simple" cross-site POSTs that skip CORS preflight.
 * The dev/start scripts also bind to 127.0.0.1, so the LAN can't reach the server at all.
 */

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export function guard(req: Request, opts: { json?: boolean } = {}): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.test(host)) {
    return Response.json({ error: "Forbidden: local access only" }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost.toLowerCase() !== host.toLowerCase()) {
      return Response.json({ error: "Forbidden: cross-origin request" }, { status: 403 });
    }
  }
  if (opts.json && !(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  return null;
}
