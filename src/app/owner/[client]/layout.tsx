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
    // Floating app shell (see c/[client]/layout.tsx for the full rationale): the
    // app floats as one rounded card on a navy backdrop from lg up; below lg it
    // stays full-bleed so the off-canvas fixed sidebar is untouched.
    <div className="app-shell-backdrop min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden lg:p-4 xl:p-5">
      <div className="flex min-h-screen bg-cream lg:h-full lg:min-h-0 lg:overflow-hidden lg:rounded-shell lg:shadow-shell">
        <OwnerSidebar disabledSlugs={disabledSlugs} />
        <div className="flex min-h-screen flex-1 flex-col lg:h-full lg:min-h-0 lg:overflow-y-auto">
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
