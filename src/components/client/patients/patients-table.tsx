"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, gbp, num, relativeTime } from "@/lib/utils";
import { getSite } from "@/lib/mock";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import {
  Search, X, Phone, Mail, MessageSquare, CalendarClock, Clock, Loader2, History, ReceiptText,
  StickyNote, CalendarPlus, Activity, PoundSterling, Cake, NotebookPen,
} from "lucide-react";
import type { PatientRecord, AppointmentRecord, PlanRecord, NoteRecord } from "@/lib/dentally/read";
import type { PatientAdminStatus } from "@/lib/patient-status/types";
import type { NumberHealth } from "@/lib/messaging/number-health";
import { PatientNotesPanel } from "./patient-notes-panel";
import { PatientStatusManager } from "./patient-status-manager";
import { PatientProfileEditor } from "./patient-profile-editor";
import { PatientNumberHealth } from "./patient-number-health";
import type { PatientProfile } from "@/lib/patient/profile";

// The chip for a platform admin override (wins over Dentally's own active flag).
const OVERRIDE_CHIP: Record<PatientAdminStatus, { tone: Tone; label: string }> = {
  active: { tone: "success", label: "Active" },
  inactive: { tone: "neutral", label: "Inactive" },
  do_not_contact: { tone: "danger", label: "Do not contact" },
};

const APPT_STATE_TONE: Record<string, Tone> = {
  booked: "info",
  completed: "success",
  did_not_attend: "danger",
  cancelled: "neutral",
  pending: "info",
};
const APPT_STATE_LABEL: Record<string, string> = {
  booked: "Booked",
  completed: "Completed",
  did_not_attend: "No-show",
  cancelled: "Cancelled",
  pending: "Pending",
};

