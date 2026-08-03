import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Download, Search } from "lucide-react";
import { DataTable, StatusPill, type Column } from "@/components/primitives";
import { CANNOT_READ_COPY, CHART_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { groupByPlan, historyLines, type HistoryLine } from "@/lib/charting/history";
import { toCsv, exportFilename } from "@/lib/charting/export-csv";
import type { ChartItem, ChartReadHealth, PlanRow } from "@/lib/charting/types";
import { londonDateLabel } from "@/lib/time/london";
import { cn, gbp } from "@/lib/utils";

/**
 * History, opened from the bottom-right control cluster: the full list of this
 * patient's treatment items, filterable, searchable, expandable and exportable, as
 * DENTALLY.md:110 describes it.
 *
 * IT COMPUTES NOTHING. Every line comes from A-logic's historyLines/groupByPlan and
 * every exported byte from toCsv, all of them .ts modules vitest can collect. A sort
 * rule or a CSV escape written into this .tsx would be a rule with no test.
 *
 * THE TP: BUTTON SELECTS, IT DOES NOT NAVIGATE. Dentally's own line carries a
 * `TP: ****` button that opens that plan. We have no plan-detail route, so it selects
 * the plan in the tabs beneath the chart and filters the arch to it. A dead link
 * would be worse than an in-place selection, and inventing a route to nowhere worse
 * still.
 *
 * EXPORT IS LIVE, and it is the one History capability entirely ours to build: every
 * row is already on the client, a Blob touches no Dentally endpoint, no table and no
 * migration. It exports exactly what the filters currently show, which the button
 * says, because an export that quietly differs from the screen it was taken from is
 * a document somebody will later rely on.
 *
 * THREE THINGS THAT MUST NOT BE INVISIBLE HERE, because History is where a reader
 * comes to reconcile against Dentally:
 *   - a FAILED items read renders the failed sentence, never an empty table: "we
 *     could not read this" and "this patient has no treatment items" are different
 *     clinical statements;
 *   - UNPLACED items (a teeth value the parser could not read) are their own group
 *     with the raw value shown, so nothing is silently dropped;
 *   - OFF-ARCH items (the other dentition) are another, so a mixed-dentition child's
 *     other arch is never gone without a word.
 */

const PLAN_STATUS_LABEL: Record<PlanRow["status"], string> = {
  accepted: "Accepted",
  unaccepted: "Not accepted",
  completed: "Completed",
};

export function ChartHistory({
  items,
  unplaced,
  offArch,
  plans,
  health,
  activePlanId,
  onSelectPlan,
  patientId,
  fetchedAt,
  className,
}: {
  items: ChartItem[];
  /** Rows whose teeth value would not parse. Never dropped, always counted. */
  unplaced: ChartItem[];
  /** Rows on the dentition not currently drawn on the arch. */
  offArch: ChartItem[];
  plans: PlanRow[];
  health: ChartReadHealth;
  activePlanId: string | null;
  onSelectPlan: (planId: string | null) => void;
  patientId: string;
  /** Captured at fetch time by the read, not at render time. Stamps the export. */
  fetchedAt: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [completedOnly, setCompletedOnly] = useState(false);
  const [includeUnplaced, setIncludeUnplaced] = useState(true);
  const [grouped, setGrouped] = useState(false);
  // KEYED ON THE ITEM ID, not on the row index. An index is a position in the
  // CURRENTLY FILTERED list, so typing in the search box or toggling "Completed
  // only" re-indexed every row and the open detail panel jumped to a different
  // treatment: the reader is then looking at one line's detail under another
  // line's name.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const failed = health.items === "failed";

  // `plans` IS PART OF THE FILTER, and leaving it out was a real defect rather
  // than an omission of convenience. HistoryFilter.plans is optional, so tsc
  // stayed silent, historyLines fell back to [], and every line resolved
  // planLabel: null and planStatus: null. An unaccepted crown then printed "Plan
  // status: Not on a plan", exported with an empty Plan status column, and could
  // not be found by searching for the plan's name: the exact distinction that
  // plan-tabs and the unaccepted surface origin exist to preserve, dropped in
  // the one place a reader goes to check it.
  const filters = useMemo(
    () => ({ query, planId: activePlanId, completedOnly, includeUnplaced, plans }),
    [query, activePlanId, completedOnly, includeUnplaced, plans],
  );

  const lines = useMemo(() => historyLines(items, filters), [items, filters]);
  const planGroups = useMemo(() => (grouped ? groupByPlan(items, plans) : []), [grouped, items, plans]);
  const planLabel = (planId: string | null) =>
    planId === null ? null : plans.find((p) => p.id === planId)?.label ?? planId;

  // The export carries whatever the filters currently show. toCsv emits its own BOM
  // and its own as-of header row, so nothing is added to the string here - but the
  // stamp has to be HANDED to it. Called with one argument it defaulted to "", and
  // every exported chart went out with a blank as-of row: export-csv.ts's own
  // header says an undated exported chart claims the present tense forever.
  const download = () => {
    const blob = new Blob([toCsv(lines, fetchedAt)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFilename(patientId, fetchedAt);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const columns: Column<{ line: HistoryLine }>[] = [
    {
      key: "expand",
      header: "",
      className: "w-[26px] px-1",
      cell: ({ line }) => {
        const open = expanded.has(line.itemId);
        return (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? "Hide the detail of this line" : "Show the detail of this line"}
            onClick={() =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(line.itemId)) next.delete(line.itemId);
                else next.add(line.itemId);
                return next;
              })
            }
            className="rounded-md p-[2px] text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}
          </button>
        );
      },
    },
    {
      key: "date",
      header: "Date",
      className: "whitespace-nowrap",
      cell: ({ line }) =>
        line.date ? (
          <span className="tabular-nums text-[12px] text-ink">{londonDateLabel(line.date)}</span>
        ) : (
          // A dash, never a date we do not have: an invented date on a clinical line
          // is a claim about when treatment happened.
          <span className="text-faint" title="No date on this item">
            -
          </span>
        ),
    },
    {
      key: "tooth",
      header: "Tooth",
      className: "whitespace-nowrap",
      cell: ({ line }) => (
        <span className="text-[12px] text-ink">
          <span className="font-medium">{line.toothLabel}</span>{" "}
          {/* The two-digit FDI number is printed beside the label because reconciling
              against Dentally, which prints the number, is this screen's purpose. */}
          <span className="tabular-nums text-faint">{line.fdiLabel}</span>
        </span>
      ),
    },
    {
      key: "surfaces",
      header: "Surfaces",
      // "Whole tooth" is printed ONLY for a row that named no surface at all.
      // A row whose surface value we could not place (Dentally sends numeric
      // indices, and we do not guess which region each index is) is a different
      // fact, and printing "Whole tooth" beside it said an extraction where
      // Dentally holds a filling.
      cell: ({ line }) => (
        <span className="text-[12px] tabular-nums text-ink">
          {line.surfaces || (line.wholeTooth ? <span className="text-faint">Whole tooth</span> : null)}
          {/* DENTALLY'S OWN NUMBERS, printed verbatim and never translated into a
              surface name: which anatomical surface each index is depends on how
              Dentally orients the quadrant and nothing public says. This column was
              EMPTY on every row of a real patient's history before this, because
              `surfaces` is a letter code and live Dentally sends none. */}
          {line.surfaceIndices.length > 0 ? (
            <span
              className="ml-1 text-muted"
              title="Dentally's own surface numbers for this row, shown as sent"
            >
              {line.surfaceIndices.join(" ")}
            </span>
          ) : null}
          {line.unrecognisedSurfaces.length > 0 ? (
            <span
              className="ml-1 text-status-amber"
              title="Surface values we could not place on the tooth diagram, shown as Dentally sent them"
            >
              {line.unrecognisedSurfaces.join(" ")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "treatment",
      header: "Treatment",
      cell: ({ line }) => (
        <div className="min-w-0">
          <span className="text-[12.5px] text-ink">{line.nomenclature ?? <span className="text-faint">-</span>}</span>
          {expanded.has(line.itemId) ? (
            <dl className="mt-1 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-[2px] text-[11px] leading-[1.45]">
              <dt className="text-faint">Plan status</dt>
              <dd className="text-muted">{line.planStatus ? PLAN_STATUS_LABEL[line.planStatus] : "Not on a plan"}</dd>
              <dt className="text-faint">Surfaces as sent</dt>
              <dd className="text-muted">
                {line.surfaces || line.surfaceIndexText || "none"}
                {line.unrecognisedSurfaces.length > 0 ? ` plus ${line.unrecognisedSurfaces.join(", ")}` : ""}
              </dd>
              <dt className="text-faint">Charged</dt>
              <dd className="text-muted">{gbp(line.price)}</dd>
            </dl>
          ) : null}
        </div>
      ),
    },
    {
      key: "plan",
      header: "Plan",
      cell: ({ line }) => {
        const label = planLabel(line.planId);
        if (line.planId === null) return <span className="text-[11.5px] text-faint">Not on a plan</span>;
        return (
          <button
            type="button"
            onClick={() => onSelectPlan(line.planId)}
            title={`Show only ${label} on the chart`}
            className={cn(
              "max-w-[170px] truncate rounded-md border px-1.5 py-[1px] text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
              line.planId === activePlanId
                ? "border-navy bg-navy text-white"
                : "border-line-strong bg-card text-muted hover:text-navy",
            )}
          >
            TP: {label}
          </button>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      cell: ({ line }) => (
        <StatusPill tone={line.completed ? "success" : "neutral"}>{line.completed ? "Completed" : "Planned"}</StatusPill>
      ),
    },
    {
      key: "price",
      header: "Price",
      align: "right",
      cell: ({ line }) => <span className="tabular-nums text-[12px] text-ink">{gbp(line.price)}</span>,
    },
  ];

  const rows = lines.map((line) => ({ line }));

  return (
    <section aria-label="Chart history" className={cn("space-y-2.5", className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line pb-2">
        <h3 className="text-[13.5px] font-semibold tracking-[-0.1px] text-navy">History</h3>
        <span className="tabular-nums text-[11.5px] text-faint">
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>

        <div className="relative ml-auto w-[220px]">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this history"
            aria-label="Search this patient's chart history"
            className="w-full rounded-md border border-line-strong bg-card py-[3px] pl-7 pr-2 text-[12px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </div>

        <Toggle checked={completedOnly} onChange={setCompletedOnly} label="Completed only" />
        {/* The flag reaches items that name NO tooth - an examination, a
            radiograph, a hygiene appointment - which the read now keeps in
            `items` rather than filing under "could not place". Labelled for what
            it actually does, since as "Include unplaced" it named a group this
            toggle has never been able to reach. */}
        <Toggle
          checked={includeUnplaced}
          onChange={setIncludeUnplaced}
          label="Include items with no tooth"
        />
        <Toggle checked={grouped} onChange={setGrouped} label="Group by plan" />

        <button
          type="button"
          onClick={download}
          title={CHART_COPY.historyExport}
          className="pressable inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line-strong bg-card px-2 py-[3px] text-[11.5px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <Download size={13} aria-hidden />
          Export
        </button>
      </div>

      {/* One quiet line, once, so nobody reads this as Dentally's full clinical
          history. It is the treatment items and nothing else. */}
      <p className="text-[11px] leading-[1.45] text-faint">{CANNOT_READ_COPY.chartHistoryScope}</p>

      {failed ? (
        <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2.5 text-[12.5px] text-ink">
          {FAILED_COPY.chartItems}
        </p>
      ) : grouped ? (
        <div className="space-y-4">
          {planGroups.map((group) => {
            const groupLines = historyLines(group.items, filters);
            return (
              <div key={group.planId ?? "unattached"} className="space-y-1.5">
                <h4 className="flex items-baseline gap-2 border-b border-line pb-1 text-[12px] font-semibold text-navy">
                  {group.label}
                  <span className="tabular-nums text-[11px] font-normal text-faint">{groupLines.length}</span>
                </h4>
                <DataTable
                  columns={columns}
                  rows={groupLines.map((line) => ({ line }))}
                  getRowKey={(row) => `${group.planId ?? "unattached"}-${row.line.itemId}`}
                  empty={<p className="px-1 py-2 text-[12px] text-muted">No lines on this plan match these filters.</p>}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(row) => row.line.itemId}
          empty={
            <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-[12.5px] text-muted">
              {items.length === 0 ? EMPTY_COPY.chartItems : "No lines match these filters."}
            </p>
          }
        />
      )}

      <RawGroup
        title="Items we could not place on a tooth"
        note={CHART_COPY.unplaced}
        items={unplaced}
        showRawTeeth
      />
      <RawGroup title="Items on the other dentition" note={CHART_COPY.offArch} items={offArch} />
    </section>
  );
}

/** A dense inline toggle for the History filter row. Label first, state visible. */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "pressable shrink-0 rounded-md border px-2 py-[3px] text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        checked ? "border-navy bg-navy text-white" : "border-line-strong bg-card text-muted hover:text-navy",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The two groups that exist so nothing is silently dropped: rows whose teeth value
 * would not parse, and rows on the dentition the arch is not currently drawing. Both
 * render the item as Dentally sent it rather than an interpretation of it, because
 * the whole reason they are here is that our reading of them failed.
 *
 * Rendered ONLY when non-empty: an always-present empty group would be furniture, and
 * the always-visible status bar above the arch already carries the counts.
 */
function RawGroup({
  title,
  note,
  items,
  showRawTeeth = false,
}: {
  title: string;
  note: string;
  items: ChartItem[];
  showRawTeeth?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section className="space-y-1.5">
      <h4 className="flex items-baseline gap-2 border-b border-line pb-1 text-[12px] font-semibold text-navy">
        {title}
        <span className="tabular-nums text-[11px] font-normal text-faint">{items.length}</span>
      </h4>
      <p className="text-[11px] leading-[1.45] text-faint">{note}</p>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-[5px]">
            <span className="text-[12.5px] text-ink">{item.nomenclature ?? "-"}</span>
            <span className="tabular-nums text-[11.5px] text-muted">
              {showRawTeeth ? `Teeth as sent: ${item.rawTeeth || "none"}` : item.teeth.join(", ")}
            </span>
            {item.rawSurfaces ? (
              <span className="tabular-nums text-[11.5px] text-muted">Surfaces: {item.rawSurfaces}</span>
            ) : null}
            <span className="text-[11.5px] text-faint">{item.completed ? "Completed" : "Planned"}</span>
            <span className="ml-auto tabular-nums text-[11.5px] text-ink">{gbp(item.price)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
