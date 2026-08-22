"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import type { DashboardPeriod } from "@/lib/dashboard/period";
import { shellBase } from "@/lib/nav-shell";
import type { PracticeDashboardView } from "@/lib/dashboard/view";
import { cn } from "@/lib/utils";
import { AccountsPanelView } from "./accounts-panel";
import { AppointmentListPanel, type StatusFilter } from "./appointment-list";
import { AppointmentsDonut } from "./appointments-donut";
import { CaveatRow } from "./caveat";
import {
  accountsCaveats,
  appointmentsCaveats,
  invoicedCaveats,
  takingsCaveats,
  udaCaveats,
} from "./caveats";
import { CountsColumn } from "./counts-column";
import { InvoicedPanelView } from "./invoiced-panel";
import { TakingsStripPanel } from "./takings-strip";

// ---------------------------------------------------------------------------
// The practice-manager dashboard, panel for panel as she reads it in Dentally:
// the takings strip across the top, the four column band under it, and the
// appointment list below. Nothing is moved, merged, dropped or reinvented.
//
// Everything is computed on the server for every site and every period, so the
// strip and the site toggle switch instantly. She reads this between phone
// calls; a round trip per click is the wrong trade for a screen whose whole job
// is to be glanced at.
//
// LAYOUT. The four middle panels sit on ONE grid: a hairline above and below the
// band, hairline rules between the columns, and every panel stretched to the
// same height so tops and bottoms line up. Ragged panel heights were why the
// band read as four unrelated things rather than one instrument.
//
// WIDTHS ABOVE xl. The grid has as many columns as it has panels, so at xl it has
// run out of ways to reflow and simply stretches: four equal columns, each of
// them half again wider than the content drawn in it. The 2xl track sizes below
// are the fix - the two panels that can actually SPEND width (the donut, which
// puts its ring beside its legend there, and the counts column, which carries
// four sub-columns of figures) take a larger share than the two that cannot.
// Equal columns above xl is what "floats in white space" looked like.
// ---------------------------------------------------------------------------

/** Hairlines for a band cell: one column, two columns, then four. */
function bandCell(index: number): string {
  return cn(
    // Padding tracks the shell's own gutter (px-4 sm:px-5 lg:px-6) because the band
    // bleeds out by exactly that much below. The two have to move together or the
    // first figure in the band stops lining up with every heading on the page.
    "flex min-w-0 flex-col px-4 py-2.5 sm:px-5 lg:px-6",
    // Stacked: a rule above every panel but the first.
    index > 0 && "border-t border-line",
    // Two columns: the second panel starts a row of its own, so it loses that rule.
    index === 1 && "md:border-t-0",
    // Four columns: no horizontal rules at all, only the band's own top and foot.
    (index === 2 || index === 3) && "xl:border-t-0",
    // Vertical rules: the right-hand panel of each pair, then every panel but the first.
    index % 2 === 1 && "md:border-l md:border-line",
    index === 2 && "xl:border-l xl:border-line",
  );
}

