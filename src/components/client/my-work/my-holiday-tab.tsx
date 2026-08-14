"use client";

import { useMemo, useState } from "react";
import { CalendarOff, CheckCircle2, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatCard, StatusPill } from "@/components/primitives";
import { partitionAbsences } from "@/lib/absence/rules";
import type { AbsenceKind, AbsenceRow } from "@/lib/absence/types";
import { ABSENCE_KINDS } from "@/lib/absence/types";
import { mineOnly, panelStateFor, type LoadFailure } from "@/lib/my-work/rules";
import { KIND_LABEL, STATUS_LABEL, STATUS_TONE, daysLabel, rangeLabel } from "../absence/shared";
import { PanelShell } from "./panel-shell";

// MY HOLIDAY — the caller's own requests, and a form to raise another.
//
// There is no "who is this for" field, by design: the staff id is resolved from
// the SESSION on the server (findStaffByAppUser) and the body's staffId is not
// read for a non-approver, so there is nothing here to spoof. `mineOnly` below
// is the second lock on the same claim — if a route were ever widened by
// accident, this screen would still show one person's holiday.
//
// Nothing on this tab decides anything. `canCancel` arrives already computed on
// each row by @/lib/absence/rules, and validation is the server's `validateRequest`,
// whose refusal is shown here verbatim.

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

interface FormValues {
  kind: AbsenceKind;
  startDate: string;
  endDate: string;
  note: string;
}

function emptyForm(): FormValues {
  return { kind: "holiday", startDate: "", endDate: "", note: "" };
}

