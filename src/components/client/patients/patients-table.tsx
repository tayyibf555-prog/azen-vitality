"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, relativeTime } from "@/lib/utils";
import { getSite } from "@/lib/mock";
import { Search, Loader2 } from "lucide-react";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import type { PatientListRow } from "@/lib/patient/list-row";
import { usePatientQuickView } from "@/components/platform/patient-quick-view-provider";

// The chip for a platform admin override (wins over Dentally's own active flag).
const OVERRIDE_CHIP: Record<PatientAdminStatus, { tone: Tone; label: string }> = {
  active: { tone: "success", label: "Active" },
  inactive: { tone: "neutral", label: "Inactive" },
  do_not_contact: { tone: "danger", label: "Do not contact" },
};

function statusOf(p: PatientListRow): { tone: Tone; label: string } {
  if (!p.active) return { tone: "neutral", label: p.archivedReason === "lapsed" ? "Lapsed" : "Inactive" };
  return { tone: "success", label: "Active" };
}

function recallTone(recallIso: string | null, nowIso: string): Tone {
  if (!recallIso) return "neutral";
  return recallIso <= nowIso ? "warning" : "info";
}

export type PatientFilter = "active" | "recall" | "lapsed" | "all";

const FILTERS: { key: PatientFilter; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "recall", label: "Recall due" },
  { key: "lapsed", label: "Lapsed" },
  { key: "all", label: "All" },
];

// The at-a-glance caption under the search box, per selected segment.
const FILTER_CAPTION: Record<PatientFilter, string> = {
  active: "Active patients",
  recall: "Patients due a recall",
  lapsed: "Lapsed patients",
  all: "All patients",
};

// A tailored empty state per segment, so a genuinely empty segment reads clearly.
const FILTER_EMPTY: Record<PatientFilter, { title: string; description: string }> = {
  active: { title: "No active patients", description: "No active patients to show." },
  recall: { title: "No recalls due", description: "No patients due a recall." },
  lapsed: { title: "No lapsed patients", description: "No lapsed patients to show." },
  all: { title: "No patients", description: "No patients to show." },
};

