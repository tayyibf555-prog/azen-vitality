import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { guardPage } from "@/lib/auth/page-guard";

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
  return (
    <div className="flex min-h-screen bg-cream">
      <ClientSidebar />
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
