"use client";

import type { PatientsPanel, PlansPanel, UdaProgressPanel, UdaWindowPanel } from "@/lib/dashboard/view";
import { cn } from "@/lib/utils";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { Count, PanelTitle, Uda, Unavailable } from "./parts";

// ---------------------------------------------------------------------------
// The fourth column of the middle band: PATIENTS and TREATMENT PLANS as two
// narrow sub-columns, then "Your UDAs" and "Total UDAs" underneath, in the same
// arrangement she reads in Dentally.
//
// One thing is added, and only one: progress against the annual contract, with
// pace. Dentally shows the UDA count but never whether the practice is on track,
// and an NHS clawback at year end is the number that actually matters. It sits
// in the same position, as one extra line under the UDA blocks.
//
// The target is not derivable from the Dentally API: it is set in the NHS
// contract. Until it is configured the line says so, and the reason travels on
// the mark beside it rather than as a paragraph under the band. It does not
// estimate, and it does not fall back to a typical target, because a percentage
// against an invented denominator is exactly the kind of figure that gets
// believed.
// ---------------------------------------------------------------------------

function MiniStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[2px]">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      {children}
    </div>
  );
}

function SubHeading({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line pb-[3px]">
      <h4 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">{children}</h4>
      {right}
    </div>
  );
}

