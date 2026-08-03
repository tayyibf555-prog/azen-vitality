import { cookies } from "next/headers";
import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { ClientSectionBar } from "@/components/client/section-tabs";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { PatientQuickViewProvider } from "@/components/platform/patient-quick-view-provider";
import { FeedbackWidget } from "@/components/platform/feedback-widget";
import { guardPage } from "@/lib/auth/page-guard";
import { getClient } from "@/lib/mock/clients";
import {
  SIDEBAR_GROUPS_COOKIE,
  parseOpenGroups,
} from "@/lib/sidebar-prefs";
import { getViewSiteSelection } from "@/lib/site-view";
import { getDisabledSlugs } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE OWNER SHELL IS THE STAFF SHELL. Same components, same order, same classes.
//
// It was not, and that was a shipped defect the practice owner spotted in front
// of us: /c had been rebuilt around the permanent rail and the Dentally-style
// section bar (b68e78a, 8899fd6, 261fdbb) while /owner still rendered a sidebar
// of its own from a generation earlier and no section bar at all. Signing in as
// the owner showed a visibly older product than signing in as the manager.
//
// The two things that ARE the owner's stay: the guard admits only owner/agency
// roles, and the one owner-only module (the Practice brain) is added to the nav
// by @/lib/nav-shell, keyed off the pathname, rather than by a second component.
//
// UsageBeacon is the ONE deliberate difference from c/[client]/layout.tsx, and
// it is deliberate at the other end: surfaceFromPath instruments the /c shell
// only, so mounting it here would be a component that provably does nothing.
// app-shell-parity.test.ts pins that list of differences at exactly one, so
// anything else added to either shell and not the other fails the suite.
// ---------------------------------------------------------------------------

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
  // sidebar's switched-off systems (System controls itself is never a
  // controllable system, so it stays visible to switch them back on), the
  // site-switcher cookie, and the sidebar's remembered open areas. A guard
  // redirect still wins via Promise.all rejection.
  const [, disabled, selectedSite, cookieStore] = await Promise.all([
    guardPage({ roles: ["agency_admin", "client_owner"], clientSlug: client }),
    clientRecord ? getDisabledSlugs(clientRecord.id) : Promise.resolve(new Set<string>()),
    clientRecord ? getViewSiteSelection(clientRecord.id) : Promise.resolve(undefined),
    cookies(),
  ]);
  const disabledSlugs = [...disabled];
  // Read HERE rather than from localStorage in the component, so the very first
  // paint is already the right shape. Same cookie as /c, so switching between the
  // two trees does not reshuffle the nav under the reader.
  const navOpenGroups = parseOpenGroups(cookieStore.get(SIDEBAR_GROUPS_COOKIE)?.value);
  return (
    // Wraps the WHOLE shell so the Cmd-K command palette is inside the context. See
    // the matching comment in c/[client]/layout.tsx.
    <PatientQuickViewProvider>
      {/* The approved frame (see c/[client]/layout.tsx for the full rationale):
          full bleed, no gutter, no rounding; the working area runs edge to edge
          against the sidebar. */}
      <div className="app-frame min-h-screen lg:h-screen lg:min-h-0 lg:overflow-hidden">
        <div className="flex min-h-screen lg:h-full lg:min-h-0">
          <ClientSidebar
            disabledSlugs={disabledSlugs}
            initialOpenGroups={navOpenGroups}
          />
          <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-card lg:h-auto lg:min-h-0 lg:overflow-hidden">
            <ClientTopbar selected={selectedSite} />
            {/* The second level of the navigation: the modules inside whichever
                area the rail has selected. Renders nothing for an area with only
                one module, and nothing below lg, where the drawer carries both
                levels itself. */}
            <div className="hidden lg:block">
              <ClientSectionBar disabledSlugs={disabledSlugs} />
            </div>
            <div className="min-h-0 flex-1 [scrollbar-gutter:stable] lg:overflow-y-auto">
              {/* The two :has() variants are gated on a marker only the diary sets
                  (data-diary), so every other /owner page is byte-identical. They
                  match c/[client]/layout.tsx exactly: the owner route renders the
                  SAME CalendarView, and without them the diary's lg:h-full resolves
                  against an auto-height parent, so it loses its own vertical
                  scroller and its sticky clinician headers, and stays inside the
                  1400px cap this screen has to escape.

                  data-wide is the same width-only escape for the tooth chart, and
                  BOTH trees must carry it or the owner view boxes a chart that /c
                  does not. The owner route renders the SAME RecordTabContent, and
                  a module wired into one tree and not the other is a class of
                  failure this project has already shipped once. */}
              <main className="lg:has-[[data-diary]]:h-full">
                <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-3 has-[[data-diary]]:max-w-none has-[[data-diary]]:space-y-0 has-[[data-wide]]:max-w-none sm:px-5 lg:px-6 lg:py-4 lg:has-[[data-diary]]:h-full">
                  {children}
                </div>
              </main>
            </div>
          </div>
        </div>
        <PlatformShortcuts />
        <FeedbackWidget />
      </div>
    </PatientQuickViewProvider>
  );
}
