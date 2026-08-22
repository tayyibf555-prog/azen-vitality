"use client";

import { useCallback, useState } from "react";
import { Activity, Banknote, Info, AlertTriangle, ClipboardCheck } from "lucide-react";
import { SectionCard } from "@/components/primitives";
import { hundredthsToUda, formatPenceGbp } from "@/lib/dashboard/money";
import {
  BAND_KEYS,
  BAND_LABELS,
  type BandKey,
  type Tally,
  type BandCell,
} from "@/lib/reports/nhs-activity";
import type {
  NhsClinicalReport,
  ClinicalStatePair,
  ClinicalCounts,
} from "@/lib/reports/nhs-clinical-activity";
import {
  CLINICAL_BANNER_SEGMENTS,
  FORBIDDEN_CLAIMS,
  AMBIGUITY_FLAGS,
} from "@/lib/reports/nhs-clinical-calibration";
import {
  ALLOCATION_CONDITION_LABELS,
  ALLOCATION_CONDITION_NOTES,
  unverifiedConditions,
} from "@/lib/reports/payment-allocation";
import type { AllocationReport } from "@/lib/reports/allocation-report";
import {
  AllocationDisclosures,
  AllocationTable,
  CalibrationBannerText,
  RunCoverage,
} from "@/components/client/reports/allocation-table";
import type { ReportPreset } from "@/lib/reports/report-window";
import { PAY_DEFAULT_PRESET } from "@/lib/reports/report-window";
import type {
  NhsBandReadResult,
  PaymentAllocationReadResult,
  NhsClinicalReadResult,
  PractitionerRef,
} from "@/lib/reports/flagship-read";

// ---------------------------------------------------------------------------
// Thin renderers over the two pure report aggregations. Every figure on screen
// is computed in src/lib/reports/*.ts and tested there; these components only
// arrange, format and — crucially — carry the caveats that keep each number
// honest. Nothing here recomputes a total from raw rows.
// ---------------------------------------------------------------------------

function fmtUda(hundredths: number): string {
  return hundredthsToUda(hundredths).toFixed(2);
}

function windowText(w: { from: string; to: string }): string {
  return w.from === w.to ? w.from : `${w.from} to ${w.to}`;
}

