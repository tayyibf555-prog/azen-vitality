import { NextResponse } from "next/server";
import { requireClientAccess, requireModuleApiAccess, requireUser } from "@/lib/auth/guard";
import { getClient } from "@/lib/mock/clients";
import { buildNotifications } from "@/lib/notifications/build";
import { getViewSiteIds } from "@/lib/site-view";

export const dynamic = "force-dynamic";

/** How many the bell shows. Enough to be worth opening, few enough to read at a
 *  glance; the rest are one click away on the page. */
const PREVIEW_LIMIT = 6;

/**
 * The notification bell's preview.
 *
 * Same builder the Notifications PAGE uses, so the bell can never disagree with
 * the page it links to. The feed is derived on read (there is no event store),
 * which is why this is a route rather than a cached table: whatever is true when
 * you open the bell is what it shows.
 *
 * Returns the total as well as the slice, so the bell can say "6 of 23" and put
 * a count on the icon without a second call.
 */
export async function GET(request: Request) {
  // requireUser returns a Response to REJECT, or null when sign-in is not
  // configured at all (local/pilot). Same idiom as every other route here.
  const user = await requireUser();
  if (user instanceof Response) return user;

  const { searchParams } = new URL(request.url);
  const clientSlug = searchParams.get("client") ?? "";
  const client = getClient(clientSlug);
  if (!client) return NextResponse.json({ ok: false, error: "unknown client" }, { status: 404 });

  const denied = requireClientAccess(user, client.id);
  if (denied) return denied;
  // The bell aggregates compliance, no-show risk, onboarding submissions and new
  // enquiries — four modules a clinician may not have. Outside CLINICIAN_SLUGS.
  const moduleDenied = requireModuleApiAccess(user, "notifications");
  if (moduleDenied) return moduleDenied;

  const siteIds = await getViewSiteIds(client.id);

  // Never throws by contract, but a failure here must not take the top bar down
  // with it: an empty bell is recoverable, a crashed shell is not.
  let items;
  try {
    items = await buildNotifications({ clientId: client.id, clientSlug, siteIds });
  } catch {
    return NextResponse.json({ ok: false, error: "could not be read" }, { status: 200 });
  }

  return NextResponse.json({
    ok: true,
    total: items.length,
    high: items.filter((i) => i.urgency === "high").length,
    items: items.slice(0, PREVIEW_LIMIT).map((i) => ({
      id: i.id,
      type: i.type,
      urgency: i.urgency,
      title: i.title,
      detail: i.detail,
      at: i.at,
      href: i.href ?? null,
    })),
  });
}