export function PracticeDashboard({
  view,
  clientSlug,
  initialSiteId,
}: {
  view: PracticeDashboardView;
  clientSlug: string;
  /** The site the top bar is already showing, so the two controls agree on open. */
  initialSiteId: string | null;
}) {
  // WHICH TREE THIS DASHBOARD IS BEING READ IN. The same component renders at
  // /c/<client> and at /owner/<client>, and every patient link below hangs off
  // this. It used to be hard-coded to "/c/<client>", so an owner opening a debtor
  // or an appointment from their own dashboard was thrown out of the owner shell.
  const pathname = usePathname();
  const basePath = shellBase(pathname, clientSlug);

  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [siteId, setSiteId] = useState<string | null>(initialSiteId);
  // The top bar changes the site by writing a cookie and calling router.refresh(),
  // so the new choice arrives here as a CHANGED PROP. Deriving it during render is
  // React's documented pattern for that; without it the dashboard would keep
  // showing the site it first mounted with while the bar above said otherwise.
  const [lastInitialSiteId, setLastInitialSiteId] = useState(initialSiteId);
  if (lastInitialSiteId !== initialSiteId) {
    setLastInitialSiteId(initialSiteId);
    setSiteId(initialSiteId);
  }
  const [listPractitionerId, setListPractitionerId] = useState<string | null>(null);
  const [udaPractitionerId, setUdaPractitionerId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("remaining");
  /** Which caveat's full sentence is open in the row under the band. */
  const [openCaveat, setOpenCaveat] = useState<string | null>(null);

  const scope = useMemo(
    () => view.scopes.find((s) => s.siteId === siteId) ?? view.scopes[0],
    [view.scopes, siteId],
  );
  const panels = scope.periods[period];

  // Every caveat the screen has to make, built once, per panel. Each panel gets
  // its own for the mark beside the figure it qualifies; the row under the band
  // shows them all, in the order the panels are read.
  // Ids to names, so the takings caveat can NAME the practice that did not answer
  // instead of saying one of them did not. The read layer sends ids (it has no
  // display names); `view.sites` is the only place they are paired.
  //
  // AND SCOPED TO WHAT THIS STRIP IS SHOWING. `view.takingsFailedSites` is assembled
  // once for the whole group and was appended verbatim to every scope's caveat, so a
  // manager looking at N15 alone could be told "the site that did not answer: N17" —
  // about a practice not on her screen, whose failure blanks nothing she can see, in
  // a sentence that follows a blank she now has no explanation for. Worse in the
  // plural: a single-site scope could be followed by a list of two other practices.
  // A scope names only failures inside itself; a scope with none appends nothing.
  const failedSiteNames = useMemo(() => {
    const inScope =
      scope.siteId === null
        ? view.takingsFailedSites
        : view.takingsFailedSites.filter((id) => id === scope.siteId);
    return inScope.map((id) => view.sites.find((s) => s.id === id)?.name ?? id);
  }, [view.takingsFailedSites, view.sites, scope.siteId]);
  const takings = useMemo(
    () =>
      takingsCaveats({
        strip: scope.strip,
        unattributedPayments: scope.unattributedPayments,
        droppedPayments: view.droppedPayments,
        failedSiteNames,
      }),
    [scope.strip, scope.unattributedPayments, view.droppedPayments, failedSiteNames],
  );
  const appointments = useMemo(() => appointmentsCaveats(panels.appointments), [panels.appointments]);
  const accounts = useMemo(() => accountsCaveats(scope.accounts), [scope.accounts]);
  const invoiced = useMemo(() => invoicedCaveats(panels.invoiced), [panels.invoiced]);
  const uda = useMemo(() => udaCaveats(panels.uda, scope.udaProgress), [panels.uda, scope.udaProgress]);
  const allCaveats = useMemo(
    () => [...takings, ...appointments, ...accounts, ...invoiced, ...uda],
    [takings, appointments, accounts, invoiced, uda],
  );

  return (
    // WIDTH IS THE PAGE'S, NOT THIS COMPONENT'S - and that is a REVERSAL.
    //
    // This used to read "the dashboard wants width, and takes it the same way every
    // other page does: the shared sidebar collapse toggle. No per-page override any
    // more." That was wrong, and the owner said so: collapsing the rail buys about
    // 190px, while the shell's max-w-[1400px] cap throws away 388px on a 1920 screen
    // and over a thousand on a 2560 one, and no amount of collapsing reaches past a
    // cap. So there IS a per-page override again: data-wide, on the page wrapper.
    //
    // It is set by c/[client]/page.tsx and owner/[client]/page.tsx rather than here,
    // deliberately. The shell reads the marker with a :has(), which matches ANY
    // descendant, so whoever sets it un-caps every sibling in the main column too -
    // the task queue, and on /owner the entire owner console. Only the page knows
    // what its siblings are and can re-cap them. A marker set here would silently
    // widen screens this component has never heard of.
    <div className="space-y-3">
      {/* A line, not a hero. The section headings below carry the structure. */}
      <h1 className="text-[15px] font-semibold tracking-[-0.3px] text-navy">Dashboard</h1>

      {/* NO site control on the strip any more. The top bar owns which practice
          you are looking at, for the whole session and every page. This strip
          used to carry a second selector, so the same choice appeared twice
          within eighty pixels of itself and the two could disagree. */}
      <TakingsStripPanel
        cells={scope.strip.cells}
        selected={period}
        onSelect={setPeriod}
        siteControl={null}
        caveats={takings}
        onOpenCaveat={setOpenCaveat}
      />

      {/* The band bleeds by exactly the shell's gutter at every breakpoint. It used
          to bleed a flat -mx-4 while the gutter grew to px-5 and px-6, so above sm
          the band stopped short of the edge it is supposed to reach - 8px on each
          side at lg, visible against every rule under it.

          TWO WEIGHTS OF RULE, NOT ONE. The band's own top and bottom are --line-strong
          and everything drawn inside it - the rules between the columns, the hairline
          under each panel heading, the dividers in the debtor list - stays --line. It
          was all one weight, so a screen whose whole job is to read as one instrument
          with four panels in it drew its outer boundary in exactly the same ink as a
          divider between two rows of a list, and nothing said where the instrument
          ended. One step of the existing scale, not a heavier line: this is the
          hierarchy the flat language was missing, not a return to boxes.

          AND IT IS SET INLINE, WHICH IS NOT A STYLE CHOICE. globals.css carries a bare
          `* { border-color: var(--line) }` OUTSIDE any @layer, and an unlayered rule
          beats every layered one whatever the specificity, so it wins over the whole
          of Tailwind's utilities layer. `border-line-strong` here rendered as --line,
          measured in the browser - and so does every other border colour in the app:
          620 utilities across 159 files (border-danger, border-navy, border-blue-dark,
          the status tint lines) all paint the same grey hairline today. The one-line
          fix is to move that default into @layer base, but doing it repaints borders
          on every screen in the product and that is not this lane's change to make.
          Until it is made, a class here would say one thing and draw another, which is
          worse than a style attribute that says exactly what it does. */}
      <div
        style={{ borderTopColor: "var(--line-strong)", borderBottomColor: "var(--line-strong)" }}
        className="-mx-4 grid grid-cols-1 border-y sm:-mx-5 md:grid-cols-2 lg:-mx-6 xl:grid-cols-4 2xl:grid-cols-[1.15fr_1fr_1fr_1.15fr]"
      >
        <div className={bandCell(0)}>
          <AppointmentsDonut
            panel={panels.appointments}
            caveats={appointments}
            onOpenCaveat={setOpenCaveat}
          />
        </div>
        <div className={bandCell(1)}>
          <AccountsPanelView
            panel={scope.accounts}
            basePath={basePath}
            caveats={accounts}
            onOpenCaveat={setOpenCaveat}
          />
        </div>
        <div className={bandCell(2)}>
          <InvoicedPanelView panel={panels.invoiced} caveats={invoiced} onOpenCaveat={setOpenCaveat} />
        </div>
        <div className={bandCell(3)}>
          <CountsColumn
            patients={panels.patients}
            plans={panels.plans}
            uda={panels.uda}
            progress={scope.udaProgress}
            practitioners={view.practitioners}
            practitionerId={udaPractitionerId}
            onPractitionerChange={setUdaPractitionerId}
            caveats={uda}
            onOpenCaveat={setOpenCaveat}
          />
        </div>
      </div>

      <CaveatRow
        lead={
          <>
            Stats updated {view.generatedAtLabel} · {scope.label} · {panels.window.from} to{" "}
            {panels.window.to}
          </>
        }
        caveats={allCaveats}
        openId={openCaveat}
        onOpenChange={setOpenCaveat}
      />

      <AppointmentListPanel
        rows={view.appointments}
        period={period}
        window={panels.window}
        basePath={basePath}
        practitioners={view.practitioners}
        practitionerId={listPractitionerId}
        onPractitionerChange={setListPractitionerId}
        status={status}
        onStatusChange={setStatus}
        sites={view.sites}
        siteId={siteId}
        onSiteChange={setSiteId}
        capped={view.appointmentsCapped}
        totalInWindow={view.appointmentsInWindow}
      />
    </div>
  );
}