export function PatientsTable({
  patients,
  nowIso,
  clientSlug,
  initialFilter = "active",
  overrides = {},
  requestedPatientId = null,
  initialPatient = null,
  basePath,
}: {
  patients: PatientListRow[];
  nowIso: string;
  clientSlug: string;
  /** "/c/<client>" or "/owner/<client>". Every record link is built from it, so the
   *  same table works in both trees and a row never sends an owner into /c. */
  basePath: string;
  initialFilter?: PatientFilter;
  /** The id that arrived as ?patient=, so a record that could not be resolved is
   *  reported rather than silently doing nothing. */
  requestedPatientId?: string | null;
  /** That record, resolved SERVER-side by id. Null when it could not be loaded. */
  initialPatient?: PatientListRow | null;
  /** Platform admin overrides keyed by dentally patient id, for the site(s) in scope.
   *  Covers rows from the initial slice, search and filter alike (site-wide map). */
  overrides?: Record<string, PatientAdminStatus>;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const quickView = usePatientQuickView();
  const [q, setQ] = useState("");
  // True when a ?patient= arrived that the server could not resolve. Saying so is
  // the point: a link from the diary that quietly does nothing is worse than none.
  const unresolvedPatient = Boolean(requestedPatientId) && initialPatient === null;
  const [filter, setFilter] = useState<PatientFilter>(initialFilter);
  // Server-side search: the initial `patients` prop is only a bounded first slice, so
  // to reach anyone beyond it we query Dentally directly (debounced). `serverResults`
  // is null when no search is active (show the initial slice), [] for "no matches".
  const [serverResults, setServerResults] = useState<PatientListRow[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Rows for the current filter, fetched server-side when the user changes segment.
  // Null means "use the server-rendered initial slice" (the initial active view, so
  // there is no fetch-flash on first paint). Non-null once a fetch has resolved.
  const [filterRows, setFilterRows] = useState<PatientListRow[] | null>(null);
  const [filterLoading, setFilterLoading] = useState(false);

  const searchActive = q.trim().length >= 2;
  // The initial segment renders straight from the server-provided slice; any other
  // segment must be fetched. Once the user leaves and returns to the initial segment
  // we still have the slice to fall back on, so no fetch is needed there either.
  const usingInitialSlice = filter === initialFilter && filterRows === null;

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setServerResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    // `alive` is flipped by cleanup: a superseding keystroke (or unmount) both clears
    // the pending timeout AND, if a fetch already fired, discards its late response so
    // stale results never overwrite the current query's.
    let alive = true;
    const t = setTimeout(() => {
      fetch(`/api/dentally/patients?client=${encodeURIComponent(clientSlug)}&search=${encodeURIComponent(needle)}`, {
        cache: "no-store",
      })
        .then((r) => r.json())
        .then((d: { patients?: PatientListRow[] }) => {
          if (alive) setServerResults(d.patients ?? []);
        })
        .catch(() => {
          if (alive) setServerResults([]);
        })
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, clientSlug]);

  // Fetch the selected segment's rows. Skipped while a search is active (search spans
  // the whole base and overrides the filter) and skipped for the initial slice (already
  // server-rendered). Race-safe via `alive`: a superseding segment change discards a
  // late response. Clearing a search re-runs this and restores the selected segment.
  useEffect(() => {
    if (searchActive) return;
    if (filter === initialFilter && filterRows === null) return; // initial slice already shown
    let alive = true;
    setFilterLoading(true);
    fetch(`/api/dentally/patients?client=${encodeURIComponent(clientSlug)}&filter=${encodeURIComponent(filter)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: { patients?: PatientListRow[] }) => {
        if (alive) setFilterRows(d.patients ?? []);
      })
      .catch(() => {
        if (alive) setFilterRows([]);
      })
      .finally(() => {
        if (alive) setFilterLoading(false);
      });
    return () => {
      alive = false;
    };
    // filterRows is intentionally omitted: it is set inside this effect, and the
    // `=== null` guard is only meant to gate the very first initial-slice paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, initialFilter, clientSlug, searchActive]);

  // The rows currently backing the table for the selected segment: the server-rendered
  // slice for the initial segment, the fetched rows otherwise. Memoised so it is stable
  // across renders (it feeds the ?patient effect's dependencies).
  const loadedRows = useMemo(
    () => (usingInitialSlice ? patients : filterRows ?? []),
    [usingInitialSlice, patients, filterRows],
  );

  // ?patient=<id> STILL WORKS, unchanged in behaviour.
  //
  // New links no longer generate it (PatientLink opens the quick view in place from
  // wherever you are, without leaving the page), but existing bookmarks, links we do
  // not control and the no-JS path all still carry it, so removing it would break
  // links in the wild. It now opens the same QUICK VIEW those in-place links open,
  // rather than a drawer that only this file knew how to build. The owner tree gains
  // it too, where it previously did nothing at all.
  //
  // Resolve against whichever rows are currently loaded (slice, filter, or search),
  // and otherwise against the record the SERVER resolved by id, which is what makes
  // the link work for any of the 52,000 patients rather than only those in the
  // loaded slice.
  useEffect(() => {
    const pid = searchParams.get("patient");
    if (!pid) return;
    const row =
      loadedRows.find((p) => p.id === pid) ??
      serverResults?.find((p) => p.id === pid) ??
      (initialPatient?.id === pid ? initialPatient : null);
    if (row && quickView) {
      quickView.open({
        patientId: row.id,
        siteId: row.siteId,
        href: `${basePath}/patients/${encodeURIComponent(row.id)}`,
        patientName: row.name,
      });
    }
    // Consume the one-shot ?patient instruction: strip it from the URL so a refresh
    // lands on the clean list instead of re-opening the same record every time.
    //
    // window.history.replaceState, NEVER router.replace. This page is
    // force-dynamic and awaits searchParams, so router.replace re-runs it with no
    // ?patient, the server then resolves no initialPatient, and the overlay that
    // had just opened for a patient OUTSIDE the loaded slice (most of a 52,000
    // patient book, which is the whole reason the server resolves it by id) loses
    // the only record backing it and closes again on its own. The native history
    // API integrates with the Next router and syncs useSearchParams without
    // re-rendering the server component, so the address bar is cleaned and the
    // record in hand survives.
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("patient");
    const qs = sp.toString();
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, loadedRows, serverResults, initialPatient, pathname, quickView, basePath]);

  // Precedence: an active search overrides the filter; otherwise the selected segment
  // (server-rendered slice for the initial segment, fetched rows for the rest).
  const rows = searchActive ? serverResults ?? [] : loadedRows;
  // serverResults === null counts as loading too: `searching` only flips true when
  // the effect runs AFTER the first post-keystroke paint, so without it the table
  // flashes "No patients match" for a frame before the spinner appears.
  const loading = searchActive ? searching || serverResults === null : filterLoading;

  const emptyCopy = FILTER_EMPTY[filter];

  // py-3.5 on every cell gives the unboxed table a more generous vertical rhythm
  // than the shared default without touching the primitive.
  const columns: Column<PatientListRow>[] = [
    {
      key: "name",
      header: "Patient",
      // A REAL link to the record, not a click handler. From the patients list the
      // patient IS the task, so it goes STRAIGHT to the full profile with no
      // intermediate overlay. Being an anchor also restores cmd-click, middle-click
      // and "copy link address", none of which worked when the row was a <tr onClick>.
      cell: (p) => (
        <Link
          href={`${basePath}/patients/${encodeURIComponent(p.id)}`}
          className="rounded font-semibold text-navy underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          onClick={(e) => e.stopPropagation()}
        >
          {p.name}
        </Link>
      ),
      className: "py-3.5",
    },
    {
      key: "contact",
      header: "Contact",
      // A row sourced from recall_target carries no contact details at all, so its
      // nulls are a fact about THIS VIEW, not about the patient. A dash is not a
      // claim; "No contact" is, and it was wrong on every recall row.
      cell: (p) =>
        p.partial && !p.phone && !p.email ? (
          <span className="text-faint" title="Not loaded in this view">
            -
          </span>
        ) : (
          <span className="text-muted">{p.phone ?? p.email ?? "No contact"}</span>
        ),
      className: "py-3.5",
    },
    {
      key: "site",
      header: "Site",
      cell: (p) => <span className="text-muted">{getSite(p.siteId)?.name ?? p.siteId}</span>,
      className: "py-3.5",
    },
    {
      key: "last",
      header: "Last visit",
      cell: (p) => <span className="text-muted">{p.lastVisitAt ? relativeTime(p.lastVisitAt, now) : "No record"}</span>,
      align: "right",
      className: "py-3.5",
    },
    {
      key: "recall",
      header: "Recall due",
      cell: (p) =>
        p.recallDueAt ? (
          <StatusPill tone={recallTone(p.recallDueAt, nowIso)}>{relativeTime(p.recallDueAt, now)}</StatusPill>
        ) : (
          <span className="text-muted">Not set</span>
        ),
      align: "right",
      className: "py-3.5",
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => {
        // A platform admin override wins over the Dentally-derived status chip.
        const ov = overrides[p.id];
        const s = ov ? OVERRIDE_CHIP[ov] : statusOf(p);
        return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
      },
      align: "right",
      className: "py-3.5",
    },
  ];

  return (
    <>
      {/* Unboxed list (aesthetic-shell): a hairline section header carrying the
          title, the segment pills and the search field; the table itself sits on
          hairline dividers and whitespace rather than inside a card. */}
      <section>
        <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line pb-3">
          <div className="space-y-1">
            <h3 className="text-title text-navy">All patients</h3>
            <p className="text-caption font-normal text-muted">Click a patient to open their record.</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <div
              className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
              role="group"
              aria-label="Filter patients"
            >
              {FILTERS.map(({ key, label }) => {
                const active = filter === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setFilter(key)}
                    className={cn(
                      "pressable rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                      active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search name, phone or email"
                className="w-64 rounded-lg border border-line-strong bg-card py-2 pl-9 pr-9 text-[13px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
              />
              {searching ? (
                <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted" />
              ) : null}
            </div>
          </div>
        </header>

        {unresolvedPatient ? (
          <p className="border-b border-line px-3 pt-2.5 text-[11px] text-muted">
            That patient record could not be loaded.
          </p>
        ) : null}

        <p className="flex items-center gap-2 border-b border-line px-3 py-2.5 text-caption text-muted">
          {searchActive ? "Search results" : FILTER_CAPTION[filter]}
          {loading ? <Loader2 size={12} className="animate-spin" /> : null}
        </p>
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(p) => p.id}
          // The whole row is clickable for speed at the desk; the name cell inside it
          // is a real anchor, so both a quick click anywhere and a cmd-click on the
          // name do the right thing.
          onRowClick={(p) => router.push(`${basePath}/patients/${encodeURIComponent(p.id)}`)}
          className="pt-1"
          empty={
            <EmptyState
              title={loading ? "Loading…" : searchActive ? "No patients match" : emptyCopy.title}
              description={
                loading
                  ? "Looking across your patient database."
                  : searchActive
                    ? "Try a different search."
                    : emptyCopy.description
              }
              className="mt-4"
            />
          }
        />
      </section>

    </>
  );
}
