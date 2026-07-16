import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { FeedbackWidget } from "@/components/platform/feedback-widget";
import { guardPage } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
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
  const [, disabled, selectedSite] = await Promise.all([
    guardPage({
      roles: ["agency_admin", "client_owner", "client_coordinator"],
      clientSlug: client,
    }),
    clientRecord ? getDisabledSlugs(clientRecord.id) : Promise.resolve(new Set<string>()),
    clientRecord ? getViewSiteSelection(clientRecord.id) : Promise.resolve(undefined),
  ]);
  const disabledSlugs = [...disabled];
  return (
    // Floating app shell: the whole app floats as one rounded card on a deep-navy
    // backdrop from lg up (the .app-shell-backdrop media query paints the navy +
    // glows only there). Below lg it stays full-bleed so the off-canvas fixed
    // sidebar behaves exactly as before. The main column owns the internal scroll
    // at lg (lg:overflow-y-auto); the sticky topbar pins to it. The fixed floating
    // widgets (co-pilot, feedback) are position:fixed and escape the shell clip.
    <div className="app-shell-backdrop min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden lg:p-4 xl:p-5">
      <div className="flex min-h-screen bg-cream lg:h-full lg:min-h-0 lg:overflow-hidden lg:rounded-shell lg:shadow-shell">
        <ClientSidebar disabledSlugs={disabledSlugs} />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:h-full lg:min-h-0 lg:overflow-y-auto">
          <ClientTopbar selected={selectedSite} />
          <main className="flex-1">
            <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 sm:px-6 lg:px-8 lg:py-7">{children}</div>
          </main>
        </div>
      </div>
      <PlatformShortcuts />
      <FeedbackWidget />
    </div>
  );
}
