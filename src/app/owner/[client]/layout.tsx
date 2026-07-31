import { OwnerSidebar } from "@/components/owner/owner-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { FeedbackWidget } from "@/components/platform/feedback-widget";
import { guardPage } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
import { getViewSiteSelection } from "@/lib/site-view";
import { getDisabledSlugs } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

export default async function OwnerLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  const clientRecord = getClient(client);
  // Independent loads run CONCURRENTLY (see c/[client]/layout.tsx): guard, the
  // owner sidebar's switched-off systems (System controls itself is never a
  // controllable system, so it stays visible to switch them back on), and the
  // site-switcher cookie. A guard redirect still wins via Promise.all rejection.
  const [, disabled, selectedSite] = await Promise.all([
    guardPage({ roles: ["agency_admin", "client_owner"], clientSlug: client }),
    clientRecord ? getDisabledSlugs(clientRecord.id) : Promise.resolve(new Set<string>()),
    clientRecord ? getViewSiteSelection(clientRecord.id) : Promise.resolve(undefined),
  ]);
  const disabledSlugs = [...disabled];
  return (
    // The approved frame (see c/[client]/layout.tsx for the full rationale):
    // light blue wash, transparent sidebar, one white content panel with an
    // internal scroll; full-bleed white below lg.
    <div className="app-frame min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden">
      <div className="flex min-h-screen lg:h-full lg:min-h-0">
        <OwnerSidebar disabledSlugs={disabledSlugs} />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-card lg:my-3 lg:mr-3 lg:h-auto lg:min-h-0 lg:overflow-hidden lg:rounded-[18px]">
          <ClientTopbar selected={selectedSite} />
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            {/* The two :has() variants are gated on a marker only the diary sets
                (data-diary), so every other /owner page is byte-identical. They
                match c/[client]/layout.tsx exactly: the owner route renders the
                SAME CalendarView, and without them the diary's lg:h-full resolves
                against an auto-height parent, so it loses its own vertical
                scroller and its sticky clinician headers, and stays inside the
                1400px cap this screen has to escape. */}
            <main className="lg:has-[[data-diary]]:h-full">
              <div className="mx-auto max-w-[1400px] space-y-6 px-4 py-5 has-[[data-diary]]:max-w-none has-[[data-diary]]:space-y-0 sm:px-6 lg:px-8 lg:py-7 lg:has-[[data-diary]]:h-full">
                {children}
              </div>
            </main>
          </div>
        </div>
      </div>
      <PlatformShortcuts />
      <FeedbackWidget />
    </div>
  );
}
