"use client";

import { useMemo, useState } from "react";
import { SectionCard, StatusPill, DataTable, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, relativeTime } from "@/lib/utils";
import { getSite } from "@/lib/mock";
import { Search, X, Phone, Mail, MessageSquare, CalendarClock, Clock } from "lucide-react";
import type { PatientRecord } from "@/lib/dentally/read";

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
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

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

function PatientDrawer({ patient, now, onClose }: { patient: PatientRecord; now: Date; onClose: () => void }) {
  const s = statusOf(patient);
  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="Close panel" onClick={onClose} className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]" />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-[440px] flex-col overflow-y-auto border-l border-line bg-card shadow-2xl">
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line bg-card px-6 py-5">
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
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-card-muted hover:text-navy",
            )}
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-5 px-6 py-5">
          <Field icon={Phone} label="Mobile" value={patient.phone ?? "Not on file"} />
          <Field icon={Mail} label="Email" value={patient.email ?? "Not on file"} />
          <Field
            icon={Clock}
            label="Last visit"
            value={patient.lastVisitAt ? relativeTime(patient.lastVisitAt, now) : "No record"}
          />
          <Field
            icon={CalendarClock}
            label="Recall due"
            value={patient.recallDueAt ? relativeTime(patient.recallDueAt, now) : "Not set"}
          />
          <Field
            icon={MessageSquare}
            label="Consent"
            value={[patient.smsConsent ? "SMS" : null, patient.emailConsent ? "Email" : null]
              .filter(Boolean)
              .join(", ") || "No marketing consent"}
          />
        </div>
      </aside>
    </div>
  );
}
