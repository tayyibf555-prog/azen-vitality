"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, gbp, num, relativeTime } from "@/lib/utils";
import { getSite } from "@/lib/mock";
import { useEscapeKey } from "@/lib/hooks/use-escape-key";
import {
  Search, X, Phone, Mail, MessageSquare, CalendarClock, Clock, Loader2, History, ReceiptText,
  StickyNote, CalendarPlus, Activity, PoundSterling, Cake,
} from "lucide-react";
import type { PatientRecord, AppointmentRecord, PlanRecord, NoteRecord } from "@/lib/dentally/read";

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

export function PatientsTable({ patients, nowIso }: { patients: PatientRecord[]; nowIso: string }) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const searchParams = useSearchParams();
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Open a patient directly when arriving via the command palette (?patient=id).
  useEffect(() => {
    const pid = searchParams.get("patient");
    if (pid && patients.some((p) => p.id === pid)) setSelectedId(pid);
  }, [searchParams, patients]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return patients;
    return patients.filter((p) =>
      [p.name, p.email ?? "", p.phone ?? ""].some((v) => v.toLowerCase().includes(needle)),
    );
  }, [patients, q]);

  const selected = patients.find((p) => p.id === selectedId) ?? null;

  const columns: Column<PatientRecord>[] = [
    { key: "name", header: "Patient", cell: (p) => <span className="font-semibold text-navy">{p.name}</span> },
    {
      key: "contact",
      header: "Contact",
      cell: (p) => <span className="text-muted">{p.phone ?? p.email ?? "No contact"}</span>,
    },
    {
      key: "site",
      header: "Site",
      cell: (p) => <span className="text-muted">{getSite(p.siteId)?.name ?? p.siteId}</span>,
    },
    {
      key: "last",
      header: "Last visit",
      cell: (p) => <span className="text-muted">{p.lastVisitAt ? relativeTime(p.lastVisitAt, now) : "No record"}</span>,
      align: "right",
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
    },
    {
      key: "status",
      header: "Status",
      cell: (p) => {
        const s = statusOf(p);
        return <StatusPill tone={s.tone}>{s.label}</StatusPill>;
      },
      align: "right",
    },
  ];

  return (
    <>
      <SectionCard
        title="All patients"
        description="Click a patient to open their record."
        actions={
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone or email"
              className="w-64 rounded-full border border-line-strong bg-card py-1.5 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
            />
          </div>
        }
        bodyClassName="p-0"
      >
        <DataTable
          columns={columns}
          rows={rows}
          getRowKey={(p) => p.id}
          onRowClick={(p) => setSelectedId(p.id)}
          className="px-2 py-1"
          empty={<EmptyState title="No patients match" description="Try a different search." className="m-4" />}
        />
      </SectionCard>

      {selected ? <PatientDrawer patient={selected} now={now} onClose={() => setSelectedId(null)} /> : null}
    </>
  );
}

function Stat({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-card-muted/40 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
        <Icon size={12} className="text-blue-dark" /> {label}
      </p>
      <p className="mt-0.5 text-sm font-bold text-navy">{typeof value === "number" ? num(value) : value}</p>
    </div>
  );
}

function Field({ icon: Icon, label, value }: { icon: typeof Phone; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
        <Icon size={14} />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
        <p className="text-sm text-ink">{value}</p>
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

function PatientDrawer({ patient, now, onClose }: { patient: PatientRecord; now: Date; onClose: () => void }) {
  useEscapeKey(onClose);
  const s = statusOf(patient);
  const [appointments, setAppointments] = useState<AppointmentRecord[]>([]);
  const [plans, setPlans] = useState<PlanRecord[]>([]);
  const [notes, setNotes] = useState<NoteRecord[]>([]);
  const [lifetimeSpend, setLifetimeSpend] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/dentally/patients/${encodeURIComponent(patient.id)}?siteId=${encodeURIComponent(patient.siteId)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: { appointments?: AppointmentRecord[]; plans?: PlanRecord[]; notes?: NoteRecord[]; lifetimeSpend?: number }) => {
        if (!alive) return;
        setAppointments(d.appointments ?? []);
        setPlans(d.plans ?? []);
        setNotes(d.notes ?? []);
        setLifetimeSpend(d.lifetimeSpend ?? 0);
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
  const age = ageFrom(patient.dateOfBirth, now);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <div className="relative z-10 flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-extrabold text-navy">{patient.name}</h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusPill tone={s.tone}>{s.label}</StatusPill>
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
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat icon={Clock} label="Last seen" value={lastSeen ? relativeTime(lastSeen, now) : "No record"} />
            <Stat icon={CalendarPlus} label="Next appt" value={nextAppt ? hhmmDate(nextAppt.start) : "None booked"} />
            <Stat icon={Activity} label="Visits" value={completed.length} />
            <Stat icon={PoundSterling} label="Lifetime spend" value={gbp(lifetimeSpend)} />
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
                  <h3 className="text-sm font-extrabold text-navy">Details</h3>
                  <div className="space-y-3.5">
                    <Field icon={Phone} label="Mobile" value={patient.phone ?? "Not on file"} />
                    <Field icon={Mail} label="Email" value={patient.email ?? "Not on file"} />
                    <Field
                      icon={Cake}
                      label="Date of birth"
                      value={patient.dateOfBirth ? `${fmtDob(patient.dateOfBirth)}${age != null ? ` · ${age} yrs` : ""}` : "Not on file"}
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
                  <h3 className="flex items-center gap-2 text-sm font-extrabold text-navy">
                    <ReceiptText size={15} className="text-blue-dark" /> Treatment plans
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
                  <h3 className="flex items-center gap-2 text-sm font-extrabold text-navy">
                    <StickyNote size={15} className="text-blue-dark" /> Notes
                  </h3>
                  {notes.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-line-strong bg-card-muted/40 px-3 py-3 text-center text-sm text-muted">
                      No notes on record.
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
                  <h3 className="flex items-center gap-2 text-sm font-extrabold text-navy">
                    <History size={15} className="text-blue-dark" /> Appointment history
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
