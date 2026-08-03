import { useMemo, useState } from "react";
import { ArrowDownAZ, ChevronDown, ChevronLeft, ChevronRight, LayoutTemplate, Search, Star } from "lucide-react";
import { CHART_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import {
  alphabetBuckets,
  bucketKeyOf,
  filterTreatments,
  treatmentKey,
} from "@/lib/charting/treatment-list";
import type {
  ChartPreferences,
  ChartReadHealth,
  Dentition,
  TreatmentCategoryRow,
  TreatmentRow,
} from "@/lib/charting/types";
import { cn, gbp } from "@/lib/utils";
import { AlphabetRail } from "./alphabet-rail";
import { DisabledControl } from "./disabled-control";

/**
 * The whole left panel of the charting screen, top to bottom exactly as
 * DENTALLY.md:93-99 orders it:
 *
 *   1. PD / DD / Base segmented control, the preferences chevron, the collapse control
 *   2. Treatment List / Plan Templates underline tabs
 *   3. The category filter, defaulting to All
 *   4. The search box with the sort button beside it
 *   5. The list: favourite star, code, name, alphabetical by default
 *   6. The 37-key alphabet rail down its right edge
 *
 * NOTHING IS FOLDED AWAY. Every control above is on the screen at once, because that
 * is what a Dentally user reaches for without looking and because PRODUCT.md's test
 * is whether this screen carries the same information as Dentally's, not whether it
 * is calmer than Dentally's.
 *
 * IT COMPUTES NOTHING. Filtering, ranking, sorting and bucketing all come from
 * A-logic's filterTreatments/alphabetBuckets/bucketKeyOf, which live in .ts files so
 * vitest can collect them. A ranking rule written into this .tsx would be a rule with
 * no test.
 *
 * SEGMENTED CONTROL: SegmentBtn and Segment are copied from calendar-board.tsx rather
 * than imported. They are module-private inside a file carrying "use client", and
 * importing from that module would drag the whole diary board into this graph; the
 * copy is deliberate and the two are kept identical by eye, as the blueprint states.
 *
 * NO "use client" HERE. This leaf attaches DOM handlers and takes function props, and
 * it inherits the boundary from chart-workspace.tsx, the one client file in the chart.
 * A directive here would make it a second boundary; rendering it from a server
 * component would build green and throw at render, which this repo has already paid
 * for once.
 */

function SegmentBtn({
  active,
  onClick,
  disabled = false,
  title,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      // aria-disabled, never the disabled attribute: Base is unreachable until base
      // chart mode is on, and a control removed from the tab order is a control whose
      // explanation a keyboard user can never read.
      aria-disabled={disabled ? "true" : undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "pressable rounded-md px-2.5 py-[3px] text-[11px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
        disabled
          ? "cursor-default text-line-strong"
          : active
            ? "bg-navy font-semibold text-white"
            : "text-muted hover:text-navy",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Segment({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex gap-0.5 rounded-lg border border-line-strong bg-card p-[2px]"
    >
      {children}
    </div>
  );
}

export function TreatmentPanel({
  treatments,
  categories,
  health,
  dentition,
  baseChartMode,
  onSetDentition,
  activeTreatment,
  onSelectTreatment,
  favourites,
  onToggleFavourite,
  preferences,
  onPreferencesChange,
  onOpenPreferences,
  className,
}: {
  treatments: TreatmentRow[];
  categories: TreatmentCategoryRow[];
  health: ChartReadHealth;
  dentition: Dentition;
  /** True once the Base Chart control in the bottom-right cluster has switched modes. */
  baseChartMode: boolean;
  onSetDentition: (dentition: Dentition) => void;
  activeTreatment: { code: string; name: string } | null;
  onSelectTreatment: (row: TreatmentRow) => void;
  /** Treatment ids the user has starred. A display preference, held by the workspace. */
  favourites: ReadonlySet<string>;
  onToggleFavourite: (treatmentId: string) => void;
  preferences: ChartPreferences;
  onPreferencesChange: (next: ChartPreferences) => void;
  /** Opens the ONE preferences menu, the same one the settings cog opens. */
  onOpenPreferences: () => void;
  className?: string;
}) {
  // Search, category and which of the two tabs is showing are view state of this
  // panel alone: they are not clinical, they are not persisted, and holding them here
  // keeps four more props off the workspace.
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [listTab, setListTab] = useState<"treatments" | "templates">("treatments");
  const [favouritesOnly, setFavouritesOnly] = useState(false);

  const failed = health.treatments === "failed";
  const writeBlocked = !canWriteChartToDentally();

  const rows = useMemo(
    () =>
      filterTreatments(treatments, {
        query,
        categoryId,
        favourites,
        favouritesOnly,
        favouritesFirst: preferences.favouritesFirst,
        sort: preferences.sort,
      }),
    [treatments, query, categoryId, favourites, favouritesOnly, preferences.favouritesFirst, preferences.sort],
  );

  // Counts are taken from the rows actually in the list, so a rail letter reports what
  // is under it now rather than what would be under it with the search cleared.
  const buckets = useMemo(() => alphabetBuckets(rows), [rows]);

  // DOM ids are keyed on the bucket's INDEX, not on its key: the favourites bucket's
  // key is a symbol and a rail that built ids out of it would produce ids the panel
  // could not reproduce. Both sides read the same array, so they cannot drift.
  const idFor = useMemo(() => {
    const index = new Map(buckets.map((b, i) => [b.key, i] as const));
    return (key: string) => `chart-treatment-group-${index.get(key) ?? 0}`;
  }, [buckets]);

  // Favourites lift out into their own leading group when the preference asks for it,
  // so the star rail key has something to jump to and the letter groups stay honest.
  const showFavouriteGroup = preferences.favouritesFirst || favouritesOnly;
  const favouriteRows = useMemo(
    () => (showFavouriteGroup ? rows.filter((r) => favourites.has(r.id)) : []),
    [showFavouriteGroup, rows, favourites],
  );
  const letterGroups = useMemo(() => {
    const rest = favouriteRows.length > 0 ? rows.filter((r) => !favourites.has(r.id)) : rows;
    const grouped = new Map<string, TreatmentRow[]>();
    for (const row of rest) {
      const key = bucketKeyOf(row);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(row);
      else grouped.set(key, [row]);
    }
    // Rendered in the rail's own order, so scanning the list and scanning the rail
    // give the same sequence.
    return buckets
      .map((bucket) => ({ bucket, rows: grouped.get(bucket.key) ?? [] }))
      .filter((group) => group.rows.length > 0);
  }, [buckets, rows, favouriteRows, favourites]);

  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? "All";

  if (preferences.panelCollapsed) {
    // Collapsed is Dentally's own control and it hides the LIST, never the fact that
    // there is one: the column stays, so the chart does not silently gain 400px with
    // no way back.
    //
    // ONE CIRCULAR CONTROL AND NOTHING ELSE, which is what the reference does: a
    // narrow rail carrying a round button with a right-pointing expand glyph, no
    // vertical label. 56px is between their ~62px and our old 44px and is the width a
    // 32px circle sits in without looking wedged; it matches the 56px grid track in
    // chart-workspace.tsx exactly, so the rail's right border IS the column edge.
    //
    // THE LABEL LEFT THE SCREEN, NOT THE ACCESSIBILITY TREE. Deleting the vertical
    // "Treatments" text would be a regression if it took the accessible name with it,
    // so the button keeps its aria-label verbatim ("Show the treatment list") and its
    // matching title, the aside keeps its own landmark label, and the glyph stays
    // aria-hidden so the name is the label alone rather than the label plus an icon.
    // It is a real <button>, so it is in the tab order, and focus-visible:ring is
    // carried here exactly as every other control on this screen carries it.
    return (
      <aside
        aria-label="Treatment list, collapsed"
        className={cn("flex w-[56px] shrink-0 flex-col items-center border-r border-line py-2", className)}
      >
        <button
          type="button"
          onClick={() => onPreferencesChange({ ...preferences, panelCollapsed: false })}
          title="Show the treatment list"
          aria-label="Show the treatment list"
          className="pressable grid size-8 place-items-center rounded-full border border-line-strong bg-card text-muted transition-colors hover:border-navy hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </aside>
    );
  }

  // THE ASIDE TAKES ITS TRACK'S WIDTH; IT DOES NOT RESTATE IT.
  //
  // This was `w-[400px]`, matching a `lg:grid-cols-[400px_…]` literal in
  // chart-workspace.tsx, and the pair had to be kept in step by comment. That is no
  // longer possible to do by hand: the track is now `clamp(300px,22.8%,400px)`, a value
  // that only exists at layout time, so any pixel width written here would be wrong at
  // every viewport except one — a track wider than its aside is dead air the reader sees
  // as a misalignment, and a narrower one clips the list.
  //
  // `w-full` is therefore not a shortcut, it is the correct expression of the rule: the
  // treatment list is exactly as wide as the column the workspace gives it, whatever
  // that column resolves to. Below `lg` there is no column and it goes full width, which
  // is also what a stacked layout should do — the old fixed 400px overflowed a phone.
  return (
    <aside
      aria-label="Treatment list"
      className={cn("flex w-full shrink-0 flex-col border-r border-line", className)}
    >
      {/* 1. Dentition, preferences chevron, collapse. */}
      <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Segment label="Dentition">
          <SegmentBtn active={dentition === "permanent"} onClick={() => onSetDentition("permanent")} title="Permanent dentition">
            PD
          </SegmentBtn>
          <SegmentBtn active={dentition === "deciduous"} onClick={() => onSetDentition("deciduous")} title="Deciduous dentition">
            DD
          </SegmentBtn>
          <SegmentBtn
            active={dentition === "base"}
            disabled={!baseChartMode}
            onClick={() => onSetDentition("base")}
            title={baseChartMode ? "Base chart" : "Base chart opens from the Base Chart control, lower right"}
          >
            Base
          </SegmentBtn>
        </Segment>
        <button
          type="button"
          onClick={onOpenPreferences}
          title="Chart preferences"
          aria-label="Chart preferences"
          className="pressable rounded-md p-1 text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <ChevronDown size={14} aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => onPreferencesChange({ ...preferences, panelCollapsed: true })}
          title="Collapse the treatment list"
          aria-label="Collapse the treatment list"
          className="pressable ml-auto rounded-md p-1 text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          <ChevronLeft size={14} aria-hidden />
        </button>
      </div>
      {!baseChartMode ? (
        <p className="border-b border-line px-2.5 py-1 text-[10.5px] leading-[1.4] text-faint">
          Base chart opens from the Base Chart control, lower right.
        </p>
      ) : null}

      {/* 2. Treatment List / Plan Templates. The underline strip is patient-tab-strip's
          idiom (-mb-px plus a transparent 2px border), which is Dentally's section
          convention and is deliberately not the filter-pill language used below it. */}
      <nav aria-label="Treatment list sections" className="border-b border-line px-2">
        <ul className="-mb-px flex gap-0.5">
          {(
            [
              { key: "treatments", label: "Treatment List" },
              { key: "templates", label: "Plan Templates" },
            ] as const
          ).map((tab) => {
            const active = listTab === tab.key;
            return (
              <li key={tab.key}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => setListTab(tab.key)}
                  className={cn(
                    "inline-block border-b-2 px-2.5 py-1.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                    active
                      ? "border-navy font-semibold text-navy"
                      : "border-transparent text-muted hover:border-line-strong hover:text-navy",
                  )}
                >
                  {tab.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {listTab === "templates" ? (
        <div className="space-y-2.5 px-2.5 py-3">
          <p className="text-[12px] leading-[1.5] text-muted">{CHART_COPY.planTemplates}</p>
          {writeBlocked ? (
            <DisabledControl
              id="chart-panel-select-template"
              label="Select template"
              icon={<LayoutTemplate size={14} aria-hidden />}
              reason={CHART_COPY.writeBlockedTitle}
            />
          ) : null}
        </div>
      ) : (
        <>
          {/* 3. Category filter. Its own row, defaulting to All, exactly as the
              reference does it, and it composes with the search rather than
              replacing it. */}
          <div className="border-b border-line px-2 py-1.5">
            <label className="flex items-center gap-2">
              <span className="text-[10.5px] font-medium text-muted">Category</span>
              <select
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value === "" ? null : e.target.value)}
                className="min-w-0 flex-1 rounded-md border border-line-strong bg-card px-2 py-[3px] text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              >
                <option value="">All</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 4. Search, with the sort and favourites controls beside it. */}
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
            <div className="relative min-w-0 flex-1">
              <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search code or name"
                aria-label="Search treatments"
                className="w-full rounded-md border border-line-strong bg-card py-[3px] pl-7 pr-2 text-[12px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              />
            </div>
            <button
              type="button"
              aria-pressed={preferences.sort === "code"}
              onClick={() => onPreferencesChange({ ...preferences, sort: preferences.sort === "name" ? "code" : "name" })}
              title={preferences.sort === "name" ? "Sorted by name. Sort by code" : "Sorted by code. Sort by name"}
              className="pressable shrink-0 rounded-md border border-line-strong bg-card px-1.5 py-[3px] text-[10.5px] font-medium text-muted transition-colors hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              <ArrowDownAZ size={13} className="inline align-[-2px]" aria-hidden />{" "}
              {preferences.sort === "name" ? "Name" : "Code"}
            </button>
            <button
              type="button"
              aria-pressed={favouritesOnly}
              onClick={() => setFavouritesOnly((v) => !v)}
              title={favouritesOnly ? "Showing favourites only" : "Show favourites only"}
              aria-label="Show favourites only"
              className={cn(
                "pressable shrink-0 rounded-md border px-1.5 py-[3px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                favouritesOnly ? "border-navy bg-navy text-white" : "border-line-strong bg-card text-muted hover:text-navy",
              )}
            >
              <Star size={13} aria-hidden fill={favouritesOnly ? "currentColor" : "none"} />
            </button>
          </div>

          {/* The selected treatment, said in words. A left click on the chart charts
              THIS code, so which one is selected must never be a matter of spotting a
              highlighted row in a list of four hundred. */}
          <div className="flex items-baseline gap-2 border-b border-line bg-band px-2.5 py-1">
            <span className="text-[10.5px] font-medium text-muted">Charting</span>
            {activeTreatment ? (
              <span className="min-w-0 truncate text-[11.5px] font-semibold text-navy">
                <span className="tabular-nums">{activeTreatment.code}</span> {activeTreatment.name}
              </span>
            ) : (
              <span className="text-[11.5px] text-faint">Nothing selected. Choose a treatment below.</span>
            )}
          </div>

          {/* 5 and 6. The list and its rail. */}
          {failed ? (
            <p className="m-2.5 rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] text-ink">
              {FAILED_COPY.treatments}
            </p>
          ) : (
            <div className="flex min-h-0 flex-1">
              <div className="min-w-0 flex-1 overflow-y-auto">
                {rows.length === 0 ? (
                  <p className="px-2.5 py-3 text-[12px] text-muted">
                    No treatments match this search{categoryId ? ` in ${categoryName(categoryId)}` : ""}.
                  </p>
                ) : (
                  <>
                    {favouriteRows.length > 0 ? (
                      <TreatmentGroup
                        id={idFor(buckets[0]?.key ?? "")}
                        label="Favourites"
                        count={favouriteRows.length}
                        rows={favouriteRows}
                        favourites={favourites}
                        activeCode={activeTreatment?.code ?? null}
                        onSelectTreatment={onSelectTreatment}
                        onToggleFavourite={onToggleFavourite}
                      />
                    ) : null}
                    {letterGroups.map((group) => (
                      <TreatmentGroup
                        key={group.bucket.key}
                        id={idFor(group.bucket.key)}
                        label={group.bucket.label}
                        count={group.rows.length}
                        rows={group.rows}
                        favourites={favourites}
                        activeCode={activeTreatment?.code ?? null}
                        onSelectTreatment={onSelectTreatment}
                        onToggleFavourite={onToggleFavourite}
                      />
                    ))}
                  </>
                )}
              </div>
              <AlphabetRail buckets={buckets} idFor={idFor} />
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/**
 * One lettered group of the list. The heading is a real scroll target for the rail and
 * carries its own count, which is a fact the reader can use rather than a decoration.
 */
function TreatmentGroup({
  id,
  label,
  count,
  rows,
  favourites,
  activeCode,
  onSelectTreatment,
  onToggleFavourite,
}: {
  id: string;
  label: string;
  count: number;
  rows: TreatmentRow[];
  favourites: ReadonlySet<string>;
  activeCode: string | null;
  onSelectTreatment: (row: TreatmentRow) => void;
  onToggleFavourite: (treatmentId: string) => void;
}) {
  return (
    <section aria-labelledby={`${id}-label`}>
      <h4
        id={id}
        className="sticky top-0 z-10 flex items-baseline justify-between gap-2 border-b border-line bg-card-muted/70 px-2.5 py-[3px] backdrop-blur-[2px]"
      >
        <span id={`${id}-label`} className="text-[10.5px] font-semibold tracking-[0.04em] text-muted">
          {label}
        </span>
        <span className="tabular-nums text-[10px] text-faint">{count}</span>
      </h4>
      <ul>
        {rows.map((row) => {
          const starred = favourites.has(row.id);
          // treatmentKey, NOT row.code. The code is read defensively from three
          // unverified field names and falls back to "", and with an empty code
          // `row.code === activeCode` was true for EVERY row: selecting one
          // treatment highlighted the entire list, so a clinician could not see
          // what a click on the chart was about to record. The key falls back to
          // the id, which is always populated; the code is still what is PRINTED.
          const active = activeCode !== null && treatmentKey(row) === activeCode;
          return (
            <li key={row.id} className="flex items-center gap-1 border-b border-line/70 last:border-0">
              <button
                type="button"
                aria-pressed={starred}
                aria-label={starred ? `Remove ${row.name} from favourites` : `Add ${row.name} to favourites`}
                onClick={() => onToggleFavourite(row.id)}
                className={cn(
                  "shrink-0 py-[5px] pl-2 pr-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  starred ? "text-status-amber" : "text-line-strong hover:text-muted",
                )}
              >
                <Star size={12} aria-hidden fill={starred ? "currentColor" : "none"} />
              </button>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onSelectTreatment(row)}
                className={cn(
                  "flex min-w-0 flex-1 items-baseline gap-2 py-[5px] pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                  active ? "bg-band font-semibold text-navy" : "hover:bg-band/60",
                )}
              >
                <span className="w-[38px] shrink-0 tabular-nums text-[11px] font-medium text-muted">{row.code}</span>
                <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{row.name}</span>
                {row.price > 0 ? (
                  <span className="shrink-0 tabular-nums text-[11px] text-faint">{gbp(row.price)}</span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
