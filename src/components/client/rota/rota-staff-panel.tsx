"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2, X, Pause, Play, Pencil, Trash2, Users, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import { getSites } from "@/lib/mock/clients";
import type { Availability, RotaStaff, Weekday } from "@/lib/rota/types";
import {
  ROTA_ROLES,
  ROTA_WEEKDAYS,
  WEEKDAY_SHORT,
  roleLabel,
  siteName,
} from "./shared";

// The "Staff" tab: manage the rota_staff list.
//
// Each row shows the person's name, role, site, phone and availability (Mon-Sat chips
// highlighted when available), with an active toggle, inline edit and remove. The add
// form collects name, role, site, phone, email and availability day toggles. All writes
// go through the owner/manager-gated /api/rota/staff endpoints.

interface FormState {
  name: string;
  role: string;
  siteId: string; // "" = any site
  phone: string;
  email: string;
  availability: Availability;
}

function emptyForm(): FormState {
  return { name: "", role: "dentist", siteId: "", phone: "", email: "", availability: {} };
}

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

/** The availability day toggles, shared by the add form and inline edit. */
function AvailabilityToggles({
  idPrefix,
  value,
  onToggle,
}: {
  idPrefix: string;
  value: Availability;
  onToggle: (day: Weekday) => void;
}) {
  return (
    <div className="mt-1 flex flex-wrap gap-1.5" role="group" aria-label="Availability by day">
      {ROTA_WEEKDAYS.map((day) => {
        const on = value[day] === true;
        return (
          <button
            key={day}
            id={`${idPrefix}-${day}`}
            type="button"
            role="switch"
            aria-checked={on}
            aria-label={WEEKDAY_SHORT[day]}
            onClick={() => onToggle(day)}
            className={
              "rounded-lg border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 " +
              (on
                ? "border-blue-dark/30 bg-blue-dark/10 text-blue-deep"
                : "border-line bg-card text-muted hover:bg-card-muted hover:text-ink")
            }
          >
            {WEEKDAY_SHORT[day]}
          </button>
        );
      })}
    </div>
  );
}

/** Read-only availability chips for a row, Mon-Sat, highlighted when available. */
function AvailabilityChips({ availability }: { availability: Availability }) {
  return (
    <div className="flex flex-wrap gap-1">
      {ROTA_WEEKDAYS.map((day) => {
        const on = availability[day] === true;
        return (
          <span
            key={day}
            className={
              "rounded-md border px-1.5 py-0.5 text-[11px] font-semibold " +
              (on
                ? "border-blue-dark/25 bg-blue-dark/10 text-blue-deep"
                : "border-line bg-card-muted/50 text-muted/70")
            }
          >
            {WEEKDAY_SHORT[day]}
          </span>
        );
      })}
    </div>
  );
}