function UdaProgressLine({
  panel,
  caveats,
  onOpenCaveat,
}: {
  panel: UdaProgressPanel;
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  const { progress } = panel;
  const yearLabel = `${panel.contractYear.start.slice(0, 4)}/${panel.contractYear.end.slice(2, 4)}`;

  if (progress === null) {
    return (
      <div className="mt-auto border-t border-line pt-2">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
            Contract {yearLabel}
          </span>
          <span className="flex items-baseline gap-1.5">
            <Unavailable reason={panel.reason} />
            <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
          </span>
        </div>
      </div>
    );
  }

  const percent = Math.max(0, Math.min(100, progress.percentOfTarget));
  const expected = Math.max(0, Math.min(100, (progress.expectedUdaByNow / progress.targetUda) * 100));
  const behind = progress.varianceUda < 0;

  return (
    <div className="mt-auto border-t border-line pt-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
          Contract {yearLabel}
        </span>
        <span className="flex items-baseline gap-1.5">
          <span className="text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
            {progress.percentOfTarget.toFixed(1)}%
          </span>
          <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
        </span>
      </div>

      {/* NHS work, so the bar is NHS blue. The tick is where an even year would
          be today, which is the whole point of the line: a percentage on its own
          does not say whether it is a good percentage for July. */}
      <div className="relative mt-1 h-[6px] w-full overflow-hidden rounded-full bg-card-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${percent}%`, background: "var(--status-blue)" }}
        />
        <span
          aria-hidden
          className="absolute top-0 h-full w-[2px] bg-navy"
          style={{ left: `calc(${expected}% - 1px)` }}
        />
      </div>

      <p className="mt-1 text-[11px] font-medium leading-[1.35] text-muted">
        <span className={cn("font-semibold", behind ? "text-status-red" : "text-status-green")}>
          {behind ? "Behind" : "Ahead"} by {Math.abs(progress.varianceUda).toFixed(0)} UDA
        </span>{" "}
        against an even year. {progress.completedUda.toFixed(0)} of{" "}
        {progress.targetUda.toLocaleString("en-GB")} done,{" "}
        {progress.daysRemaining} day{progress.daysRemaining === 1 ? "" : "s"} left.
        {progress.requiredUdaPerDay === null ? null : (
          <>
            {" "}
            Needs {progress.requiredUdaPerDay.toFixed(1)} a day; running at{" "}
            {progress.paceUdaPerDay.toFixed(1)}.
          </>
        )}
      </p>
    </div>
  );
}

export function CountsColumn({
  patients,
  plans,
  uda,
  progress,
  practitionerId,
  onPractitionerChange,
  practitioners,
  caveats,
  onOpenCaveat,
}: {
  patients: PatientsPanel;
  plans: PlansPanel;
  uda: UdaWindowPanel;
  progress: UdaProgressPanel;
  /** The clinician "Your UDAs" is showing, or null when none is chosen. */
  practitionerId: string | null;
  onPractitionerChange: (id: string | null) => void;
  practitioners: { id: string; name: string }[];
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  // NO ZERO FALLBACK. The clinician picker is fed from the appointment feed, not
  // the claims feed, so a manager can select someone while the NHS claims read has
  // failed. Substituting zeros there would print "Your UDAs: 0.00" next to "Total
  // UDAs: Unavailable", which reads as "you have done no NHS work" rather than "we
  // could not load this". On the one panel where the number drives an NHS clawback,
  // a confident zero is the worst possible failure. Absent stays absent, and the
  // window's own reason is shown instead.
  const mine =
    practitionerId === null
      ? null
      : uda.byPractitioner.find((row) => row.practitionerId === practitionerId) ?? null;
  /**
   * Two different reasons produce no row, and they must not look the same.
   * The claims READ FAILED, so nothing is known: that is Unavailable.
   * The read succeeded and this clinician simply has no claims in the window:
   * zero is then the honest, correct answer and should be shown as 0.00.
   */
  const claimsUnavailable = uda.completedUda.value === null;

  return (
    <section aria-label="Patients, treatment plans and UDAs" className="flex h-full min-w-0 flex-col">
      <PanelTitle>Patients and plans</PanelTitle>

      <div className="grid grid-cols-2 gap-x-4 pt-2">
        <div className="min-w-0">
          <SubHeading>Patients</SubHeading>
          <div className="pt-[3px]">
            <MiniStat label="New">
              <Count metric={patients.newCount} />
            </MiniStat>
            <MiniStat label="Seen">
              <Count metric={patients.seenCount} />
            </MiniStat>
            <MiniStat label="Active">
              <Count metric={patients.activeCount} />
            </MiniStat>
          </div>
        </div>

        <div className="min-w-0">
          <SubHeading>Treatment plans</SubHeading>
          <div className="pt-[3px]">
            <MiniStat label="Started">
              <Count metric={plans.started} />
            </MiniStat>
            <MiniStat label="Finished">
              <Count metric={plans.finished} />
            </MiniStat>
            <MiniStat label="Open">
              <Count metric={plans.open} />
            </MiniStat>
          </div>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-x-4 border-t border-line pt-2">
        <div className="min-w-0">
          <SubHeading>Your UDAs</SubHeading>
          <label className="sr-only" htmlFor="dashboard-your-uda">
            Clinician for your UDAs
          </label>
          <select
            id="dashboard-your-uda"
            value={practitionerId ?? ""}
            onChange={(event) => onPractitionerChange(event.target.value || null)}
            className="mt-1 w-full truncate rounded-md border border-line bg-card px-1.5 py-[2px] text-[11px] font-medium text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            <option value="">Choose a clinician</option>
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <div className="pt-[3px]">
            {practitionerId === null ? (
              <p className="text-[11px] font-normal leading-[1.35] text-faint">
                No clinician is linked to this login, so there is no &ldquo;yours&rdquo; to show. Pick one
                above.
              </p>
            ) : claimsUnavailable ? (
              <>
                <MiniStat label="Completed">
                  <Uda metric={uda.completedUda} />
                </MiniStat>
                <MiniStat label="Invalid">
                  <Uda metric={uda.invalidUda} />
                </MiniStat>
              </>
            ) : (
              <>
                <MiniStat label="Completed">
                  <Uda metric={{ value: mine?.completedUda ?? 0, reason: null }} />
                </MiniStat>
                <MiniStat label="Invalid">
                  <Uda metric={{ value: mine?.invalidUda ?? 0, reason: null }} />
                </MiniStat>
              </>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <SubHeading>Total UDAs</SubHeading>
          {/* Spacer so the two sub-columns' figures sit on the same baseline as the
              picker's neighbour, rather than staggering. */}
          <div aria-hidden className="mt-1 h-[22px]" />
          <div className="pt-[3px]">
            <MiniStat label="Completed">
              <Uda metric={uda.completedUda} />
            </MiniStat>
            <MiniStat label="Invalid">
              <Uda metric={uda.invalidUda} />
            </MiniStat>
          </div>
        </div>
      </div>

      <UdaProgressLine panel={progress} caveats={caveats} onOpenCaveat={onOpenCaveat} />
    </section>
  );
}
