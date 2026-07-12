import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next 16 "proxy" (formerly middleware). Refreshes the Supabase session cookie
 * and does an OPTIMISTIC redirect to /login for the dashboard areas when there
 * is no session. The authoritative authz check lives in the pages + route
 * handlers (getSessionUser / requireUser), per Next's guidance that proxy must
 * not be the sole auth gate.
 *
 * Gated on the service-role key so it is a no-op until the gate is activated.
 */
/**
 * Seconds of remaining token life below which the proxy runs the full network
 * refresh. Above it, the request passes through with zero network cost.
 */
const REFRESH_WINDOW_SECONDS = 120;

/**
 * Parse the Supabase auth cookie(s) locally and return the session's expiry
 * (epoch seconds), or null when absent/unreadable. @supabase/ssr stores the
 * session as `sb-<ref>-auth-token` (chunked `.0`, `.1`, ... when large), the
 * value either `base64-<base64url json>` or URI-encoded JSON. This does NOT
 * verify the token — it only decides whether the optimistic proxy needs the
 * network at all; the authoritative check stays in getSessionUser/requireUser.
 */
function localSessionExpiry(request: NextRequest): number | null {
  try {
    const parts = request.cookies
      .getAll()
      .filter((c) => /^sb-.+-auth-token(\.\d+)?$/.test(c.name))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    if (parts.length === 0) return null;
    let raw = parts.map((c) => c.value).join("");
    if (raw.startsWith("base64-")) {
      const b64 = raw.slice("base64-".length).replace(/-/g, "+").replace(/_/g, "/");
      raw = atob(b64);
    } else {
      raw = decodeURIComponent(raw);
    }
    const session = JSON.parse(raw) as { expires_at?: number };
    return typeof session.expires_at === "number" ? session.expires_at : null;
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return response;

  const path = request.nextUrl.pathname;
  const isProtected =
    path.startsWith("/agency") || path.startsWith("/owner") || path.startsWith("/c/");

  // FAST PATH: this proxy is only an OPTIMISTIC gate (see header comment), yet the
  // full auth.getUser() below costs a network round trip on EVERY navigation. When
  // the auth cookie is locally readable and its token is not close to expiring,
  // skip the network entirely: no cookie -> optimistic /login redirect; fresh
  // cookie -> pass through (a forged/expired token is still rejected by the
  // authoritative page/route guards). Only a near-expiry or unreadable cookie
  // falls through to the full client, which also REFRESHES the session cookie —
  // the one job that genuinely needs the network here.
  const expiresAt = localSessionExpiry(request);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (expiresAt === null && isProtected && request.cookies.getAll().every((c) => !/^sb-.+-auth-token/.test(c.name))) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  if (expiresAt !== null && expiresAt - nowSeconds > REFRESH_WINDOW_SECONDS) {
    return response;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on everything except static assets, the API (self-guarded), and /login.
    "/((?!_next/static|_next/image|favicon.ico|api|login|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
