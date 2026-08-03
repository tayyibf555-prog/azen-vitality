import { RefreshCw } from "lucide-react";
import { CHART_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { londonDateTimeLabel } from "@/lib/time/london";
import { num } from "@/lib/utils";
import type { ChartReadHealth, ChartRejectionEvent } from "@/lib/charting/types";

/**
 * THE ALWAYS-VISIBLE LINE ABOVE THE ARCH. It exists because five separate honesty
 * signals had nowhere to render: a failed items read, a failed treatments or plans
 * read, a truncated page walk, items whose teeth would not parse, and items on the
 * dentition not currently drawn. Every one of them was a flag on a type with no
 * renderer, which is the same failure as a tested copy key nobody puts on a screen.
 *
 * QUIET GREY, NEVER AMBER, NEVER A ROW OF CHIPS. PRODUCT.md counted 21 micro-labels
 * and five caveat chips on a screen that held no more data than Dentally's one line
 * of grey text, and the owner's verdict was that ours looked worse. So: one line,
 * left to right, only the parts that apply, in the same type as everything else.
 * Amber is for warnings; a page ceiling is not a warning.
 *
 * THE AS-OF LINE IS THE CHEAPEST HONESTY ON THE SCREEN. There are no treatment
 * webhooks in Dentally, so a chart left open on a surgery screen while a nurse charts
 * next door would otherwise assert a present tense it cannot support, forever. One
 * timestamp and a Refresh button beats polling a clinical screen, and it is the
 * precedent already set elsewhere in the record.
 *
 * IT ALSO CARRIES THE aria-live REGION for rejected clicks. Keyed on the rejection
 * nonce, so two identical consecutive rejections are distinct states and the second
 * one is re-announced rather than going quiet.
 *
 * NO "use client": rendered from chart-workspace.tsx, which owns the boundary.
 */
export function ChartStatusBar({
  fetchedAt,
  health,
  truncated,
  truncatedCatalogue,
  itemCount,
  unplacedCount,
  offArchCount,
  unreadSurfaceCount,
  lastRejection,
  onRefresh,
}: {
  /** Captured at FETCH time inside the read, not at render time, so this is honest
   *  to within the read rather than to within the render. */
  fetchedAt: string;
  health: ChartReadHealth;
  /** THIS PATIENT'S chart hit its page ceiling. */
  truncated: boolean;
  /** The practice-wide treatment list did. A separate sentence, because one
   *  shared flag put "may not be the whole of this patient's chart" on every
   *  patient of any practice with more than five hundred treatments. */
  truncatedCatalogue: boolean;
  /** Items actually drawable in the current view. Only used to decide whether the
   *  category A empty sentence applies, and only when the read SUCCEEDED. */
  itemCount: number;
  unplacedCount: number;
  offArchCount: number;
  /** Items naming a surface value we could not place on the tooth diagram. They
   *  are neither whole-tooth nor unplaced, so without this line they are the one
   *  finding on the screen with no count anywhere. */
  unreadSurfaceCount: number;
  lastRejection: ChartRejectionEvent | null;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-1 pb-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-[1.45] text-faint">
        {/* The as-of stamp is a LABEL plus a time; CHART_COPY.staleness is the
            sentence that says what it means, and it is rendered rather than hidden in
            a title attribute, because a title is not reachable by keyboard and is not
            dependably announced. Both are quiet grey, which is the PRODUCT.md
            precedent: Dentally's own equivalent is one line of grey text. */}
        <span className="tabular-nums">Chart read {londonDateTimeLabel(fetchedAt)}</span>
        <button
          type="button"
          onClick={onRefresh}
          className="pressable inline-flex items-center gap-1 rounded-md px-1.5 py-[1px] text-[11px] font-medium text-blue-deep hover:bg-tint-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <RefreshCw size={11} aria-hidden />
          Refresh
        </button>
        <span>{CHART_COPY.staleness}</span>

        {/* Each read has its OWN flag and its OWN sentence. "We could not read the
            chart" and "we could not read the treatment list" are different facts and
            gating either behind the other hides one of them. */}
        {health.items === "failed" ? <Line strong>{FAILED_COPY.chartItems}</Line> : null}
        {health.treatments === "failed" ? <Line strong>{FAILED_COPY.treatments}</Line> : null}
        {health.plans === "failed" ? <Line strong>{FAILED_COPY.plans}</Line> : null}

        {truncated ? <Line>{CHART_COPY.truncated}</Line> : null}
        {truncatedCatalogue ? <Line>{CHART_COPY.truncatedCatalogue}</Line> : null}
        {/* Not behind the History toggle. A finding the parser could not place, and a
            finding on the dentition we are not drawing, are both invisible on the
            arch; a count is the floor. */}
        {unplacedCount > 0 ? (
          <Line>
            {CHART_COPY.unplaced} ({num(unplacedCount)} items)
          </Line>
        ) : null}
        {offArchCount > 0 ? (
          <Line>
            {CHART_COPY.offArch} ({num(offArchCount)} items)
          </Line>
        ) : null}
        {unreadSurfaceCount > 0 ? (
          <Line>
            {CHART_COPY.unreadSurfaces} ({num(unreadSurfaceCount)} items)
          </Line>
        ) : null}

        {/* ONLY when the read succeeded. An outage must never be able to print a
            positive claim about a patient's chart. */}
        {health.items === "ok" &&
        itemCount === 0 &&
        unplacedCount === 0 &&
        offArchCount === 0 &&
        unreadSurfaceCount === 0 ? (
          <Line>{EMPTY_COPY.chartItems}</Line>
        ) : null}
      </div>

      {/* A click that silently does nothing trains people to click harder. */}
      <p
        key={lastRejection?.nonce}
        aria-live="polite"
        className="min-h-[15px] text-[11px] leading-[1.45] text-ink"
      >
        {lastRejection ? rejectionSentence(lastRejection) : ""}
      </p>
    </div>
  );
}

function Line({ children, strong }: { children: React.ReactNode; strong?: boolean }) {
  return <span className={strong ? "text-ink" : undefined}>{children}</span>;
}

/**
 * Why a click was refused, in words, with the tooth and surface named.
 *
 * These sentences live here rather than in lib/patient/tabs.ts on purpose: they are
 * INTERACTION feedback about what this screen just did, not claims about the patient
 * or about what Dentally holds. The moment one of them makes a claim about a record
 * it belongs in the tested copy module with the rest. The one exception is already
 * observed: "draft-disabled" is a statement about the connection, so it reads from
 * CHART_COPY.
 */
function rejectionSentence(r: ChartRejectionEvent): string {
  const where =
    r.tooth === null ? "" : ` on tooth ${r.tooth}${r.surface ? `, ${r.surface}` : ""}`;
  switch (r.reason) {
    case "draft-disabled":
      return CHART_COPY.draftDisabled;
    case "no-treatment-selected":
      return `Nothing was charted${where}: choose a treatment in the list first.`;
    case "no-first-surface":
      return `Nothing was charted${where}: a right click adds a further surface, so chart the first one with a left click.`;
    case "chart-locked":
      return `Nothing was charted${where}: the chart is locked in preferences.`;
    case "tooth-not-in-arch":
      return `Nothing was charted${where}: that tooth is not in the dentition currently shown.`;
    case "base-chart-is-read-only":
      return `Nothing was charted${where}: the base chart is read-only here.`;
    default:
      return `Nothing was charted${where}.`;
  }
}
