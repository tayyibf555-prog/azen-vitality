import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { fdiLabel, toothLabel } from "@/lib/charting/fdi";
import { toothHistory } from "@/lib/charting/history";
import { londonDateLabel } from "@/lib/time/london";
import { gbp } from "@/lib/utils";
import type { ChartItem, PlanRow } from "@/lib/charting/types";

/**
 * ONE TOOTH'S HISTORY, on hover AND on focus.
 *
 * FOCUS TOO, NOT HOVER ONLY. The arch is a roving tabindex, so a keyboard reader can
 * land on a tooth; if this opened on hover alone they would reach it and learn
 * nothing, which makes the whole keyboard route decorative.
 *
 * IT IS DOCKED BENEATH THE ARCH, NOT FLOATED OVER IT, and that is a deliberate
 * departure from a hover tooltip. The arch keeps its own overflow-x:auto container so
 * a 32-tooth chart never shrinks its teeth below a hittable size on a practice
 * laptop, and an absolutely-positioned card inside a scroll container is clipped by
 * it. Docked, it can never cover the hovered tooth, can never cover the opposite row,
 * and never clips. It is also denser, which is the house preference.
 *
 * THREE STATES, NEVER CONFLATED. A tooth with no items says so. A FAILED items read
 * says the read failed. And every rendering carries the scope line, so nobody reads
 * this as Dentally's full clinical history: it is what treatment_plan_items holds,
 * and Dentally's own history also carries base-chart changes, notes and perio.
 *
 * NO "use client": an undirected universal module under the workspace's boundary.
 */
export function ToothTooltip({
  fdi,
  items,
  plans,
  itemsFailed,
}: {
  /** null when nothing is hovered or focused: the panel keeps its place and says so,
   *  rather than collapsing and moving the arch under the cursor. */
  fdi: number | null;
  items: ChartItem[];
  plans: PlanRow[];
  itemsFailed: boolean;
}) {
  const lines = fdi === null || itemsFailed ? [] : toothHistory(items, fdi, plans);

  return (
    <section
      aria-live="polite"
      className="min-h-[104px] rounded-lg border border-line bg-card px-3 py-2.5"
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-1.5">
        <h4 className="text-[12.5px] font-semibold tracking-[-0.1px] text-navy">
          {fdi === null ? "Tooth history" : `${toothLabel(fdi)} - tooth ${fdiLabel(fdi)}`}
        </h4>
        <span className="text-[11px] text-faint">
          {fdi === null ? "Hover or focus a tooth" : `${lines.length} item${lines.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {fdi === null ? (
        <p className="pt-2 text-[11.5px] leading-[1.45] text-faint">
          {CANNOT_READ_COPY.chartHistoryScope}
        </p>
      ) : itemsFailed ? (
        <p className="pt-2 text-[12px] leading-[1.45] text-ink">{FAILED_COPY.chartItems}</p>
      ) : lines.length === 0 ? (
        <p className="pt-2 text-[12px] leading-[1.45] text-muted">{EMPTY_COPY.chartItems}</p>
      ) : (
        <ul className="divide-y divide-line/70">
          {lines.map((line) => (
            <li key={line.itemId} className="flex items-baseline gap-2 py-[5px] text-[12px]">
              <span className="w-[68px] shrink-0 tabular-nums text-faint">
                {line.date ? londonDateLabel(line.date) : "No date"}
              </span>
              {/* The letter code where we have one, and otherwise Dentally's own
                  surface NUMBERS, which is the only form live data sends. Printing
                  "-" for a real filling told the clinician hovering the tooth that
                  Dentally records no surface for it. */}
              <span
                className="w-[46px] shrink-0 font-semibold tabular-nums text-navy"
                title={line.surfaceIndexText || undefined}
              >
                {line.surfaces || line.surfaceIndices.join(" ") || "-"}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink" title={line.nomenclature ?? ""}>
                {line.nomenclature ?? "Treatment not named"}
                {/* An unrecognised surface letter is SHOWN, not swallowed. A letter we
                    do not know is a finding we cannot place, and the alternative is
                    dropping it silently at the mapper. */}
                {line.unrecognisedSurfaces.length > 0 ? (
                  <span className="ml-1.5 text-faint">
                    (unrecognised: {line.unrecognisedSurfaces.join(", ")})
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] text-muted">
                {line.completed ? "Completed" : planWord(line.planStatus)}
              </span>
              <span className="w-[52px] shrink-0 text-right tabular-nums text-muted">
                {gbp(line.price)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {fdi !== null ? (
        <p className="mt-2 border-t border-line pt-1.5 text-[11px] leading-[1.45] text-faint">
          {CANNOT_READ_COPY.chartHistoryScope}
        </p>
      ) : null}
    </section>
  );
}

/** An item on a plan the patient never accepted is not the same clinical statement as
 *  one on the live plan, so it is never rendered with the same word. */
function planWord(status: PlanRow["status"] | null): string {
  if (status === "unaccepted") return "Plan not accepted";
  if (status === "completed") return "Plan completed";
  if (status === "accepted") return "Planned";
  return "No plan";
}
