"use client";

import { useMemo, useState } from "react";
import type { DashboardPeriod } from "@/lib/dashboard/period";
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
// ---------------------------------------------------------------------------

/** Hairlines for a band cell: one column, two columns, then four. */
function bandCell(index: number): string {
  return cn(
    "flex min-w-0 flex-col px-4 py-2.5",
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

function SiteToggle({
  sites,
  siteId,
  onChange,
}: {
  sites: { id: string; name: string }[];
  siteId: string | null;
  onChange: (id: string | null) => void;
}) {
  const options: { id: string | null; name: string }[] = [{ id: null, name: "All sites" }, ...sites];
  return (
    <div
      role="group"
      aria-label="Site"
      className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[2px]"
    >
      {options.map((option) => {
        const active = option.id === siteId;
        return (
          <button
            key={option.id ?? "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            className={cn(
              "pressable rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
              active ? "bg-navy text-white" : "text-muted hover:text-navy",
            )}
          >
            {option.name}
          </button>
        );
      })}
    </div>
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
  const [period, setPeriod] = useState<DashboardPeriod>("today");
  const [siteId, setSiteId] = useState<string | null>(initialSiteId);
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
  const takings = useMemo(
    () =>
      takingsCaveats({
        strip: scope.strip,
        unattributedPayments: scope.unattributedPayments,
        droppedPayments: view.droppedPayments,
      }),
    [scope.strip, scope.unattributedPayments, view.droppedPayments],
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
    // The dashboard wants width, and takes it the same way every other page does:
    // the shared sidebar collapse toggle. No per-page override any more.
    <div className="space-y-3">
      {/* A line, not a hero. The section headings below carry the structure. */}
      <h1 className="text-[15px] font-semibold tracking-[-0.3px] text-navy">Dashboard</h1>

      <TakingsStripPanel
        cells={scope.strip.cells}
        sources={scope.stripSources}
        selected={period}
        onSelect={setPeriod}
        siteControl={<SiteToggle sites={view.sites} siteId={siteId} onChange={setSiteId} />}
        caveats={takings}
        onOpenCaveat={setOpenCaveat}
      />

      <div className="-mx-4 grid grid-cols-1 border-y border-line md:grid-cols-2 xl:grid-cols-4">
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
            clientSlug={clientSlug}
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
        clientSlug={clientSlug}
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