export function RotaStaffPanel({
  clientSlug,
  onChanged,
}: {
  clientSlug: string;
  onChanged: () => void;
}) {
  const sites = getSites(clientSlug);

  const [staff, setStaff] = useState<RotaStaff[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(emptyForm());
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/rota/staff?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; staff?: RotaStaff[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load staff (${res.status}).`);
      setStaff(data.staff ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load staff.");
      setStaff([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  useEffect(() => {
    setShowForm(false);
    setForm(emptyForm());
    setFormError(null);
    setEditingId(null);
    void load();
  }, [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function toggleDay(day: Weekday) {
    setForm((f) => ({ ...f, availability: { ...f.availability, [day]: !(f.availability[day] === true) } }));
  }

  function toggleEditDay(day: Weekday) {
    setEditForm((f) => ({ ...f, availability: { ...f.availability, [day]: !(f.availability[day] === true) } }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/rota/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          name: form.name,
          role: form.role,
          siteId: form.siteId || null,
          phone: form.phone.trim() || null,
          email: form.email.trim() || null,
          availability: form.availability,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; staff?: RotaStaff; error?: string };
      if (!res.ok || !data.ok || !data.staff) {
        throw new Error(data.error || `Could not add the staff member (${res.status}).`);
      }
      setForm(emptyForm());
      setShowForm(false);
      await load();
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not add the staff member.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleActive(person: RotaStaff) {
    if (busyId) return;
    const next = !person.active;
    setBusyId(person.id);
    setStaff((prev) => prev.map((s) => (s.id === person.id ? { ...s, active: next } : s)));
    try {
      const res = await fetch(`/api/rota/staff/${encodeURIComponent(person.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, active: next }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "status update failed");
      onChanged();
    } catch {
      setStaff((prev) => prev.map((s) => (s.id === person.id ? { ...s, active: person.active } : s)));
    } finally {
      setBusyId(null);
    }
  }

  function startEdit(person: RotaStaff) {
    setEditingId(person.id);
    setEditError(null);
    setEditForm({
      name: person.name,
      role: person.role,
      siteId: person.siteId ?? "",
      phone: person.phone ?? "",
      email: person.email ?? "",
      availability: { ...person.availability },
    });
  }

  async function saveEdit(person: RotaStaff) {
    if (busyId) return;
    setBusyId(person.id);
    setEditError(null);
    try {
      const res = await fetch(`/api/rota/staff/${encodeURIComponent(person.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          name: editForm.name,
          role: editForm.role,
          siteId: editForm.siteId || null,
          phone: editForm.phone.trim() || null,
          email: editForm.email.trim() || null,
          availability: editForm.availability,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not save (${res.status}).`);
      setEditingId(null);
      await load();
      onChanged();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Could not save the changes.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(person: RotaStaff) {
    if (busyId) return;
    if (!window.confirm(`Remove ${person.name} from the rota? Their upcoming shifts are removed too.`)) return;
    setBusyId(person.id);
    try {
      const res = await fetch(`/api/rota/staff/${encodeURIComponent(person.id)}?client=${encodeURIComponent(clientSlug)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "delete failed");
      setStaff((prev) => prev.filter((s) => s.id !== person.id));
      onChanged();
    } catch {
      // Leave the row in place on failure; a reload will reconcile.
    } finally {
      setBusyId(null);
    }
  }

  /** The role + site + phone/email fields, shared by add and edit (differs only in id prefix). */
  function fields(state: FormState, update: <K extends keyof FormState>(k: K, v: FormState[K]) => void, prefix: string) {
    return (
      <>
        <div>
          <label htmlFor={`${prefix}-name`} className={labelClass}>
            Name <span className="text-danger">*</span>
          </label>
          <input
            id={`${prefix}-name`}
            type="text"
            required
            value={state.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder="Alex Morgan"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={`${prefix}-role`} className={labelClass}>
            Role <span className="text-danger">*</span>
          </label>
          <select
            id={`${prefix}-role`}
            value={state.role}
            onChange={(e) => update("role", e.target.value)}
            className={inputClass}
          >
            {ROTA_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${prefix}-site`} className={labelClass}>
            Site
          </label>
          <select
            id={`${prefix}-site`}
            value={state.siteId}
            onChange={(e) => update("siteId", e.target.value)}
            className={inputClass}
          >
            <option value="">Any site</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${prefix}-phone`} className={labelClass}>
            Phone
          </label>
          <input
            id={`${prefix}-phone`}
            type="tel"
            value={state.phone}
            onChange={(e) => update("phone", e.target.value)}
            placeholder="+447700900123"
            className={inputClass}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={`${prefix}-email`} className={labelClass}>
            Email
          </label>
          <input
            id={`${prefix}-email`}
            type="email"
            value={state.email}
            onChange={(e) => update("email", e.target.value)}
            placeholder="alex@practice.co.uk"
            className={inputClass}
          />
        </div>
      </>
    );
  }

  return (
    <SectionCard
      title="Staff"
      description="Everyone the rota can schedule. Set each person's role, home site and which days they are available. Only staff with a phone number are texted their shifts."
      actions={
        <Button
          variant={showForm ? "secondary" : "primary"}
          size="sm"
          onClick={() => {
            setFormError(null);
            setShowForm((s) => !s);
          }}
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? "Cancel" : "Add staff"}
        </Button>
      }
    >
      <div className="space-y-5">
        {showForm ? (
          <form onSubmit={submit} className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
            <div className="grid gap-4 sm:grid-cols-2">{fields(form, set, "add")}</div>
            <div className="mt-4">
              <span className={labelClass}>Available days</span>
              <AvailabilityToggles idPrefix="add-day" value={form.availability} onToggle={toggleDay} />
            </div>

            {formError ? (
              <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={submitting || form.name.trim().length === 0}>
                {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                Add staff
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

        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading staff...
          </div>
        ) : staff.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No staff yet"
            description="Add your team and set who is available on which days. The rota then schedules them automatically from each site's opening hours."
          >
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              <Plus size={15} /> Add staff
            </Button>
          </EmptyState>
        ) : (
          <ul className="space-y-3">
            {staff.map((person) => (
              <li
                key={person.id}
                className="rounded-xl border border-line bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(10,14,26,0.04)]"
              >
                {editingId === person.id ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      {fields(editForm, (k, v) => setEditForm((f) => ({ ...f, [k]: v })), `edit-${person.id}`)}
                    </div>
                    <div>
                      <span className={labelClass}>Available days</span>
                      <AvailabilityToggles
                        idPrefix={`edit-day-${person.id}`}
                        value={editForm.availability}
                        onToggle={toggleEditDay}
                      />
                    </div>

                    {editError ? (
                      <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                        {editError}
                      </p>
                    ) : null}

                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busyId !== null || editForm.name.trim().length === 0}
                        onClick={() => saveEdit(person)}
                      >
                        {busyId === person.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Save
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyId !== null}
                        onClick={() => {
                          setEditingId(null);
                          setEditError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-semibold text-navy">{person.name}</p>
                        <StatusPill tone="info">{roleLabel(person.role)}</StatusPill>
                        <StatusPill tone={person.active ? "success" : "neutral"}>
                          {person.active ? "Active" : "Paused"}
                        </StatusPill>
                      </div>
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <span>{siteName(clientSlug, person.siteId)}</span>
                        {person.phone ? (
                          <>
                            <span aria-hidden>&middot;</span>
                            <span className="tabular-nums">{person.phone}</span>
                          </>
                        ) : (
                          <>
                            <span aria-hidden>&middot;</span>
                            <span className="text-warning">No phone number, not texted</span>
                          </>
                        )}
                      </p>
                      <AvailabilityChips availability={person.availability} />
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => toggleActive(person)}
                        disabled={busyId !== null}
                      >
                        {busyId === person.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : person.active ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {person.active ? "Pause" : "Activate"}
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => startEdit(person)} disabled={busyId !== null}>
                        <Pencil size={14} /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(person)} disabled={busyId !== null}>
                        <Trash2 size={14} /> Remove
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
