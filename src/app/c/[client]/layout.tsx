import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { guardPage } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
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
  await guardPage({
    roles: ["agency_admin", "client_owner", "client_coordinator"],
    clientSlug: client,
  });
  // Systems the owner switched off are hidden from the sidebar. Resolved here
  // (server-side) so every role gets the filtered nav without calling the
  // owner-only systems API. Fail-open: getDisabledSlugs never throws.
  const clientRecord = getClient(client);
  const disabledSlugs = clientRecord ? [...(await getDisabledSlugs(clientRecord.id))] : [];
  return (
    <div className="flex min-h-screen bg-cream">
      <ClientSidebar disabledSlugs={disabledSlugs} />
      <div className="flex min-h-screen flex-1 flex-col">
        <ClientTopbar />
        <main className="flex-1">
          <div className="mx-auto max-w-[1400px] space-y-6 px-8 py-7">{children}</div>
        </main>
      </div>
      <PlatformShortcuts />
    </div>
  );
}
