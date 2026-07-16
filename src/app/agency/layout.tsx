import { AgencySidebar } from "@/components/agency/agency-sidebar";
import { guardPage } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  await guardPage({ roles: ["agency_admin"] });
  return (
    // The approved frame (see c/[client]/layout.tsx): light blue wash, the
    // sidebar transparent on it, one white content panel with internal scroll.
    // The agency sidebar has no mobile off-canvas, so it sits in-flow at every
    // width (navy below lg, transparent on the frame from lg).
    <div className="app-frame min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden">
      <div className="flex min-h-screen lg:h-full lg:min-h-0">
        <AgencySidebar />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-card lg:my-3 lg:mr-3 lg:h-auto lg:min-h-0 lg:overflow-hidden lg:rounded-[18px]">
          <div className="min-h-0 flex-1 lg:overflow-y-auto">
            <main className="mx-auto w-full max-w-[1400px] px-6 py-7 lg:px-8">{children}</main>
          </div>
        </div>
      </div>
    </div>
  );
}
