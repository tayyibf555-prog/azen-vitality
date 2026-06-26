import { AgencySidebar } from "@/components/agency/agency-sidebar";
import { guardPage } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  await guardPage({ roles: ["agency_admin"] });
  return (
    <div className="min-h-full bg-cream">
      <AgencySidebar />
      <div className="pl-[248px]">
        <main className="mx-auto max-w-[1400px] px-8 py-7">{children}</main>
      </div>
    </div>
  );
}
