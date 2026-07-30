import { cookies } from "next/headers";
import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { FeedbackWidget } from "@/components/platform/feedback-widget";
import { UsageBeacon } from "@/components/platform/usage-beacon";
import { guardPage } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
import {
  SIDEBAR_COLLAPSED_COOKIE,
  SIDEBAR_GROUPS_COOKIE,
  parseCollapsed,
  parseOpenGroups,
} from "@/lib/sidebar-prefs";
import { getViewSiteSelection } from "@/lib/site-view";
import { getDisabledSlugs } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  const clientRecord = getClient(client);
  // The three loads are independent, so they run CONCURRENTLY: the guard (auth,
  // 2 sequential Supabase hops), the sidebar's switched-off systems (1 hop,
  // fail-open display read - never throws), and the site-switcher cookie (free).
  // Serialising them added a needless hop to every entry into the client area;
  // a guard redirect still wins because Promise.all rejects with it.
  const [, disabled, selectedSite, cookieStore] = await Promise.all([
    guardPage({
      roles: ["agency_admin", "client_owner", "client_coordinator"],
      clientSlug: client,
    }),
    clientRecord ? getDisabledSlugs(clientRecord.id) : Promise.resolve(new Set<string>()),
    clientRecord ? getViewSiteSelection(clientRecord.id) : Promise.resolve(undefined),
    cookies(),
  ]);
  const disabledSlugs = [...disabled];
  // The sidebar's remembered layout is read HERE rather than from localStorage in
  // the component, so the very first paint is already the right width and the
  // right areas are open. Nothing flashes and nothing has to correct itself.
  const navCollapsed = parseCollapsed(cookieStore.get(SIDEBAR_COLLAPSED_COOKIE)?.value);
  const navOpenGroups = parseOpenGroups(cookieStore.get(SIDEBAR_GROUPS_COOKIE)?.value);
  return (
    // The approved frame (aesthetic-mock2, A - Light): a light brand-blue wash,
    // the sidebar transparent directly on it, and ALL page content inside ONE
    // white panel (18px radius, 12px gutter top/right/bottom) with its own
    // internal scroll. Below lg there is no frame: full-bleed white, and the
    // off-canvas fixed sidebar keeps its navy chrome untouched. The topbar sits
    // INSIDE the panel above the scroller (sticky still covers the mobile body
    // scroll). Fixed widgets (co-pilot, feedback) escape the panel clip.
    <div className="app-frame min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden">
      <div className="flex min-h-screen lg:h-full lg:min-h-0">
        <ClientSidebar
          disabledSlugs={disabledSlugs}
          initialCollapsed={navCollapsed}
          initialOpenGroups={navOpenGroups}
        />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-card lg:my-3 lg:mr-3 lg:h-auto lg:min-h-0 lg:overflow-hidden lg:rounded-[18px]">
          <ClientTopbar selected={selectedSite} />
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            <main>
              <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
            </main>
          </div>
        </div>
      </div>
      <PlatformShortcuts />
      <FeedbackWidget />
      <UsageBeacon />
    </div>
  );
}
