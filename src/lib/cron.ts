/**
 * Authorization for cron / internal-job endpoints (sweeps, drain, syncs).
 *
 * Fail-CLOSED in production: if CRON_SECRET is not configured, reject, so a
 * misconfigured deploy is never wide open. In development (NODE_ENV !==
 * 'production') an unset secret is allowed for local convenience.
 *
 * Vercel Cron automatically sends `Authorization: Bearer ${CRON_SECRET}` when
 * CRON_SECRET is set on the project, so the same check covers cron + manual.
 *
 * Returns a Response to short-circuit with when unauthorized, or null when OK.
 */
export function cronUnauthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return Response.json({ error: "CRON_SECRET not configured" }, { status: 503 });
    }
    return null; // dev convenience only
  }
  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
