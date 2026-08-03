import { StatusPill, type Tone } from "@/components/primitives";
import { formatPenceGbp } from "@/lib/dashboard/money";
import {
  allocationBucketRows,
  attributedShare,
  runChainRate,
  type AllocationReport,
} from "@/lib/reports/allocation-report";
import { ALLOCATION_BASIS_CHIP, type AllocationBasis } from "@/lib/reports/allocation-split";
import {
  CALIBRATION_BANNER_SEGMENTS,
  mayClaimTreatingClinician,
} from "@/lib/reports/allocation-calibration";
import {
  ALLOCATION_CONDITION_LABELS,
  type AllocationConditions,
  type Verify,
} from "@/lib/reports/payment-allocation";

// ---------------------------------------------------------------------------
// PRESENTATION ONLY. Every figure, label and predicate on this screen is
// computed and tested in src/lib/reports/*.ts; nothing here adds a number, a
// percentage or a claim of its own.
//
// The buckets are ROWS IN THE SAME TABLE as the clinicians, deliberately. Blerta
// has to see the whole reconcile — the money that reached a clinician and the
// money that could not — on one surface, or this is not the thing she pays from.
// ---------------------------------------------------------------------------

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

function BasisChips({ bases }: { bases: AllocationBasis[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {bases.map((b) => (
        <StatusPill key={b} tone="neutral">
          {ALLOCATION_BASIS_CHIP[b]}
        </StatusPill>
      ))}
    </div>
  );
}

/**
 * The header banner's words, for the caller's Warning box: always on, never
 * dismissible. The wording lives in allocation-calibration.ts and is asserted
 * there — this only applies emphasis.
 */
export function CalibrationBannerText() {
  return (
    <>
      {CALIBRATION_BANNER_SEGMENTS.map((segment, i) =>
        segment.emphasis === "strong" ? (
          <span key={i} className="font-semibold">
            {segment.text}
          </span>
        ) : segment.emphasis === "em" ? (
          <em key={i}>{segment.text}</em>
        ) : segment.emphasis === "code" ? (
          <code key={i} className="rounded bg-black/5 px-1 font-mono text-[11.5px]">
            {segment.text}
          </code>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/**
 * THIS RUN's own coverage, next to the calibration banner. The constants describe
 * the method; this describes the period in front of the reader.
 */
export function RunCoverage({ report, windowText }: { report: AllocationReport; windowText: string }) {
  const share = attributedShare(report);
  const chain = runChainRate(report);
  return (
    <div className="rounded-lg border border-line bg-card-muted/40 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink">
      <p>
        <span className="font-semibold tabular-nums text-navy">
          {formatPenceGbp(report.attributedPence)}
        </span>{" "}
        of{" "}
        <span className="font-semibold tabular-nums text-navy">
          {formatPenceGbp(report.totalReceivedPence)}
        </span>{" "}
        {share === null ? "" : <>({(share * 100).toFixed(1)}%) </>}
        {mayClaimTreatingClinician(chain)
          ? "attributed to the treating clinician on the invoice"
          : "attributed to a clinician"}{" "}
        in {windowText}. The rest is listed, row by row, underneath.
      </p>
      {chain === null ? null : (
        <p className="mt-1 text-[11.5px] text-muted">
          {report.legsChainResolved} of {report.legCount} allocations in this period reached the
          invoice lines ({(chain * 100).toFixed(1)}%).
          {report.runIncomplete
            ? ` ${report.legsLinkUnavailable} could not be read from Dentally on this run, so this run is incomplete.`
            : ""}
        </p>
      )}
      {report.paymentTakerDifferedCount > 0 ? (
        <p className="mt-1 text-[11.5px] text-muted">
          {report.paymentTakerDifferedCount} payment
          {report.paymentTakerDifferedCount === 1 ? " was" : "s were"} taken by a different person
          than the clinician credited. The money follows the clinician on the invoice line.
        </p>
      ) : null}
      {report.sundryLineCount > 0 ? (
        <p className="mt-1 text-[11.5px] text-muted">
          {report.sundryLineCount} sundry line{report.sundryLineCount === 1 ? "" : "s"} appeared on
          the invoices read. No sundry line was seen when this was calibrated, so that path is
          untested — check these by hand.
        </p>
      ) : null}
    </div>
  );
}

const HEAD = [
  "Clinician (on the invoice line)",
  "Attributed",
  "Allocations",
  "How it was derived",
  "Allocation conditions",
  "Payable?",
];

export function AllocationTable({
  report,
  clinicianName,
}: {
  report: AllocationReport;
  clinicianName: (id: string) => string;
}) {
  const buckets = allocationBucketRows(report);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            {HEAD.map((h, i) => (
              <th
                key={h}
                className={`px-3 py-2 text-[11px] font-medium uppercase tracking-[0.04em] text-faint ${i === 1 || i === 2 || i === 5 ? "text-right" : "text-left"}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {report.lines.map((line) => (
            <tr key={line.practitionerId} className="border-b border-line align-top">
              <td className="px-3 py-3 text-left font-medium text-navy">
                {clinicianName(line.practitionerId)}
              </td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-ink">
                {formatPenceGbp(line.attributedPence)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums text-muted">{line.legCount}</td>
              <td className="px-3 py-3">
                <BasisChips bases={line.bases} />
              </td>
              <td className="px-3 py-3">
                <ConditionChips conditions={line.conditions} />
              </td>
              <td className="px-3 py-3 text-right">
                <StatusPill tone={line.payableConfirmed ? "success" : "danger"}>
                  {line.payableConfirmed ? "Confirmed" : "Not confirmed"}
                </StatusPill>
              </td>
            </tr>
          ))}

          {/* The honesty buckets. Same table, never a footnote. */}
          {buckets.map((bucket) => (
            <tr key={bucket.key} className="border-b border-line bg-card-muted/30 align-top">
              <td className="px-3 py-3 text-left" colSpan={1}>
                <span className="font-medium text-ink">{bucket.label}</span>
              </td>
              <td className="px-3 py-3 text-right font-semibold tabular-nums text-ink">
                {formatPenceGbp(bucket.pence)}
              </td>
              <td className="px-3 py-3" />
              <td className="px-3 py-3 text-[11.5px] leading-relaxed text-muted" colSpan={2}>
                {bucket.note}
              </td>
              <td className="px-3 py-3 text-right">
                <StatusPill tone="neutral">No clinician</StatusPill>
              </td>
            </tr>
          ))}

          <tr className="border-t-2 border-line-strong bg-card-muted/40 font-semibold">
            <td className="px-3 py-2 text-left text-navy">Total received</td>
            <td className="px-3 py-2 text-right tabular-nums text-navy">
              {formatPenceGbp(report.totalReceivedPence)}
            </td>
            <td className="px-3 py-2 text-right tabular-nums text-muted">{report.totalCount}</td>
            <td className="px-3 py-2" colSpan={3} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The counts that never belong inside a money row. */
export function AllocationDisclosures({
  report,
  droppedPayments,
  invoicesRead,
  invoicesRequested,
  invoicesUnreadable,
}: {
  report: AllocationReport;
  droppedPayments: number;
  invoicesRead: number;
  invoicesRequested: number;
  invoicesUnreadable: number;
}) {
  const notes: string[] = [];
  if (report.deletedExcluded > 0) {
    notes.push(`${report.deletedExcluded} voided payment(s) excluded from every figure.`);
  }
  if (report.unattributedExcluded > 0) {
    notes.push(`${report.unattributedExcluded} payment(s) with no site excluded from this site's total.`);
  }
  if (report.refundCount > 0) {
    notes.push(`${report.refundCount} refund(s) included — they reduce the clinician's line, as they should.`);
  }
  if (droppedPayments > 0) {
    notes.push(`${droppedPayments} payment(s) could not be read and were excluded, not counted as zero.`);
  }
  if (invoicesRequested > 0) {
    notes.push(
      `${invoicesRead} of ${invoicesRequested} invoices read live for this period${invoicesUnreadable > 0 ? `; ${invoicesUnreadable} could not be read` : ""}.`,
    );
  }
  if (notes.length === 0) return null;
  return <p className="text-[11.5px] text-faint">{notes.join(" ")}</p>;
}
