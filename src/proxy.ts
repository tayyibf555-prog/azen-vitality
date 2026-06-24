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
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return response;

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

  const path = request.nextUrl.pathname;
  const isProtected =
    path.startsWith("/agency") || path.startsWith("/owner") || path.startsWith("/c/");
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
