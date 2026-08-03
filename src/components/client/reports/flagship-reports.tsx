"use client";

import { useCallback, useState } from "react";
import { Activity, Banknote, Info, AlertTriangle } from "lucide-react";
import { SectionCard, StatusPill, type Tone } from "@/components/primitives";
import { hundredthsToUda, formatPenceGbp } from "@/lib/dashboard/money";
import {
  BAND_KEYS,
  BAND_LABELS,
  type BandKey,
  type Tally,
  type BandCell,
} from "@/lib/reports/nhs-activity";
import {
  ALLOCATION_CONDITION_LABELS,
  ALLOCATION_CONDITION_NOTES,
  unverifiedConditions,
  type AllocationConditions,
  type PaymentAllocationReport,
  type Verify,
} from "@/lib/reports/payment-allocation";
import type { ReportPreset } from "@/lib/reports/report-window";
import type { NhsBandReadResult, PaymentAllocationReadResult, PractitionerRef } from "@/lib/reports/flagship-read";

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
          not available from Dentally&rsquo;s API practice-wide.
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

const VERIFY_TONE: Record<Verify, Tone> = {
  verified: "success",
  partial: "warning",
  unverified: "danger",
};
const VERIFY_LABEL: Record<Verify, string> = {
  verified: "verified",
  partial: "partial",
  unverified: "not verified",
};

function ConditionChips({ conditions }: { conditions: AllocationConditions }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(ALLOCATION_CONDITION_LABELS) as (keyof AllocationConditions)[]).map((k) => (
        <StatusPill key={k} tone={VERIFY_TONE[conditions[k]]}>
          {ALLOCATION_CONDITION_LABELS[k]}: {VERIFY_LABEL[conditions[k]]}
        </StatusPill>
      ))}
    </div>
  );
}

function PaymentAllocationReportView({
  clientSlug,
  initial,
}: {
  clientSlug: string;
  initial: PaymentAllocationReadResult;
}) {
  const [preset, setPreset] = useState<ReportPreset>("this_month");
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

  const report: PaymentAllocationReport | null = data.report;
  const nameById = new Map<string, string>(data.practitioners.map((pr) => [pr.id, pr.name]));
  const clinicianName = (id: string | null) => (id === null ? "Unattributed" : nameById.get(id) ?? id);

  const missing = report ? unverifiedConditions(report.conditions) : [];

  return (
    <SectionCard
      title="Payment allocation, by practitioner"
      description="The report you pay dentists from asks four things at once — completed, closed, invoiced, paid. This shows what the data can and, honestly, cannot confirm."
      actions={<PeriodBar presets={PAY_PRESETS} value={preset} onChange={choose} disabled={loading} />}
    >
      <div className="space-y-4">
        <Warning>
          <span className="font-semibold">This is not the pay-the-dentists figure, and must not be used as one.</span>{" "}
          Paying a dentist needs four facts joined — the treatment completed, the course closed, an
          invoice generated, and the patient paid. Dentally holds that join in its Payment Allocations
          report; it is not exposed on the API this platform reads. What is shown below is{" "}
          <span className="font-semibold">payments received, grouped by the practitioner recorded on
          each payment</span> — which gates on none of those four conditions. Every line states which
          conditions cannot be confirmed.
        </Warning>

        {report && missing.length > 0 ? (
          <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5 text-[12px] text-muted">
            <p className="font-semibold text-navy">What cannot be confirmed from the wired data:</p>
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
                  {formatPenceGbp(report.totalPence)}
                </p>
                <p className="text-[12px] text-muted">
                  received across {report.totalCount} payment{report.totalCount === 1 ? "" : "s"},{" "}
                  {windowText(data.window)}
                </p>
              </div>
              <p className="text-[11.5px] text-faint">{loading ? "Loading…" : null}</p>
            </div>

            {data.multiSite ? (
              <p className="text-[11.5px] text-faint">
                Showing all sites in view. A payment&rsquo;s practitioner is the one on the payment
                record, which need not be the clinician who did the work.
              </p>
            ) : null}

            {report.lines.length === 0 ? (
              <Unavailable reason="No payments received in this period." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left">
                      <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Clinician (on payment)</th>
                      <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Received</th>
                      <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Payments</th>
                      <th className="px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Allocation conditions</th>
                      <th className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-[0.04em] text-faint">Payable?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.lines.map((line) => (
                      <tr key={line.practitionerId ?? "none"} className="border-b border-line last:border-0 align-top">
                        <td className="px-3 py-3 text-left font-medium text-navy">{clinicianName(line.practitionerId)}</td>
                        <td className="px-3 py-3 text-right tabular-nums font-semibold text-ink">{formatPenceGbp(line.paymentsReceivedPence)}</td>
                        <td className="px-3 py-3 text-right tabular-nums text-muted">{line.paymentCount}</td>
                        <td className="px-3 py-3"><ConditionChips conditions={line.conditions} /></td>
                        <td className="px-3 py-3 text-right">
                          <StatusPill tone={line.payableConfirmed ? "success" : "danger"}>
                            {line.payableConfirmed ? "Confirmed" : "Cannot confirm"}
                          </StatusPill>
                        </td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-line-strong bg-card-muted/40 font-semibold">
                      <td className="px-3 py-2 text-left text-navy">Total received</td>
                      <td className="px-3 py-2 text-right tabular-nums text-navy">{formatPenceGbp(report.totalPence)}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{report.totalCount}</td>
                      <td className="px-3 py-2" />
                      <td className="px-3 py-2" />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {report.deletedExcluded > 0 || report.unattributedExcluded > 0 ? (
              <p className="text-[11.5px] text-faint">
                {report.deletedExcluded > 0 ? `${report.deletedExcluded} voided payment(s) excluded. ` : ""}
                {report.unattributedExcluded > 0
                  ? `${report.unattributedExcluded} payment(s) with no site excluded from this site's total.`
                  : ""}
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

// === The two-tab wrapper =====================================================

export function FlagshipReports({
  clientSlug,
  nhs,
  pay,
}: {
  clientSlug: string;
  nhs: NhsBandReadResult;
  pay: PaymentAllocationReadResult;
}) {
  const [tab, setTab] = useState<"nhs" | "pay">("nhs");
  return (
    <div className="space-y-5">
      <div role="tablist" className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
        <TabButton active={tab === "nhs"} onClick={() => setTab("nhs")} icon={<Activity size={15} />}>
          NHS activity
        </TabButton>
        <TabButton active={tab === "pay"} onClick={() => setTab("pay")} icon={<Banknote size={15} />}>
          Payment allocation
        </TabButton>
      </div>
      {tab === "nhs" ? (
        <NhsActivityReport clientSlug={clientSlug} initial={nhs} />
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