function statusOf(p: PatientRecord): { tone: Tone; label: string } {
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
  lookups = {},
  requestedPatientId = null,
  initialPatient = null,
}: {
  patients: PatientRecord[];
  nowIso: string;
  clientSlug: string;
  initialFilter?: PatientFilter;
  /** The id that arrived as ?patient=, so a record that could not be resolved is
   *  reported rather than silently doing nothing. */
  requestedPatientId?: string | null;
  /** That record, resolved SERVER-side by id. Null when it could not be loaded. */
  initialPatient?: PatientRecord | null;
  /** Platform admin overrides keyed by dentally patient id, for the site(s) in scope.
   *  Covers rows from the initial slice, search and filter alike (site-wide map). */
  overrides?: Record<string, PatientAdminStatus>;
  /** Number-health verdicts keyed by dentally patient id, batched for the visible slice,
   *  so a record opens with its deliverability chip already resolved. Rows beyond the
   *  slice (search/filter) resolve theirs from the drawer's own detail fetch instead. */
  lookups?: Record<string, NumberHealth>;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (initialPatient ? initialPatient.id : null),
  );
  // True when a ?patient= arrived that the server could not resolve. Saying so is
  // the point: a link from the diary that quietly does nothing is worse than none.
  const unresolvedPatient = Boolean(requestedPatientId) && initialPatient === null;
  const [filter, setFilter] = useState<PatientFilter>(initialFilter);
  // Server-side search: the initial `patients` prop is only a bounded first slice, so
  // to reach anyone beyond it we query Dentally directly (debounced). `serverResults`
  // is null when no search is active (show the initial slice), [] for "no matches".
  const [serverResults, setServerResults] = useState<PatientRecord[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Rows for the current filter, fetched server-side when the user changes segment.
  // Null means "use the server-rendered initial slice" (the initial active view, so
  // there is no fetch-flash on first paint). Non-null once a fetch has resolved.
  const [filterRows, setFilterRows] = useState<PatientRecord[] | null>(null);
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
        .then((d: { patients?: PatientRecord[] }) => {
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
      .then((d: { patients?: PatientRecord[] }) => {
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

  // Open a patient directly when arriving via the diary panel or the command
  // palette (?patient=id). Resolve against whichever rows are currently loaded
  // (slice, filter, or search), and otherwise against the record the SERVER
  // resolved by id, which is what makes the link work for any of the 52,000
  // patients rather than only those in the loaded slice.
  useEffect(() => {
    const pid = searchParams.get("patient");
    if (!pid) return;
    const inLoaded = loadedRows.some((p) => p.id === pid);
    const inSearch = serverResults?.some((p) => p.id === pid) ?? false;
    if (inLoaded || inSearch || initialPatient?.id === pid) setSelectedId(pid);
    // Consume the one-shot ?patient instruction: strip it from the URL so a refresh
    // lands on the clean list instead of re-opening the same record every time.
    //
    // window.history.replaceState, NEVER router.replace. This page is
    // force-dynamic and awaits searchParams, so router.replace re-runs it with no
    // ?patient, the server then resolves no initialPatient, and the drawer that
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
  }, [searchParams, loadedRows, serverResults, initialPatient, pathname]);

  // Precedence: an active search overrides the filter; otherwise the selected segment
  // (server-rendered slice for the initial segment, fetched rows for the rest).
  const rows = searchActive ? serverResults ?? [] : loadedRows;
  // serverResults === null counts as loading too: `searching` only flips true when
  // the effect runs AFTER the first post-keystroke paint, so without it the table
  // flashes "No patients match" for a frame before the spinner appears.
  const loading = searchActive ? searching || serverResults === null : filterLoading;

  // The selected patient may live in the current rows OR the current search results.
  const selected =
    loadedRows.find((p) => p.id === selectedId) ??
    serverResults?.find((p) => p.id === selectedId) ??
    (initialPatient && initialPatient.id === selectedId ? initialPatient : null);

  const emptyCopy = FILTER_EMPTY[filter];

  // py-3.5 on every cell gives the unboxed table a more generous vertical rhythm
  // than the shared default without touching the primitive.
  const columns: Column<PatientRecord>[] = [
    {
      key: "name",
      header: "Patient",
      cell: (p) => <span className="font-semibold text-navy">{p.name}</span>,
      className: "py-3.5",
    },
    {
      key: "contact",
      header: "Contact",
      cell: (p) => <span className="text-muted">{p.phone ?? p.email ?? "No contact"}</span>,
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
          onRowClick={(p) => setSelectedId(p.id)}
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

      {selected ? (
        <PatientDrawer
          patient={selected}
          now={now}
          onClose={() => setSelectedId(null)}
          initialOverride={overrides[selected.id] ?? null}
          initialHealth={lookups[selected.id]}
        />
      ) : null}
    </>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        <Icon size={12} /> {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums text-navy">{typeof value === "number" ? num(value) : value}</p>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  trailing,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  /** Optional node rendered inline after the value (e.g. the number-health chip). */
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
        <Icon size={14} />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
        <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
          {value}
          {trailing}
        </p>
      </div>
    </div>
  );
}

function hhmmDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function fmtDob(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
function ageFrom(dob: string | null, now: Date): number | null {
  if (!dob) return null;
  const b = new Date(dob);
  if (Number.isNaN(b.getTime())) return null;
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age -= 1;
  return age;
}

function PatientDrawer({
  patient,
  now,
  onClose,
  initialOverride,
  initialHealth,
}: {
  patient: PatientRecord;
  now: Date;
  onClose: () => void;
  initialOverride: PatientAdminStatus | null;
  /** Number-health seeded from the list batch (instant paint); the drawer's own detail
   *  fetch below confirms it and, for rows beyond the batched slice, resolves it. */
  initialHealth?: NumberHealth;
}) {
  useEscapeKey(onClose);
  // Platform override status, lifted here so the header chip and the body control stay in
  // sync within the session. Seeded from the list map; the manager confirms it against
  // the server on open and updates this on change.
  const [overrideStatus, setOverrideStatus] = useState<PatientAdminStatus | null>(initialOverride);
  // The header chip reflects the override when set, else the Dentally-derived status.
  const headerChip = overrideStatus ? OVERRIDE_CHIP[overrideStatus] : statusOf(patient);
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([]);
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [lifetimeSpend, setLifetimeSpend] = useState(0);
  const [outstanding, setOutstanding] = useState(0);
  // The number-health verdict from the drawer's own detail fetch. Authoritative once
  // loaded (covers search/filter rows outside the batched list slice); until then the
  // chip paints from initialHealth. null = the endpoint did not compute one (fall back).
  const [numberHealth, setNumberHealth] = useState<NumberHealth | null>(null);
  const [loading, setLoading] = useState(true);
  // The record after a save in the editor below. The list row this drawer opened from is
  // a snapshot, so once details have been edited we paint from the saved truth instead.
  const [edited, setEdited] = useState<PatientProfile | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setEdited(null);
    fetch(`/api/dentally/patients/${encodeURIComponent(patient.id)}?siteId=${encodeURIComponent(patient.siteId)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: { appointments?: AppointmentRecord[]; plans?: PlanRecord[]; notes?: NoteRecord[]; lifetimeSpend?: number; outstanding?: number; numberHealth?: NumberHealth | null }) => {
        if (!alive) return;
        setAppointments(d.appointments ?? []);
        setPlans(d.plans ?? []);
        setNotes(d.notes ?? []);
        setLifetimeSpend(d.lifetimeSpend ?? 0);
        setOutstanding(d.outstanding ?? 0);
        setNumberHealth(d.numberHealth ?? null);
      })
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [patient.id, patient.siteId]);

  const nowIso = now.toISOString();
  const completed = appointments.filter((a) => a.state === "completed");
  const lastSeen = completed[0]?.start ?? patient.lastVisitAt; // appointments are newest first
  const nextAppt = [...appointments]
    .reverse()
    .find((a) => a.start > nowIso && (a.state === "booked" || a.state === "pending"));

  // Prefer the edited record over the list snapshot, so a saved change is visible at once
  // rather than only after the page is reloaded.
  const shownName = edited ? `${edited.first_name ?? ""} ${edited.last_name ?? ""}`.trim() || patient.name : patient.name;
  const shownPhone = edited ? edited.mobile_phone : patient.phone;
  const shownEmail = edited ? edited.email_address : patient.email;
  const shownDob = edited ? edited.date_of_birth : patient.dateOfBirth;
  const age = ageFrom(shownDob, now);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-navy">{shownName}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusPill tone={headerChip.tone}>{headerChip.label}</StatusPill>
              <StatusPill tone="neutral">{getSite(patient.siteId)?.name ?? patient.siteId}</StatusPill>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <PatientStatusManager
            siteId={patient.siteId}
            patientId={patient.id}
            dentallyActive={patient.active}
            status={overrideStatus}
            onChange={setOverrideStatus}
            now={now}
          />

          <PatientProfileEditor
            // Remount on a different patient, so no half-edited form or stale snapshot
            // can ever carry across from the record viewed before this one.
            key={patient.id}
            siteId={patient.siteId}
            patientId={patient.id}
            now={now}
            onSaved={setEdited}
          />

          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat icon={Clock} label="Last seen" value={lastSeen ? relativeTime(lastSeen, now) : "No record"} />
            <Stat icon={CalendarPlus} label="Next appt" value={nextAppt ? hhmmDate(nextAppt.start) : "None booked"} />
            <Stat icon={Activity} label="Visits" value={completed.length} />
            <Stat icon={PoundSterling} label="Lifetime spend" value={gbp(lifetimeSpend)} />
            {outstanding > 0 ? <Stat icon={ReceiptText} label="Outstanding" value={gbp(outstanding)} /> : null}
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
              <Loader2 size={15} className="animate-spin" /> Loading record…
            </div>
          ) : (
            <div className="mt-5 grid gap-x-6 gap-y-5 md:grid-cols-2">
              {/* Left column: details + treatment plans */}
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-navy">Details</h3>
                  <div className="space-y-3.5">
                    <Field
                      icon={Phone}
                      label="Mobile"
                      value={shownPhone ?? "Not on file"}
                      trailing={<PatientNumberHealth health={numberHealth ?? initialHealth} />}
                    />
                    <Field icon={Mail} label="Email" value={shownEmail ?? "Not on file"} />
                    <Field
                      icon={Cake}
                      label="Date of birth"
                      value={shownDob ? `${fmtDob(shownDob)}${age != null ? ` · ${age} yrs` : ""}` : "Not on file"}
                    />
                    <Field icon={CalendarClock} label="Recall due" value={patient.recallDueAt ? relativeTime(patient.recallDueAt, now) : "Not set"} />
                    <Field
                      icon={MessageSquare}
                      label="Consent"
                      value={[patient.smsConsent ? "SMS" : null, patient.emailConsent ? "Email" : null].filter(Boolean).join(", ") || "No marketing consent"}
                    />
                  </div>
                </section>

                <section className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-navy">
                    <ReceiptText size={15} className="text-muted" /> Treatment plans
                  </h3>
                  {plans.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-sm text-muted">
                      No treatment plans on record.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {plans.map((p, i) => (
                        <li key={`${p.name}-${i}`} className="rounded-lg border border-line bg-card px-3 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <p className="min-w-0 truncate text-sm font-semibold text-navy">{p.name}</p>
                            <StatusPill tone={p.outstanding > 0 ? "warning" : "success"}>
                              {p.outstanding > 0 ? `${gbp(p.outstanding)} due` : "Paid"}
                            </StatusPill>
                          </div>
                          <p className="mt-0.5 text-xs text-muted">Plan value {gbp(p.planned)}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>

              {/* Right column: notes + appointment history */}
              <div className="space-y-5">
                <section className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-navy">
                    <StickyNote size={15} className="text-muted" /> Clinical notes (Dentally)
                  </h3>
                  {notes.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-sm text-muted">
                      No clinical notes in Dentally.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {notes.map((n) => (
                        <li key={n.id} className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5">
                          <p className="text-sm text-ink">{n.body}</p>
                          <p className="mt-1 text-[11px] text-muted">
                            {n.author}
                            {n.createdAt ? ` · ${relativeTime(n.createdAt, now)}` : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-navy">
                    <NotebookPen size={15} className="text-muted" /> Practice notes
                  </h3>
                  <PatientNotesPanel siteId={patient.siteId} patientId={patient.id} />
                </section>

                <section className="space-y-3">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-navy">
                    <History size={15} className="text-muted" /> Appointment history
                  </h3>
                  {appointments.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-sm text-muted">
                      No appointments on record.
                    </p>
                  ) : (
                    <ol className="space-y-2">
                      {appointments.map((a) => (
                        <li key={a.id} className="flex items-center gap-3 rounded-lg border border-line bg-card px-3 py-2.5">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-navy">{a.reason ?? "Appointment"}</p>
                            <p className="text-xs text-muted">
                              {hhmmDate(a.start)}
                              {a.practitioner ? ` · ${a.practitioner}` : ""}
                            </p>
                          </div>
                          <StatusPill tone={APPT_STATE_TONE[a.state] ?? "neutral"}>
                            {APPT_STATE_LABEL[a.state] ?? a.state}
                          </StatusPill>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
