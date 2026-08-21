import { cookies } from "next/headers";
import { ClientSidebar } from "@/components/client/client-sidebar";
import { ClientTopbar } from "@/components/client/client-topbar";
import { ClientSectionBar } from "@/components/client/section-tabs";
import { PlatformShortcuts } from "@/components/platform/platform-shortcuts";
import { PatientQuickViewProvider } from "@/components/platform/patient-quick-view-provider";
import { FeedbackWidget } from "@/components/platform/feedback-widget";
import { UsageBeacon } from "@/components/platform/usage-beacon";
import { guardPage } from "@/lib/auth/page-guard";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { copilotAccessForRole } from "@/lib/copilot/scope";
import { getClient } from "@/lib/mock/clients";
import {
  SIDEBAR_GROUPS_COOKIE,
  parseOpenGroups,
} from "@/lib/sidebar-prefs";
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
  const [, disabled, selectedSite, cookieStore, sessionUser] = await Promise.all([
    guardPage({
      // client_clinician AND client_staff belong here or those roles cannot log in
      // AT ALL: "/" routes agency to /agency, owner to /owner, and EVERYTHING ELSE
      // to /c/[client]. A role missing from this array is bounced by the guard back
      // to "/", which sends it straight back here — an infinite redirect.
      //
      // THIS GUARD DENIES NOTHING PER MODULE, AND MUST NOT BE READ AS IF IT DID.
      // It answers one question — may this signed-in user enter this client's shell
      // at all — and then every role in the array reaches every page underneath it.
      // The two deny-by-default allow-lists (CLINICIAN_SLUGS, STAFF_SLUGS) are
      // enforced ONLY by `requireModuleAccess("<slug>")` inside each module page,
      // which is a different call in a different file; the sidebar's filtering
      // merely hides links and stops nobody typing a URL. A module page that
      // forgets that call is open to every role that gets past this line, which is
      // exactly what had happened to 24 of the 39 pages here.
      // `client-module-guard-coverage.test.ts` now fails the suite if any module
      // page under this route drops it.
      roles: [
        "agency_admin",
        "client_owner",
        "client_coordinator",
        "client_clinician",
        "client_staff",
      ],
      clientSlug: client,
    }),
    clientRecord ? getDisabledSlugs(clientRecord.id) : Promise.resolve(new Set<string>()),
    clientRecord ? getViewSiteSelection(clientRecord.id) : Promise.resolve(undefined),
    cookies(),
    // WHICH CO-PILOT THE Cmd-J PANEL OFFERS. `getSessionUser` is React-cached and
    // `guardPage` above resolves the same session, so this joins the existing hop
    // rather than adding one; where sign-in is not configured guardPage does not
    // resolve a session at all, so neither does this. Display only — it decides
    // which STARTER BUTTONS render, and two of the four run tools the practice
    // manager does not have. /api/copilot re-derives the real answer from the
    // session on every turn and trusts nothing sent from the browser.
    authEnforced() ? getSessionUser() : Promise.resolve(null),
  ]);
  const disabledSlugs = [...disabled];
  const copilotAccess = authEnforced() ? copilotAccessForRole(sessionUser?.role) : "full";
  // The sidebar's remembered layout is read HERE rather than from localStorage in
  // the component, so the very first paint is already the right width and the
  // right areas are open. Nothing flashes and nothing has to correct itself.
  const navOpenGroups = parseOpenGroups(cookieStore.get(SIDEBAR_GROUPS_COOKIE)?.value);
  return (
    // The quick-view provider wraps the WHOLE shell, not just {children}. It used to
    // wrap only the page content inside <main>, which left <PlatformShortcuts /> (and
    // therefore the Cmd-K command palette) OUTSIDE the context: usePatientQuickView
    // returned null there, so a patient chosen in the palette silently navigated away
    // from the diary you were looking at instead of opening the overview in place.
    <PatientQuickViewProvider>
      {/* FULL BLEED. The working area runs edge to edge against the sidebar, with
          no gutter and no rounding.

          It used to be a floating white panel: a light brand-blue wash behind it and
          a 12px gutter top, right and bottom, with an 18px radius. That framing cost
          real estate on the screens that need it most for nothing but decoration,
          and the owner asked for it gone so the information fills the space.

          The wash survives on the html/body underneath, so an overscroll bounce and
          any area the panel does not cover still read as the product rather than as
          bare white. Fixed widgets (co-pilot, feedback) still escape the clip. */}
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
                  (data-diary), so every other /c page is byte-identical. The diary
                  needs a DEFINITE height for its own two-axis scroller, and needs
                  to reach past the 1400px cap: on a 1920 reception monitor that cap
                  throws away 388px, which is four clinician columns.

                  data-wide is the WIDTH HALF of that and nothing else. The tooth
                  chart needs the same escape from the 1400px cap - after the rail
                  and a 300px treatment panel it would have roughly 1050px for a
                  32-tooth arch, and a tooth too small to hit accurately is a
                  mis-click that charts the wrong tooth - but it must NOT take the
                  diary's h-full or space-y-0, which are that screen's two-axis
                  scroller. The arch keeps its own overflow-x container for
                  genuinely narrow laptops.

                  data-chat is the HEIGHT half again, for the co-pilot page, and
                  it is deliberately NOT data-diary: that marker also drops the
                  1400px cap and zeroes the column's spacing, and a chat wants
                  neither. All the chat needs is a DEFINITE height, because its
                  composer is a row pinned to the bottom of a flex column and its
                  messages are the only thing that scrolls. Without it the page's
                  h-full resolves against an auto-height parent, the column
                  collapses to its content and the composer floats mid-screen.
                  BOTH shells carry it for the same reason data-wide is in both:
                  /owner renders the SAME CopilotView through its [module]
                  if-chain. */}
              <main className="lg:has-[[data-diary]]:h-full lg:has-[[data-chat]]:h-full">
                <div className="mx-auto max-w-[1400px] space-y-4 px-4 py-3 has-[[data-diary]]:max-w-none has-[[data-diary]]:space-y-0 has-[[data-wide]]:max-w-none sm:px-5 lg:px-6 lg:py-4 lg:has-[[data-chat]]:h-full lg:has-[[data-diary]]:h-full">
                  {children}
                </div>
              </main>
            </div>
          </div>
        </div>
        <PlatformShortcuts copilotAccess={copilotAccess} />
        <FeedbackWidget />
        <UsageBeacon />
      </div>
    </PatientQuickViewProvider>
  );
}