// A period selector, given the presets a report can honestly serve.
function PeriodBar({
  presets,
  value,
  onChange,
  disabled,
}: {
  presets: { key: ReportPreset; label: string }[];
  value: ReportPreset;
  onChange: (p: ReportPreset) => void;
  disabled?: boolean;
}) {
  return (
    <div
      role="tablist"
      aria-label="Report period"
      className="inline-flex flex-wrap rounded-lg border border-line bg-card-muted p-0.5"
    >
      {presets.map((p) => {
        const active = value === p.key;
        return (
          <button
            key={p.key}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={disabled}
            onClick={() => onChange(p.key)}
            className={[
              "rounded-md px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark focus-visible:ring-offset-1 disabled:opacity-50",
              active ? "bg-card text-navy shadow-sm" : "text-muted hover:text-ink",
            ].join(" ")}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function Caveat({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-tint-blue-line bg-tint-blue px-3 py-2.5 text-[12.5px] leading-relaxed text-status-blue">
      <Info size={15} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2.5 text-[12.5px] leading-relaxed text-status-amber">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="rounded-lg border border-dashed border-line-strong bg-card-muted/50 px-4 py-8 text-center text-[13px] text-muted">
      {reason}
    </div>
  );
}

// === Report A: NHS band activity ============================================

const NHS_PRESETS: { key: ReportPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30", label: "Last 30 days" },
  { key: "this_quarter", label: "This quarter" },
  { key: "contract_ytd", label: "Contract year" },
];

function sumCells(cells: BandCell[]): Tally {
  const t: Tally = {
    cotCount: 0,
    approvedCount: 0,
    awaitingCount: 0,
    rejectedCount: 0,
    unrecognisedCount: 0,
    expectedUdaHundredths: 0,
    awardedUdaHundredths: 0,
  };
  for (const c of cells) {
    t.cotCount += c.cotCount;
    t.approvedCount += c.approvedCount;
    t.awaitingCount += c.awaitingCount;
    t.rejectedCount += c.rejectedCount;
    t.unrecognisedCount += c.unrecognisedCount;
    t.expectedUdaHundredths += c.expectedUdaHundredths;
    t.awardedUdaHundredths += c.awardedUdaHundredths;
  }
  return t;
}

function TallyNumbers({ t }: { t: Tally }) {
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums font-semibold text-navy">{t.cotCount}</td>
      <td className="px-3 py-2 text-right tabular-nums text-status-green">{t.approvedCount}</td>
      <td className="px-3 py-2 text-right tabular-nums text-status-amber">{t.awaitingCount}</td>
      <td className="px-3 py-2 text-right tabular-nums text-status-red">{t.rejectedCount}</td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{t.unrecognisedCount}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtUda(t.expectedUdaHundredths)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-ink">{fmtUda(t.awardedUdaHundredths)}</td>
    </>
  );
}

const NHS_HEAD = ["Band", "COTs", "Approved", "Awaiting", "Rejected", "Unclassified", "Expected UDA", "Awarded UDA"];

function NhsActivityReport({
  clientSlug,
  initial,
}: {
  clientSlug: string;
  initial: NhsBandReadResult;
}) {
  const [preset, setPreset] = useState<ReportPreset>("this_month");
  const [data, setData] = useState<NhsBandReadResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clinician, setClinician] = useState<string>("all");
  const [band, setBand] = useState<BandKey | "all">("all");

  const load = useCallback(
    async (p: ReportPreset) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/reports/nhs-activity?client=${encodeURIComponent(clientSlug)}&preset=${p}`,
        );
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean } & Partial<NhsBandReadResult> & { error?: string };
        if (!res.ok || !json.ok || !json.window) throw new Error(json.error || "Could not load the report.");
        setData(json as NhsBandReadResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the report.");
      } finally {
        setLoading(false);
      }
    },
    [clientSlug],
  );

  function choose(p: ReportPreset) {
    if (p === preset || loading) return;
    setPreset(p);
    void load(p);
  }

  const report = data.report;
  const nameById = new Map<string, string>(data.practitioners.map((pr: PractitionerRef) => [pr.id, pr.name]));
  const clinicianName = (id: string | null) => (id === null ? "Unattributed" : nameById.get(id) ?? id);

  // Client-side filtering of the fetched full report — no round trip.
  const rows = report
    ? report.practitioners
        .filter((r) => clinician === "all" || r.practitionerId === (clinician === "none" ? null : clinician))
        .map((r) => ({
          practitionerId: r.practitionerId,
          cells: r.bands.filter((c) => band === "all" || c.band === band),
        }))
        .filter((r) => r.cells.length > 0)
    : [];
  const displayTotal = sumCells(rows.flatMap((r) => r.cells));

  const filterLabel =
    clinician === "all" && band === "all"
      ? "Whole practice"
      : `${clinician === "all" ? "All clinicians" : clinicianName(clinician === "none" ? null : clinician)}${band === "all" ? "" : ` · ${BAND_LABELS[band]}`}`;

  return (
    <SectionCard
      title="NHS activity by clinician and band"
      description="Courses of treatment per clinician, per band — the split Dentally will not give you, broken down by band and by clinician over the period you choose."
      actions={<PeriodBar presets={NHS_PRESETS} value={preset} onChange={choose} disabled={loading} />}
    >
      <div className="space-y-4">
        <Caveat>
          The Approved / Awaiting / Rejected split is the NHS CLAIM lifecycle (submitted then approved
          or rejected), not a clinical &ldquo;completed vs pending&rdquo;. A claim is only raised once
          the course of treatment closes, so genuinely open work is under-represented here. Treatment
          plans still open are not in this figure. UDA totals are each claim&rsquo;s own expected and
          awarded values, not derived from the band. Filtering by treatment CATEGORY as well as band is
          not wired into this report yet: the category sits on treatment_plan_items, which this report
          does not read, and joining it to a claim is not yet calibrated against live data.
        </Caveat>

        {error ? <Warning>{error}</Warning> : null}

        {data.unavailableReason ? (
          <Unavailable reason={data.unavailableReason} />
        ) : report ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <label className="flex items-center gap-1.5 text-muted">
                  Clinician
                  <select
                    value={clinician}
                    onChange={(e) => setClinician(e.target.value)}
                    className="rounded-md border border-line bg-card px-2 py-1 text-ink"
                  >
                    {/* Options are the clinicians actually present in the data,
                        labelled by name where the practitioner list resolves it.
                        Driving this from the report (not the roster) keeps the
                        filter in step with the claims on both live and mock. */}
                    <option value="all">All clinicians</option>
                    {report.practitioners.map((r) =>
                      r.practitionerId === null ? (
                        <option key="none" value="none">
                          Unattributed
                        </option>
                      ) : (
                        <option key={r.practitionerId} value={r.practitionerId}>
                          {clinicianName(r.practitionerId)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-muted">
                  Band
                  <select
                    value={band}
                    onChange={(e) => setBand(e.target.value as BandKey | "all")}
                    className="rounded-md border border-line bg-card px-2 py-1 text-ink"
                  >
                    <option value="all">All bands</option>
                    {BAND_KEYS.map((b) => (
                      <option key={b} value={b}>
                        {BAND_LABELS[b]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-[11.5px] text-faint">
                {loading ? "Loading…" : `${windowText(data.window)}`}
              </p>
            </div>

            {/* Headline answer, phrased the way Blerta asks the question. */}
            <p className="text-[13px] leading-relaxed text-ink">
              <span className="font-semibold text-navy">{filterLabel}</span>, {windowText(data.window)}:{" "}
              <span className="font-semibold tabular-nums">{displayTotal.cotCount}</span> courses of
              treatment —{" "}
              <span className="tabular-nums text-status-green">{displayTotal.approvedCount} approved</span>,{" "}
              <span className="tabular-nums text-status-amber">{displayTotal.awaitingCount} awaiting</span>,{" "}
              <span className="tabular-nums text-status-red">{displayTotal.rejectedCount} rejected</span>.{" "}
              <span className="tabular-nums">{fmtUda(displayTotal.expectedUdaHundredths)}</span> expected
              UDA, <span className="tabular-nums">{fmtUda(displayTotal.awardedUdaHundredths)}</span> awarded.
            </p>

            {rows.length === 0 ? (
              <Unavailable reason="No NHS claims match this period and filter." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left">
                      {NHS_HEAD.map((h, i) => (
                        <th
                          key={h}
                          className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint ${i === 0 ? "text-left" : "text-right"}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const subtotal = sumCells(r.cells);
                      return (
                        <FragmentRows
                          key={r.practitionerId ?? "none"}
                          name={clinicianName(r.practitionerId)}
                          cells={r.cells}
                          subtotal={subtotal}
                          showSubtotal={r.cells.length > 1}
                        />
                      );
                    })}
                    <tr className="border-t-2 border-line-strong bg-card-muted/40 font-semibold">
                      <td className="px-3 py-2 text-left text-navy">Total · {filterLabel}</td>
                      <TallyNumbers t={displayTotal} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {report.unknownStatuses.length > 0 ? (
              <p className="text-[11.5px] text-faint">
                Unrecognised claim statuses counted toward nothing (reported for calibration):{" "}
                {report.unknownStatuses.join(", ")}.
              </p>
            ) : null}
            {data.droppedClaims > 0 ? (
              <p className="text-[11.5px] text-faint">
                {data.droppedClaims} claim{data.droppedClaims === 1 ? "" : "s"} could not be read and were
                excluded, not counted as zero.
              </p>
            ) : null}
          </>
        ) : (
          <Unavailable reason="Report unavailable." />
        )}
      </div>
    </SectionCard>
  );
}

function FragmentRows({
  name,
  cells,
  subtotal,
  showSubtotal,
}: {
  name: string;
  cells: BandCell[];
  subtotal: Tally;
  showSubtotal: boolean;
}) {
  return (
    <>
      {cells.map((c, i) => (
        <tr key={c.band} className="border-b border-line last:border-0">
          <td className="px-3 py-2 text-left text-ink">
            {i === 0 ? <span className="font-medium text-navy">{name}</span> : <span className="text-faint">·</span>}
            <span className="ml-2 text-muted">{BAND_LABELS[c.band]}</span>
          </td>
          <TallyNumbers t={c} />
        </tr>
      ))}
      {showSubtotal ? (
        <tr className="border-b border-line bg-card-muted/30 text-[12px] text-muted">
          <td className="px-3 py-1.5 text-left font-medium">{name} — all bands</td>
          <TallyNumbers t={subtotal} />
        </tr>
      ) : null}
    </>
  );
}

// === Report B: payment allocation ===========================================

const PAY_PRESETS: { key: ReportPreset; label: string }[] = [
  { key: "last_7", label: "Last 7 days" },
  { key: "last_30", label: "Last 30 days" },
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
];

/**
 * The period the PAGE renders with. Deliberately the shortest one: attribution
 * costs a live invoice read per invoice settled in the period, and a page render
 * has far less time than the report's own API route (300s). Every longer period
 * is fetched through that route. reports-view.tsx reads the SAME constant, so the
 * selected tab always matches the data the server actually read.
 */
// PAY_DEFAULT_PRESET moved to report-window.ts: a server page imports it too,
// and a "use client" module must never export a VALUE a server component reads.

function PaymentAllocationReportView({
  clientSlug,
  initial,
}: {
  clientSlug: string;
  initial: PaymentAllocationReadResult;
}) {
  const [preset, setPreset] = useState<ReportPreset>(PAY_DEFAULT_PRESET);
  const [data, setData] = useState<PaymentAllocationReadResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (p: ReportPreset) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/reports/payment-allocation?client=${encodeURIComponent(clientSlug)}&preset=${p}`,
        );
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean } & Partial<PaymentAllocationReadResult> & { error?: string };
        if (!res.ok || !json.ok || !json.window) throw new Error(json.error || "Could not load the report.");
        setData(json as PaymentAllocationReadResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the report.");
      } finally {
        setLoading(false);
      }
    },
    [clientSlug],
  );

  function choose(p: ReportPreset) {
    if (p === preset || loading) return;
    setPreset(p);
    void load(p);
  }

  const report: AllocationReport | null = data.report;
  const nameById = new Map<string, string>(data.practitioners.map((pr) => [pr.id, pr.name]));
  const clinicianName = (id: string) => nameById.get(id) ?? id;

  const missing = report ? unverifiedConditions(report.conditions) : [];

  return (
    <SectionCard
      title="Payment allocation, by clinician"
      description="Money the practice received, attributed to the clinician on the invoice line that money settled. The report you pay dentists from asks four things at once — completed, closed, invoiced, paid — and this states, per line, which of them it stands behind."
      actions={<PeriodBar presets={PAY_PRESETS} value={preset} onChange={choose} disabled={loading} />}
    >
      <div className="space-y-4">
        {/* Always on, never dismissible. Wording lives in allocation-calibration.ts. */}
        <Warning>
          <CalibrationBannerText />
        </Warning>

        {report && missing.length > 0 ? (
          <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5 text-[12px] text-muted">
            <p className="font-semibold text-navy">What this report still cannot confirm:</p>
            <ul className="mt-1.5 space-y-1">
              {missing.map((k) => (
                <li key={k} className="flex gap-2">
                  <span className="mt-0.5 text-status-red">•</span>
                  <span>
                    <span className="font-medium text-ink">{ALLOCATION_CONDITION_LABELS[k]}</span> —{" "}
                    {ALLOCATION_CONDITION_NOTES[k]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {error ? <Warning>{error}</Warning> : null}

        {data.unavailableReason ? (
          <Unavailable reason={data.unavailableReason} />
        ) : report ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <p className="text-[20px] font-bold tabular-nums tracking-[-0.3px] text-navy">
                  {formatPenceGbp(report.totalReceivedPence)}
                </p>
                <p className="text-[12px] text-muted">
                  received across {report.totalCount} payment{report.totalCount === 1 ? "" : "s"},{" "}
                  {windowText(data.window)}
                </p>
              </div>
              <p className="text-[11.5px] text-faint">{loading ? "Loading…" : null}</p>
            </div>

            {/* This run's own coverage, not the calibration figure. */}
            <RunCoverage report={report} windowText={windowText(data.window)} />

            {data.multiSite ? (
              <p className="text-[11.5px] text-faint">
                Showing all sites in view.
              </p>
            ) : null}

            {report.totalCount === 0 ? (
              <Unavailable reason="No payments received in this period." />
            ) : (
              <AllocationTable report={report} clinicianName={clinicianName} />
            )}

            <AllocationDisclosures
              report={report}
              droppedPayments={data.droppedPayments}
              invoicesRead={data.invoicesRead}
              invoicesRequested={data.invoicesRequested}
              invoicesUnreadable={data.invoicesUnreadable}
            />
          </>
        ) : (
          <Unavailable reason="Report unavailable." />
        )}
      </div>
    </SectionCard>
  );
}

// === Report C: NHS clinical completion (completed vs pending) ================

// The same period set as Report A: her questions are month-shaped ("band ones
// this month"). Opens on this month, matching the server's initial read.
const CLINICAL_PRESETS: { key: ReportPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_30", label: "Last 30 days" },
  { key: "this_quarter", label: "This quarter" },
  { key: "contract_ytd", label: "Contract year" },
];

const EMPTY_CLINICAL_COUNTS: ClinicalCounts = {
  items: 0,
  courses: 0,
  patients: 0,
  itemsWithoutPlanId: 0,
};
const EMPTY_CLINICAL_PAIR: ClinicalStatePair = {
  completed: EMPTY_CLINICAL_COUNTS,
  pending: EMPTY_CLINICAL_COUNTS,
};

// Pick the right PRECOMPUTED total for the clinician/band selection. Courses and
// patients are distinct sets and are NOT summable across bands, so the total is
// always read from the aggregation, never re-summed on the client.
function pickClinicalTotal(
  report: NhsClinicalReport,
  clinician: string,
  band: BandKey | "all",
): ClinicalStatePair {
  if (clinician === "all") {
    if (band === "all") return report.grandTotal;
    return report.byBand.find((c) => c.band === band) ?? EMPTY_CLINICAL_PAIR;
  }
  const prac = report.practitioners.find(
    (p) => p.practitionerId === (clinician === "none" ? null : clinician),
  );
  if (!prac) return EMPTY_CLINICAL_PAIR;
  if (band === "all") return prac.total;
  return prac.bands.find((c) => c.band === band) ?? EMPTY_CLINICAL_PAIR;
}

function BannerSegments() {
  return (
    <>
      {CLINICAL_BANNER_SEGMENTS.map((s, i) =>
        s.emphasis === "strong" ? (
          <strong key={i} className="font-semibold">
            {s.text}
          </strong>
        ) : s.emphasis === "code" ? (
          <code key={i} className="rounded bg-black/5 px-1 py-0.5 text-[11.5px]">
            {s.text}
          </code>
        ) : s.emphasis === "em" ? (
          <em key={i}>{s.text}</em>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

// One clinical cell = courses (lead), items, patients. Courses is the headline
// unit per the brief; items and patients sit alongside, muted.
function ClinicalNumbers({ c }: { c: ClinicalCounts }) {
  return (
    <>
      <td className="px-2.5 py-2 text-right tabular-nums font-semibold text-navy">{c.courses}</td>
      <td className="px-2.5 py-2 text-right tabular-nums text-muted">{c.items}</td>
      <td className="px-2.5 py-2 text-right tabular-nums text-muted">{c.patients}</td>
    </>
  );
}

const CLINICAL_HEAD_2 = ["Courses", "Items", "Patients"];

function ClinicalFragmentRows({
  name,
  cells,
  subtotal,
  showSubtotal,
}: {
  name: string;
  cells: { band: BandKey; completed: ClinicalCounts; pending: ClinicalCounts }[];
  subtotal: ClinicalStatePair;
  showSubtotal: boolean;
}) {
  return (
    <>
      {cells.map((c, i) => (
        <tr key={c.band} className="border-b border-line last:border-0">
          <td className="px-2.5 py-2 text-left text-ink">
            {i === 0 ? (
              <span className="font-medium text-navy">{name}</span>
            ) : (
              <span className="text-faint">·</span>
            )}
            <span className="ml-2 text-muted">{BAND_LABELS[c.band]}</span>
          </td>
          <ClinicalNumbers c={c.completed} />
          <ClinicalNumbers c={c.pending} />
        </tr>
      ))}
      {showSubtotal ? (
        <tr className="border-b border-line bg-card-muted/30 text-[12px] text-muted">
          <td className="px-2.5 py-1.5 text-left font-medium">{name} — all bands</td>
          <ClinicalNumbers c={subtotal.completed} />
          <ClinicalNumbers c={subtotal.pending} />
        </tr>
      ) : null}
    </>
  );
}

function NhsClinicalReportView({
  clientSlug,
  initial,
}: {
  clientSlug: string;
  initial: NhsClinicalReadResult;
}) {
  const [preset, setPreset] = useState<ReportPreset>("this_month");
  const [data, setData] = useState<NhsClinicalReadResult>(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clinician, setClinician] = useState<string>("all");
  const [band, setBand] = useState<BandKey | "all">("all");

  const load = useCallback(
    async (p: ReportPreset) => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/reports/nhs-clinical?client=${encodeURIComponent(clientSlug)}&preset=${p}`,
        );
        const json = (await res.json().catch(() => ({}))) as { ok?: boolean } & Partial<NhsClinicalReadResult> & { error?: string };
        if (!res.ok || !json.ok || !json.window) throw new Error(json.error || "Could not load the report.");
        setData(json as NhsClinicalReadResult);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the report.");
      } finally {
        setLoading(false);
      }
    },
    [clientSlug],
  );

  function choose(p: ReportPreset) {
    if (p === preset || loading) return;
    setPreset(p);
    void load(p);
  }

  const report = data.report;
  const nameById = new Map<string, string>(data.practitioners.map((pr) => [pr.id, pr.name]));
  const clinicianName = (id: string | null) => (id === null ? "Unattributed" : nameById.get(id) ?? id);

  const rows = report
    ? report.practitioners
        .filter((r) => clinician === "all" || r.practitionerId === (clinician === "none" ? null : clinician))
        .map((r) => ({
          practitionerId: r.practitionerId,
          cells: r.bands.filter((c) => band === "all" || c.band === band),
          total: r.total,
        }))
        .filter((r) => r.cells.length > 0)
    : [];
  const displayTotal = report ? pickClinicalTotal(report, clinician, band) : EMPTY_CLINICAL_PAIR;

  const filterLabel =
    clinician === "all" && band === "all"
      ? "Whole practice"
      : `${clinician === "all" ? "All clinicians" : clinicianName(clinician === "none" ? null : clinician)}${band === "all" ? "" : ` · ${BAND_LABELS[band]}`}`;

  // The "course counts are a floor" figure: banded items with no plan id.
  const itemsWithoutPlanId = report
    ? report.grandTotal.completed.itemsWithoutPlanId + report.grandTotal.pending.itemsWithoutPlanId
    : 0;

  const bandWord = band === "all" ? "" : `${BAND_LABELS[band].toLowerCase()} `;

  return (
    <SectionCard
      title="NHS completion by clinician and band"
      description="Treatment recorded as completed versus still pending, per clinician and band — the half the claims report cannot show, because a claim is only raised once a course closes. Read from the clinical record, not from Compass."
      actions={<PeriodBar presets={CLINICAL_PRESETS} value={preset} onChange={choose} disabled={loading} />}
    >
      <div className="space-y-4">
        {/* Always on, never dismissible. Wording lives in nhs-clinical-calibration.ts. */}
        <Warning>
          <BannerSegments />
        </Warning>

        {error ? <Warning>{error}</Warning> : null}

        {data.unavailableReason ? (
          <Unavailable reason={data.unavailableReason} />
        ) : report ? (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <label className="flex items-center gap-1.5 text-muted">
                  Clinician
                  <select
                    value={clinician}
                    onChange={(e) => setClinician(e.target.value)}
                    className="rounded-md border border-line bg-card px-2 py-1 text-ink"
                  >
                    <option value="all">All clinicians</option>
                    {report.practitioners.map((r) =>
                      r.practitionerId === null ? (
                        <option key="none" value="none">
                          Unattributed
                        </option>
                      ) : (
                        <option key={r.practitionerId} value={r.practitionerId}>
                          {clinicianName(r.practitionerId)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-muted">
                  Band
                  <select
                    value={band}
                    onChange={(e) => setBand(e.target.value as BandKey | "all")}
                    className="rounded-md border border-line bg-card px-2 py-1 text-ink"
                  >
                    <option value="all">All bands</option>
                    {BAND_KEYS.map((b) => (
                      <option key={b} value={b}>
                        {BAND_LABELS[b]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="text-[11.5px] text-faint">{loading ? "Loading…" : windowText(data.window)}</p>
            </div>

            {/* Headline, phrased the way Blerta asks it. Leads with COURSES, and
                keeps the two states SEPARATE: a course or patient can be partly
                done, appearing in both, so completed and pending are never summed
                (only items, which fall in exactly one state, are additive). */}
            <p className="text-[13px] leading-relaxed text-ink">
              <span className="font-semibold text-navy">{filterLabel}</span>, {windowText(data.window)}:{" "}
              <span className="font-semibold tabular-nums text-status-green">
                {displayTotal.completed.courses}
              </span>{" "}
              {bandWord}courses completed and{" "}
              <span className="font-semibold tabular-nums text-status-amber">
                {displayTotal.pending.courses}
              </span>{" "}
              still with pending treatment.{" "}
              <span className="text-muted">
                That is{" "}
                <span className="tabular-nums">{displayTotal.completed.items}</span> completed and{" "}
                <span className="tabular-nums">{displayTotal.pending.items}</span> pending items across{" "}
                <span className="tabular-nums">{displayTotal.completed.patients}</span>/
                <span className="tabular-nums">{displayTotal.pending.patients}</span> patients
                (completed / pending).
              </span>
            </p>

            {rows.length === 0 ? (
              <Unavailable reason="No NHS treatment items match this period and filter." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th
                        rowSpan={2}
                        className="px-2.5 py-2 text-left text-[11px] font-medium uppercase tracking-[0.04em] text-faint align-bottom"
                      >
                        Clinician / band
                      </th>
                      <th
                        colSpan={3}
                        className="px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-[0.04em] text-status-green border-l border-line"
                      >
                        Completed
                      </th>
                      <th
                        colSpan={3}
                        className="px-2.5 py-1 text-center text-[11px] font-semibold uppercase tracking-[0.04em] text-status-amber border-l border-line"
                      >
                        Pending
                      </th>
                    </tr>
                    <tr className="border-b border-line text-left">
                      {CLINICAL_HEAD_2.map((h, i) => (
                        <th
                          key={`c-${h}`}
                          className={`px-2.5 py-1.5 text-right text-[10.5px] font-medium uppercase tracking-[0.03em] text-faint ${i === 0 ? "border-l border-line" : ""}`}
                        >
                          {h}
                        </th>
                      ))}
                      {CLINICAL_HEAD_2.map((h, i) => (
                        <th
                          key={`p-${h}`}
                          className={`px-2.5 py-1.5 text-right text-[10.5px] font-medium uppercase tracking-[0.03em] text-faint ${i === 0 ? "border-l border-line" : ""}`}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <ClinicalFragmentRows
                        key={r.practitionerId ?? "none"}
                        name={clinicianName(r.practitionerId)}
                        cells={r.cells}
                        subtotal={r.total}
                        showSubtotal={band === "all" && r.cells.length > 1}
                      />
                    ))}
                    <tr className="border-t-2 border-line-strong bg-card-muted/40 font-semibold">
                      <td className="px-2.5 py-2 text-left text-navy">Total · {filterLabel}</td>
                      <ClinicalNumbers c={displayTotal.completed} />
                      <ClinicalNumbers c={displayTotal.pending} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {/* The visible reconcile: nothing counted vanishes silently. */}
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5 text-[11.5px] text-muted">
                <p className="font-semibold text-navy">What was scanned, and where it went</p>
                <ul className="mt-1.5 space-y-1">
                  <li>{report.totalItemsScanned} treatment items read for this period.</li>
                  <li>{report.excludedNonNhs} excluded as private / non-NHS (no band).</li>
                  <li>{report.excludedOutOfWindow} excluded as outside the period.</li>
                  <li>
                    {report.droppedUnreadable} could not be placed (no id, a duplicate, or a completed
                    item with no completion date) — excluded, not counted as zero.
                  </li>
                </ul>
              </div>
              <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5 text-[11.5px] text-muted">
                <p className="font-semibold text-navy">Read the course counts as a floor</p>
                <p className="mt-1.5">
                  {itemsWithoutPlanId} banded item{itemsWithoutPlanId === 1 ? "" : "s"} in this period
                  carry no treatment plan id and cannot be grouped into a course, so every course count
                  is at least the number shown, not exactly it.
                </p>
                <p className="mt-1.5 text-faint">
                  Per-site scope is via the clinician roster
                  {data.filterPathUsed === "group-slice"
                    ? " (read via the whole-group fallback: the per-clinician filter was unavailable on this run)."
                    : "; a clinician working at two sites appears under each."}
                </p>
              </div>
            </div>

            {/* Forbidden claims — enforced on screen as well as in the const. */}
            <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5 text-[12px] text-muted">
              <p className="font-semibold text-navy">What these numbers are not</p>
              <ul className="mt-1.5 space-y-1">
                {FORBIDDEN_CLAIMS.map((f) => (
                  <li key={f.claim} className="flex gap-2">
                    <span className="mt-0.5 text-status-red">•</span>
                    <span>
                      <span className="font-medium text-ink">Not {f.claim}.</span> {f.because}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Open decisions — confirm before treating a headline as final. */}
            <div className="rounded-lg border border-tint-blue-line bg-tint-blue px-3 py-2.5 text-[12px] text-status-blue">
              <p className="font-semibold">Confirm with the practice before relying on a single figure</p>
              <ul className="mt-1.5 space-y-1.5">
                {AMBIGUITY_FLAGS.map((a) => (
                  <li key={a.question}>
                    <span className="font-medium">{a.question}</span> {a.recommendation}
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : (
          <Unavailable reason="Report unavailable." />
        )}
      </div>
    </SectionCard>
  );
}

// === The three-tab wrapper ===================================================

export function FlagshipReports({
  clientSlug,
  nhs,
  pay,
  clinical,
}: {
  clientSlug: string;
  nhs: NhsBandReadResult;
  pay: PaymentAllocationReadResult;
  clinical: NhsClinicalReadResult;
}) {
  const [tab, setTab] = useState<"nhs" | "clinical" | "pay">("nhs");
  return (
    <div className="space-y-5">
      <div role="tablist" className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
        <TabButton active={tab === "nhs"} onClick={() => setTab("nhs")} icon={<Activity size={15} />}>
          NHS activity
        </TabButton>
        <TabButton active={tab === "clinical"} onClick={() => setTab("clinical")} icon={<ClipboardCheck size={15} />}>
          NHS completion
        </TabButton>
        <TabButton active={tab === "pay"} onClick={() => setTab("pay")} icon={<Banknote size={15} />}>
          Payment allocation
        </TabButton>
      </div>
      {tab === "nhs" ? (
        <NhsActivityReport clientSlug={clientSlug} initial={nhs} />
      ) : tab === "clinical" ? (
        <NhsClinicalReportView clientSlug={clientSlug} initial={clinical} />
      ) : (
        <PaymentAllocationReportView clientSlug={clientSlug} initial={pay} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        "inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
      ].join(" ")}
    >
      {icon}
      {children}
    </button>
  );
}
