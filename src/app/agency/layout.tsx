import { AgencySidebar } from "@/components/agency/agency-sidebar";
import { guardPage } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  await guardPage({ roles: ["agency_admin"] });
  return (
    // Same floating shell as the client/owner areas (see c/[client]/layout.tsx).
    // The agency sidebar has no mobile off-canvas, so it sits in-flow at every
    // width; the main column owns the internal scroll at lg.
    <div className="app-shell-backdrop min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden lg:p-4 xl:p-5">
      <div className="flex min-h-screen bg-cream lg:h-full lg:min-h-0 lg:overflow-hidden lg:rounded-shell lg:shadow-shell">
        <AgencySidebar />
        <div className="flex min-h-screen flex-1 flex-col lg:h-full lg:min-h-0 lg:overflow-y-auto">
          <main className="mx-auto w-full max-w-[1400px] px-6 py-7 lg:px-8">{children}</main>
        </div>
      </div>
    </div>
  );
}
