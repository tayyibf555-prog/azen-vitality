"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { chartReducer, draftKey, initialChartState } from "@/lib/charting/selection";
import { archMarkers } from "@/lib/charting/tooth-geometry";
import { offArchItems, toothMarks, unreadSurfaceCount } from "@/lib/charting/render-state";
import { parseFavourites, serialiseFavourites, treatmentKey } from "@/lib/charting/treatment-list";
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  preferencesStorageKey,
  serialisePreferences,
} from "@/lib/charting/preferences";
import { CHART_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import type {
  ChartItem,
  ChartPreferences,
  ChartRead,
  ChartState,
  Dentition,
  DraftEntry,
  SurfaceId,
  ToothMark,
  TreatmentRow,
} from "@/lib/charting/types";
import { cn } from "@/lib/utils";
import { ChartArch } from "./chart-arch";
import { ChartHistory } from "./chart-history";
import { ChartLegend } from "./chart-legend";
import { ChartPreferencesMenu } from "./chart-preferences-menu";
import { ChartStatusBar } from "./chart-status-bar";
import { ChartTools } from "./chart-tools";
import { ChartUnavailablePanel, type ChartPanelVariant } from "./chart-unavailable-panel";
import { PlanTabs } from "./plan-tabs";
import { TreatmentPanel } from "./treatment-panel";

/**
 * THE ONLY "use client" FILE IN THE CHART.
 *
 * Every leaf under chart/ is an undirected universal module carrying no directive of
 * its own: they inherit the boundary from here, and boundary.test.ts pins that. A
 * leaf that declared "use client" for itself would build green and then be pulled
 * into the client graph from wherever else it was imported, which is the failure this
 * repo has already paid for once.
 *
 * IT OWNS STATE AND DECIDES NOTHING. The reducer is imported, never reimplemented,
 * so the click mechanic has exactly one tested definition (selection.ts). The arch
 * geometry, the origins, the funding, the filtering, the history lines and the CSV
 * all come from .ts modules vitest can collect. What lives here is state, transport
 * and layout.
 *
 * NOTHING HERE REACHES DENTALLY. The only network call is to /api/charting/draft,
 * which writes to our own table, and it is dormant: isChartDraftEnabled() is read on
 * the SERVER (tab-chart.tsx) and arrives as `draftEnabled`, false unless someone sets
 * CHART_DRAFT_ENABLED. With it false the reducer refuses every charting intent with
 * "draft-disabled" and says so in the aria-live region, rather than appearing to work.
 *
 * DRAFT FRESHNESS IS A REAL BUG WITHOUT THE REFETCH. next.config.ts sets
 * staleTimes.static = 120 and there is correctly no loading.tsx, so a soft navigation
 * away and back replays a payload up to two minutes old; useReducer ignores later
 * prop changes, so the clinician's planning would visibly vanish. This adopts
 * use-patient-notes.ts's idiom verbatim: seed for the first paint, refetch on mount
 * when the seed failed, a `seq` ticket so a slow read cannot land after a write, and
 * a refetch after every mutation.
 *
 * NO CLOCK AT ALL, ANYWHERE UNDER THIS FILE, and that is stronger than passing a
 * `now` down. Every time this screen prints comes from the DATA: ChartRead.fetchedAt,
 * captured inside the read at fetch time, and the completedAt/updatedAt on each item.
 * Nothing renders a present tense it would have to keep true, so there is no
 * new Date() or Date.now() in a render path and no "now" prop to keep in step with
 * the rest of the record. localStorage is read in an effect and never during render,
 * and the setState is deferred through a microtask, which is this repo's existing
 * idiom (notifications-list.tsx) for the same lint rule.
 */

export interface ChartWorkspaceProps {
  clientSlug: string;
  siteId: string;
  patientId: string;
  /** The whole Dentally read, plain and serialisable. Its `health` travels all the
   *  way down to the arch, so a failed items read can never render as clean teeth. */
  read: ChartRead;
  /** Read on the SERVER from CHART_DRAFT_ENABLED. False on the shipped screen. */
  draftEnabled: boolean;
  /** The server's own read of our draft table, so the first paint is already right.
   *  `ok: false` means the read FAILED, which is not the same as an empty draft. */
  seedDraft: { ok: boolean; entries: DraftEntry[] };
}

/** DraftEntry[] to the reducer's keyed record. One place, so a hydrate and a local
 *  edit can never key the same entry differently. */
function toDraftRecord(entries: readonly DraftEntry[]): Record<string, DraftEntry> {
  const out: Record<string, DraftEntry> = {};
  for (const entry of entries) out[draftKey(entry.tooth, entry.treatmentCode)] = entry;
  return out;
}

export function ChartWorkspace({
  clientSlug,
  siteId,
  patientId,
  read,
  draftEnabled,
  seedDraft,
}: ChartWorkspaceProps) {
  const router = useRouter();

  const [state, dispatch] = useReducer(
    chartReducer,
    undefined,
    (): ChartState =>
      initialChartState({ draftEnabled, draft: toDraftRecord(seedDraft.entries) }),
  );

  // The reducer is pure and exported, so a handler can compute the SAME next state
  // it is about to dispatch and know exactly which entry moved. That is what lets a
  // save be derived from the mechanic rather than re-deriving the mechanic here. The
  // ref is what keeps two clicks in one frame from computing against a stale state.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });

  const [preferences, setPreferences] = useState<ChartPreferences>(DEFAULT_PREFERENCES);
  const [favourites, setFavourites] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [panel, setPanel] = useState<ChartPanelVariant | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [baseMode, setBaseMode] = useState(false);
  /** A failed save is SHOWN. A draft the clinician believes was saved and was not is
   *  exactly the failure this build guards against. */
  const [saveFailed, setSaveFailed] = useState(false);
  const [draftReadFailed, setDraftReadFailed] = useState(draftEnabled && !seedDraft.ok);

  const prefsKey = preferencesStorageKey(siteId, patientId);
  // Favourites are the CLINICIAN'S list of treatments, not this patient's, so they
  // are keyed on the site alone: starring a code while looking at one patient and
  // finding it unstarred on the next would be a preference that does not work.
  const favouritesKey = `chart-favourites:${siteId}`;

  // Hydrated once after mount, never during render: localStorage is not available on
  // the server and reading it in a render path is both a hydration mismatch and an
  // impure read. The setState is deferred through a microtask so it is not called
  // synchronously inside the effect (react-hooks/set-state-in-effect), which is the
  // idiom notifications-list.tsx already uses for exactly this.
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => {
      if (!active) return;
      let storedPrefs: ChartPreferences = DEFAULT_PREFERENCES;
      let storedFavourites = new Set<string>();
      try {
        storedPrefs = parsePreferences(window.localStorage.getItem(prefsKey));
        storedFavourites = parseFavourites(window.localStorage.getItem(favouritesKey));
      } catch {
        // Unavailable or corrupt storage falls back to the defaults. A display
        // preference must never be able to blank a clinical screen.
      }
      setPreferences(storedPrefs);
      setFavourites(storedFavourites);
      if (storedPrefs.locked) dispatch({ kind: "set-locked", locked: true });
      if (storedPrefs.combined) dispatch({ kind: "set-dentition", dentition: "combined" });
    });
    return () => {
      active = false;
    };
  }, [prefsKey, favouritesKey]);

  // --- The draft, ours, and switched off by default -------------------------

  const seq = useRef(0);
  const loadDraft = useCallback(() => {
    if (!draftEnabled) return;
    const ticket = ++seq.current;
    fetch(
      `/api/charting/draft?client=${encodeURIComponent(clientSlug)}&siteId=${encodeURIComponent(siteId)}&patientId=${encodeURIComponent(patientId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: { ok?: boolean; draft?: DraftEntry[] }) => {
        if (ticket !== seq.current) return;
        if (d.ok) {
          dispatch({ kind: "hydrate", draft: toDraftRecord(d.draft ?? []) });
          setDraftReadFailed(false);
        } else {
          setDraftReadFailed(true);
        }
      })
      .catch(() => {
        if (ticket === seq.current) setDraftReadFailed(true);
      });
  }, [clientSlug, siteId, patientId, draftEnabled]);

  // A SUCCESSFUL seed is already correct on the first paint, so it is not refetched:
  // a second identical read would only reintroduce the flash the seed removes. A
  // FAILED seed is retried, because a transient failure must not leave the screen
  // stuck on its caveat for the life of the page.
  const seeded = useRef(seedDraft.ok);
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    loadDraft();
    return () => {
      seq.current += 1;
    };
  }, [loadDraft]);

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/charting/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client: clientSlug, siteId, patientId, ...body }),
        });
        const d = (await res.json()) as { ok?: boolean };
        if (!res.ok || !d.ok) throw new Error("save failed");
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      } finally {
        // Whether it worked or not, the server is the truth about what is stored.
        loadDraft();
      }
    },
    [clientSlug, siteId, patientId, loadDraft],
  );

  // --- The click mechanic ---------------------------------------------------

  const onSurfaceIntent = useCallback(
    (fdi: number, surface: SurfaceId, kind: "first" | "add") => {
      const before = latest.current;
      const intent = { kind: kind === "first" ? ("chart-first" as const) : ("chart-add" as const), tooth: fdi, surface };
      const after = chartReducer(before, intent);
      dispatch(intent);
      // Rejected: the draft object is untouched and lastRejection carries the reason
      // to the aria-live region. Nothing is saved, and nothing should be.
      if (after.draft === before.draft) return;
      const treatment = before.activeTreatment;
      if (!treatment) return;
      const key = draftKey(fdi, treatment.code);
      const entry = after.draft[key];
      void save(
        entry
          ? {
              action: "upsert",
              tooth: entry.tooth,
              surfaces: entry.surfaces,
              treatmentCode: entry.treatmentCode,
              treatmentName: entry.treatmentName,
              dentition: entry.dentition,
            }
          : { action: "delete", tooth: fdi, treatmentCode: treatment.code },
      );
    },
    [save],
  );

  const onSelectTreatment = useCallback((row: TreatmentRow) => {
    // treatmentKey, NOT row.code. The code is read defensively from three possible
    // field names and falls back to "", and an empty code makes every row look
    // selected and collapses every codeless treatment on a tooth into one draft
    // entry. The list still PRINTS row.code; this is identity, not decoration.
    dispatch({ kind: "select-treatment", code: treatmentKey(row), name: row.name });
  }, []);

  // --- Preferences ----------------------------------------------------------

  const applyPreferences = useCallback(
    (next: ChartPreferences) => {
      setPreferences(next);
      try {
        window.localStorage.setItem(prefsKey, serialisePreferences(next));
      } catch {
        // A storage write that fails costs the preference on the next visit and
        // nothing else. It must not interrupt the screen.
      }
      // Two preferences have consumers inside the reducer rather than in a class
      // name, so they are pushed there rather than read from two places.
      dispatch({ kind: "set-locked", locked: next.locked });
      if (next.combined) dispatch({ kind: "set-dentition", dentition: "combined" });
      else if (latest.current.dentition === "combined" && !baseMode) {
        dispatch({ kind: "set-dentition", dentition: "permanent" });
      }
    },
    [prefsKey, baseMode],
  );

  const onToggleFavourite = useCallback(
    (treatmentId: string) => {
      setFavourites((prev) => {
        const next = new Set(prev);
        if (next.has(treatmentId)) next.delete(treatmentId);
        else next.add(treatmentId);
        try {
          window.localStorage.setItem(favouritesKey, serialiseFavourites(next));
        } catch {
          // See applyPreferences.
        }
        return next;
      });
    },
    [favouritesKey],
  );

  // The segmented control owns permanent/deciduous/base. "combined" is reached only
  // through the preference, so picking an arch here turns that preference off rather
  // than leaving a control that visibly does nothing.
  const onSetDentition = useCallback(
    (dentition: Dentition) => {
      dispatch({ kind: "set-dentition", dentition });
      if (dentition !== "combined" && preferences.combined) {
        applyPreferences({ ...preferences, combined: false });
      }
      setBaseMode(dentition === "base");
    },
    [preferences, applyPreferences],
  );

  const onToggleBase = useCallback(() => {
    const next = !baseMode;
    setBaseMode(next);
    dispatch({
      kind: "set-dentition",
      dentition: next ? "base" : preferences.combined ? "combined" : "permanent",
    });
  }, [baseMode, preferences.combined]);

  // --- What the arch draws --------------------------------------------------

  const { items, unplaced, plans, health, treatments, categories } = read;

  // A selected plan filters the chart AND the history. That is a READ: it changes
  // what is shown, never what is stored, which is why the plan tabs stay live on a
  // screen with no write path at all.
  const shown: ChartItem[] = useMemo(
    () =>
      state.activePlanId === null ? items : items.filter((i) => i.planId === state.activePlanId),
    [items, state.activePlanId],
  );

  // Base Chart is a MODE, not a filter on the same view: the arch shows base-chart
  // items and the left list changes context with it.
  const drawn: ChartItem[] = useMemo(
    () => (baseMode ? shown.filter((i) => i.baseChart) : shown.filter((i) => !i.baseChart)),
    [shown, baseMode],
  );

  const rows = useMemo(() => archMarkers(state.dentition).rows, [state.dentition]);

  const itemsByTooth = useMemo(() => {
    const map: Record<number, ChartItem[]> = {};
    for (const item of drawn) {
      for (const tooth of item.teeth) (map[tooth] ??= []).push(item);
    }
    return map;
  }, [drawn]);

  const marksByTooth = useMemo(() => {
    const map: Record<number, ToothMark[]> = {};
    for (const row of rows) {
      for (const tooth of row.teeth) {
        const marks = toothMarks(tooth, drawn, state.draft, plans);
        if (marks.length > 0) map[tooth] = marks;
      }
    }
    return map;
  }, [rows, drawn, state.draft, plans]);

  const offArch = useMemo(() => offArchItems(items, state.dentition), [items, state.dentition]);
  const unreadSurfaces = useMemo(() => unreadSurfaceCount(items), [items]);
  const itemCountFor = useCallback(
    (planId: string) => items.filter((i) => i.planId === planId).length,
    [items],
  );

  return (
    // data-wide, NOT data-diary: the layouts drop their 1400px cap for this screen so
    // a 32-tooth arch is not squeezed into roughly 1050px beside a 300px panel, and a
    // tooth too small to hit accurately is a mis-click on a clinical chart. It
    // deliberately does NOT take the diary's h-full/space-y-0 variants, which are that
    // screen's two-axis scroller and belong to it alone.
    <section data-wide aria-label="Tooth chart" className="space-y-3">
      {/* THE PANEL TRACK IS A PROPORTION, CLAMPED — and that is half of the fix for the
          owner's "when our platform the side bar comes out it makes it so you have to
          scroll for the teeth it shouldnt be like that it should fit into one thing".

          IT USED TO BE A FLAT 400px, and 400 was measured correctly: the reference gives
          its list ~435px of a ~1905px content area (22.8%), and 400px of our ~1770px at
          1920 is 22.6% — the same proportion at the viewport the measurement was taken
          at. The error was applying a PROPORTION as a CONSTANT. At 1500 the content is
          1381px, so a fixed 400 is 29% of it and leaves the arch 947px against the
          1078px its floor demanded: measured 131px short, and the card scrolled sideways.
          Dentally does not have this bug for exactly one reason — at that window their
          panel is ~320px, not 400px, because theirs is proportional.

          THE CLAMP IS WHY BOTH SCREENS ARE RIGHT. Wide monitors sit at PANEL_MAX and the
          verified Dentally parity is untouched; narrow ones hand the difference back to
          the teeth and stop at PANEL_MIN, which is the 300px the list had BEFORE it was
          widened — so the truncation the fixed 400 was introduced to fix can never be
          worse than it was, and a chart you must drag sideways beats a truncated name
          nowhere. FIT WINS.

          WRITTEN OUT LITERALLY, and it has to be. Tailwind v4 scans raw source, so a
          template-built `grid-cols-[${n}px_…]` emits no class at all — which is why this
          is a CSS clamp() rather than a JS one: the value varies at runtime while the
          class string stays a constant the scanner can see. arch-metrics.ts owns the
          same three numbers (PANEL_MIN / PANEL_FRACTION / PANEL_MAX) and its test reads
          this file back to prove the two have not drifted.

          THE ASIDE DOES NOT REPEAT THEM. TreatmentPanel is `w-full` inside this track, so
          it cannot disagree with it — the old pair of matching 400px literals was one
          edit away from a track wider than its aside, which reads as a misalignment. */}
      <div
        className={cn(
          "grid gap-4",
          preferences.panelCollapsed
            ? "lg:grid-cols-[56px_minmax(0,1fr)]"
            : "lg:grid-cols-[clamp(300px,22.8%,400px)_minmax(0,1fr)]",
        )}
      >
        <div className="relative min-w-0">
          <TreatmentPanel
            treatments={treatments}
            categories={categories}
            health={health}
            dentition={state.dentition}
            baseChartMode={baseMode}
            onSetDentition={onSetDentition}
            activeTreatment={state.activeTreatment}
            onSelectTreatment={onSelectTreatment}
            favourites={favourites}
            onToggleFavourite={onToggleFavourite}
            preferences={preferences}
            onPreferencesChange={applyPreferences}
            onOpenPreferences={() => setPrefsOpen(true)}
          />
          {/* ONE preferences menu, opened from the panel's chevron OR the cog in the
              bottom-right cluster. Two owners each writing one is how two menus drift. */}
          <ChartPreferencesMenu
            open={prefsOpen}
            preferences={preferences}
            onChange={applyPreferences}
            onClose={() => setPrefsOpen(false)}
            className="absolute left-0 top-9 z-20"
          />
        </div>

        <div className="min-w-0 space-y-2.5">
          <ChartStatusBar
            fetchedAt={read.fetchedAt}
            health={health}
            truncated={read.truncated}
            truncatedCatalogue={read.truncatedCatalogue}
            itemCount={items.length}
            unplacedCount={unplaced.length}
            offArchCount={offArch.length}
            unreadSurfaceCount={unreadSurfaces}
            lastRejection={state.lastRejection}
            onRefresh={() => router.refresh()}
          />

          {/* Our own draft's two failure states, in words, never as a silently
              missing surface. Both are dormant while planning is switched off. */}
          {draftReadFailed ? (
            <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] text-ink">
              {FAILED_COPY.chartDraft}
            </p>
          ) : null}
          {saveFailed ? (
            <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] text-ink">
              {CHART_COPY.draftSaveFailed}
            </p>
          ) : null}

          <ChartArch
            rows={rows}
            itemsByTooth={itemsByTooth}
            marksByTooth={marksByTooth}
            plans={plans}
            draft={state.draft}
            activeTooth={state.activeTooth}
            preferences={preferences}
            health={health}
            onSurfaceIntent={onSurfaceIntent}
            onOpenSocket={() => setPanel("socket")}
          />

          <ChartLegend draftEnabled={draftEnabled} />

          <div className="flex flex-wrap items-start justify-between gap-3">
            <PlanTabs
              plans={plans}
              activePlanId={state.activePlanId}
              onSelectPlan={(planId) => dispatch({ kind: "select-plan", planId })}
              health={health}
              itemCountFor={itemCountFor}
              className="min-w-0 flex-1"
            />
            <ChartTools
              baseMode={baseMode}
              historyOpen={historyOpen}
              onOpenPanel={setPanel}
              onToggleBase={onToggleBase}
              onToggleHistory={() => setHistoryOpen((open) => !open)}
              onOpenPreferences={() => setPrefsOpen(true)}
            />
          </div>

          {/* Rendered in place beneath the cluster that opened it, not as a modal: a
              dialog over a clinical chart hides the thing the reader came to check. */}
          {panel ? <ChartUnavailablePanel variant={panel} onClose={() => setPanel(null)} /> : null}
        </div>
      </div>

      {historyOpen ? (
        <ChartHistory
          items={shown}
          unplaced={unplaced}
          offArch={offArch}
          plans={plans}
          health={health}
          activePlanId={state.activePlanId}
          onSelectPlan={(planId) => dispatch({ kind: "select-plan", planId })}
          patientId={patientId}
          fetchedAt={read.fetchedAt}
        />
      ) : null}
    </section>
  );
}
