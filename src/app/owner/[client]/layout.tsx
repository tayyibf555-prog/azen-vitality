import { OwnerSidebar } from "@/components/owner/owner-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
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
  await guardPage({ roles: ["agency_admin", "client_owner"], clientSlug: client });
  // Switched-off systems drop out of the owner sidebar too (System controls is
  // never a controllable system, so it stays visible to switch them back on).
  const clientRecord = getClient(client);
  const disabledSlugs = clientRecord ? [...(await getDisabledSlugs(clientRecord.id))] : [];
  // The switcher opens on the current selection (default N15) so its label matches
  // the site the owner pages are actually showing.
  const selectedSite = clientRecord ? await getViewSiteSelection(clientRecord.id) : undefined;
  return (
    <div className="flex min-h-screen bg-cream">
      <OwnerSidebar disabledSlugs={disabledSlugs} />
      <div className="flex min-h-screen flex-1 flex-col">
        <ClientTopbar selected={selectedSite} />
        <main className="flex-1">
          <div className="mx-auto max-w-[1400px] space-y-6 px-8 py-7">{children}</div>
        </main>
      </div>
      <PlatformShortcuts />
    </div>
  );
}