export function MyHolidayTab({
  clientSlug,
  selfStaffId,
  rows,
  loading,
  failure,
  onChanged,
}: {
  clientSlug: string;
  selfStaffId: string | null;
  /** Absence rows as the server decorated them. Narrowed again here. */
  rows: AbsenceRow[];
  loading: boolean;
  failure: LoadFailure | null;
  /** Re-read the list after a successful write. */
  onChanged: () => Promise<void>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormValues>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mine = useMemo(() => mineOnly(rows, selfStaffId), [rows, selfStaffId]);
  const parts = useMemo(() => partitionAbsences(mine), [mine]);

  const state = panelStateFor({
    subject: "your holiday",
    consequence: "you cannot put in a holiday request",
    loading,
    linked: selfStaffId !== null,
    failure,
    count: mine.length,
  });

  const pending = mine.filter((r) => r.status === "pending").length;
  const booked = mine.filter((r) => r.status === "approved" && !r.past).length;

  function set<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit() {
    setSubmitting(true);
    setFormError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/absence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          // NO staffId. The server resolves it from the session for a
          // non-approver and ignores anything sent here, so sending one would
          // be theatre at best and misleading at worst.
          kind: form.kind,
          startDate: form.startDate,
          endDate: form.endDate,
          note: form.note.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not send the request (${res.status}).`);
      setShowForm(false);
      setForm(emptyForm());
      setMessage("Request sent. Your practice manager will approve or refuse it.");
      await onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setSubmitting(false);
    }
  }

  async function cancel(id: string) {
    if (busyId) return;
    if (!window.confirm("Withdraw this request? You can put another one in afterwards.")) return;
    setBusyId(id);
    setActionError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/absence/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, action: "cancel" }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not withdraw it (${res.status}).`);
      setMessage("Request withdrawn.");
      await onChanged();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not withdraw it.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionCard
      title="My holiday"
      description="Time off you have asked for, and where each request has got to. Approved days come out of the rota automatically."
      actions={
        state.kind === "ready" || state.kind === "unlinked" ? (
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="sm"
            disabled={selfStaffId === null}
            onClick={() => {
              setFormError(null);
              setShowForm((s) => !s);
            }}
          >
            {showForm ? <X size={15} /> : <Plus size={15} />}
            {showForm ? "Cancel" : "Ask for time off"}
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        {state.kind === "ready" ? (
          <div className="flex flex-wrap gap-x-7 gap-y-4">
            <StatCard label="Awaiting a decision" value={pending} dot="bg-status-amber" hint="Your requests" emphasis />
            <StatCard label="Booked ahead" value={booked} dot="bg-status-green" hint="Approved and still to come" />
          </div>
        ) : null}

        {message ? (
          <p className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            {message}
          </p>
        ) : null}
        {actionError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        ) : null}

        {showForm && selfStaffId ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!submitting) void submit();
            }}
            className="rounded-xl border border-line-strong bg-card-muted/40 p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="my-absence-kind" className={labelClass}>
                  Type <span className="text-danger">*</span>
                </label>
                <select
                  id="my-absence-kind"
                  value={form.kind}
                  onChange={(e) => set("kind", e.target.value as AbsenceKind)}
                  className={inputClass}
                >
                  {ABSENCE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="my-absence-note" className={labelClass}>
                  Note
                </label>
                <input
                  id="my-absence-note"
                  type="text"
                  value={form.note}
                  onChange={(e) => set("note", e.target.value)}
                  placeholder="Anything your manager should know"
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="my-absence-start" className={labelClass}>
                  First day away <span className="text-danger">*</span>
                </label>
                <input
                  id="my-absence-start"
                  type="date"
                  required
                  value={form.startDate}
                  onChange={(e) => set("startDate", e.target.value)}
                  className={inputClass}
                />
              </div>
              <div>
                <label htmlFor="my-absence-end" className={labelClass}>
                  Last day away <span className="text-danger">*</span>
                </label>
                <input
                  id="my-absence-end"
                  type="date"
                  required
                  value={form.endDate}
                  onChange={(e) => set("endDate", e.target.value)}
                  className={inputClass}
                />
              </div>
            </div>

            {formError ? (
              <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Send the request
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setShowForm(false);
                  setFormError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : null}

        <PanelShell
          state={state}
          loadingLabel="Loading your holiday..."
          empty={
            <EmptyState
              icon={CalendarOff}
              title="You have not asked for any time off"
              description="Holiday, sickness, training or unpaid leave. Put a request in and your practice manager decides."
            >
              <Button variant="primary" size="sm" disabled={selfStaffId === null} onClick={() => setShowForm(true)}>
                <Plus size={15} /> Ask for time off
              </Button>
            </EmptyState>
          }
        >
          <div className="space-y-5">
            <AbsenceGroup
              title="Awaiting a decision"
              rows={parts.awaiting}
              busyId={busyId}
              onCancel={cancel}
              emptyMessage="Nothing is waiting for a decision."
            />
            <AbsenceGroup
              title="Booked and coming up"
              rows={parts.upcoming}
              busyId={busyId}
              onCancel={cancel}
              emptyMessage="Nothing booked."
            />
            <AbsenceGroup
              title="Finished"
              rows={parts.past}
              busyId={busyId}
              onCancel={cancel}
              emptyMessage="Nothing has been and gone."
            />
          </div>
        </PanelShell>
      </div>
    </SectionCard>
  );
}

function AbsenceGroup({
  title,
  rows,
  busyId,
  onCancel,
  emptyMessage,
}: {
  title: string;
  rows: AbsenceRow[];
  busyId: string | null;
  onCancel: (id: string) => void;
  emptyMessage: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">{emptyMessage}</p>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-navy">
                  {rangeLabel(row.startDate, row.endDate)}
                </p>
                <p className="mt-0.5 text-[12.5px] text-muted">
                  {KIND_LABEL[row.kind]} · {daysLabel(row.days)}
                  {row.note ? ` · ${row.note}` : ""}
                </p>
                {row.decisionNote ? (
                  <p className="mt-0.5 text-[12.5px] text-muted">Manager&apos;s note: {row.decisionNote}</p>
                ) : null}
              </div>
              <StatusPill tone={STATUS_TONE[row.status]}>{STATUS_LABEL[row.status]}</StatusPill>
              {row.canCancel ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busyId !== null}
                  onClick={() => onCancel(row.id)}
                >
                  {busyId === row.id ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
                  Withdraw
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
