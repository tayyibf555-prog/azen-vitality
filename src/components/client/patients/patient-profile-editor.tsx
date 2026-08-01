"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, History, Loader2, Pencil, ShieldAlert, X } from "lucide-react";
import { cn, relativeTime } from "@/lib/utils";
import { useAuth } from "@/lib/auth/mock-auth";
import { isPatientAdminRole } from "@/lib/patient/roles";
import {
  FIELD_LABELS,
  PAYMENT_PLANS,
  TITLES,
  type PatientProfile,
  type ProfileField,
} from "@/lib/patient/profile";

// Edit a patient's details, for owners and practice managers only.
//
// Two things make this safe, and both live on the SERVER; this component only makes them
// legible. First, the form posts ONLY the fields that were touched, together with the
// snapshot it was loaded with, so an edit of one field cannot overwrite the rest and a
// colleague's simultaneous edit is refused rather than silently lost. Second, every save
// is recorded field by field in the patient's admin history, shown at the bottom here.
//
// The ACTIVE flag is deliberately NOT duplicated here: it is set in the Status control
// directly above, which keeps Dentally, the platform override and the messaging
// suppression rows in step. Two switches for one flag is how records drift.

interface AuditEntry {
  id: string;
  field: string;
  label: string;
  from: string | null;
  to: string;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: string | null;
  createdAt: string;
}

/** Text inputs, in the order a person reads a record. */
const TEXT_FIELDS: Array<{ field: ProfileField; type: "text" | "email" | "tel" | "date"; hint?: string }> = [
  { field: "first_name", type: "text" },
  { field: "last_name", type: "text" },
  { field: "date_of_birth", type: "date" },
  { field: "mobile_phone", type: "tel", hint: "UK mobile, any format" },
  { field: "email_address", type: "email", hint: "Leave blank if they have none" },
  { field: "address_line_1", type: "text" },
  { field: "address_line_2", type: "text" },
  { field: "address_line_3", type: "text" },
  { field: "postcode", type: "text" },
];

const INPUT_CLASS =
  "mt-1 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25 disabled:opacity-60";

/** The form's string view of a value. Everything is edited as text; the server re-parses. */
function asText(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function actorShort(email: string | null): string {
  if (!email) return "Someone";
  return email.split("@")[0] || email;
}

/** How one audit line reads: "Mobile: +4477... (was 07...)". Empty means cleared. */
function auditLine(a: AuditEntry): string {
  const to = a.to === "" ? "cleared" : a.to;
  return a.from ? `${a.label}: ${to} (was ${a.from})` : `${a.label}: ${to}`;
}

export function PatientProfileEditor({
  siteId,
  patientId,
  now,
  onSaved,
}: {
  siteId: string;
  patientId: string;
  now: Date;
  /** Lets the drawer repaint its header/details from the saved record. */
  onSaved?: (profile: PatientProfile) => void;
}) {
  const { user } = useAuth();
  const canEdit = user ? isPatientAdminRole(user.role) : false;
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /** The record as the server last told us it stands. Posted back as `expected`. */
  const [baseline, setBaseline] = useState<PatientProfile | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [editingEnabled, setEditingEnabled] = useState(true);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<string, string>>>({});
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const seed = useCallback((p: PatientProfile) => {
    setBaseline(p);
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) next[k] = asText(v as string | number | boolean | null);
    setForm(next);
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    fetch(
      `/api/patients/${encodeURIComponent(patientId)}/profile?siteId=${encodeURIComponent(siteId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: { ok?: boolean; profile?: PatientProfile; audit?: AuditEntry[]; editingEnabled?: boolean }) => {
        if (!d.ok || !d.profile) {
          setResult({ ok: false, message: "We could not load this patient's details." });
          return;
        }
        seed(d.profile);
        setAudit(d.audit ?? []);
        setEditingEnabled(d.editingEnabled !== false);
      })
      .catch(() => setResult({ ok: false, message: "We could not load this patient's details." }))
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, [patientId, siteId, seed]);

  // Opening the panel is what triggers the load, straight from the click rather than from
  // an effect: the drawer is already fetching plenty, and there is nothing to synchronise.
  // Opening a DIFFERENT patient remounts this component (the drawer keys it on the patient
  // id), so there is no stale state to reset either.
  function toggle() {
    setOpen((wasOpen) => {
      if (!wasOpen && !loaded) load();
      return !wasOpen;
    });
  }

  if (!canEdit) return null;

  /** Only what the user actually touched, compared against the loaded snapshot. */
  function touchedChanges(): Record<string, string | number | boolean | null> {
    if (!baseline) return {};
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(form)) {
      const field = key as ProfileField;
      if (field === "active") continue; // owned by the Status control above
      if (value === asText(baseline[field])) continue;
      if (field === "payment_plan_id") out[field] = value === "" ? null : Number(value);
      else if (field === "gender") out[field] = value === "" ? null : value === "true";
      else out[field] = value;
    }
    return out;
  }

  const dirty = Object.keys(touchedChanges()).length > 0;

  async function save() {
    const changes = touchedChanges();
    if (!baseline || Object.keys(changes).length === 0 || saving) return;
    setSaving(true);
    setResult(null);
    setFieldErrors({});
    try {
      const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, changes, expected: baseline, reason: reason.trim() || undefined }),
      });
      const d: {
        ok?: boolean;
        changed?: ProfileField[];
        profile?: PatientProfile;
        auditRecorded?: boolean;
        error?: string;
        message?: string;
        fields?: Record<string, string>;
        conflicts?: ProfileField[];
      } = await res.json();

      if (!res.ok || !d.ok) {
        if (d.fields) setFieldErrors(d.fields);
        const conflictNote = d.conflicts?.length
          ? ` Affected: ${d.conflicts.map((f) => FIELD_LABELS[f] ?? f).join(", ")}.`
          : "";
        setResult({
          ok: false,
          message: (d.message ?? "We could not save those changes.") + conflictNote,
        });
        // A conflict means our snapshot is stale: reload so the next attempt is honest.
        if (res.status === 409) load();
        return;
      }

      if (d.profile) {
        seed(d.profile);
        onSaved?.(d.profile);
        // The record page's HEADER is rendered from a server layout that is preserved
        // across tab navigation, so without this a renamed patient kept the old name
        // in the <h1> for the rest of the session while this form showed the new one.
        // Harmless where there is no server tree above (the quick view): refresh is a
        // no-op there.
        router.refresh();
      }
      setReason("");
      const n = d.changed?.length ?? 0;
      setResult({
        ok: true,
        message:
          n === 0
            ? "Nothing had changed, so nothing was sent."
            : `Saved ${n} ${n === 1 ? "change" : "changes"} to Dentally.` +
              (d.auditRecorded === false ? " The change history could not be written, so tell your administrator." : ""),
      });
      // Refresh the trail so the new entries appear.
      fetch(`/api/patients/${encodeURIComponent(patientId)}/profile?siteId=${encodeURIComponent(siteId)}`, {
        cache: "no-store",
      })
        .then((r) => r.json())
        .then((dd: { audit?: AuditEntry[] }) => setAudit(dd.audit ?? []))
        .catch(() => {});
    } catch {
      setResult({ ok: false, message: "We could not save those changes." });
    } finally {
      setSaving(false);
    }
  }

  function set(field: ProfileField, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  const disabled = saving || !editingEnabled;

  return (
    <section className="mt-3 space-y-3 rounded-xl border border-line bg-card-muted/30 px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted">Patient details</span>
        <button
          type="button"
          onClick={toggle}
          className="pressable inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-1.5 text-[12.5px] font-medium text-muted hover:text-navy"
        >
          <Pencil size={13} /> {open ? "Close" : "Edit details"}
        </button>
      </div>

      {open ? (
        loading ? (
          <p className="flex items-center gap-2 py-4 text-[13px] text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading the record…
          </p>
        ) : (
          <div className="space-y-3.5">
            {!editingEnabled ? (
              <p className="flex items-start gap-2 rounded-lg border border-line-strong bg-card px-3 py-2.5 text-[12.5px] text-ink">
                <ShieldAlert size={15} className="mt-0.5 shrink-0 text-status-amber" />
                <span>
                  Patient editing is switched off, so these details are read only. Changes are not being sent to
                  Dentally at the moment.
                </span>
              </p>
            ) : (
              <p className="text-[12px] text-muted">
                Changes here are written straight to this patient&apos;s Dentally record. Only the fields you
                actually change are sent, and every change is logged below with your name.
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Title</span>
                <select
                  value={form.title ?? ""}
                  disabled={disabled}
                  onChange={(e) => set("title", e.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Not set</option>
                  {TITLES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {fieldErrors.title ? <span className="text-[11px] text-status-red">{fieldErrors.title}</span> : null}
              </label>

              {TEXT_FIELDS.map(({ field, type, hint }) => (
                <label key={field} className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    {FIELD_LABELS[field]}
                  </span>
                  <input
                    type={type}
                    value={form[field] ?? ""}
                    disabled={disabled}
                    placeholder={hint}
                    onChange={(e) => set(field, e.target.value)}
                    className={INPUT_CLASS}
                  />
                  {fieldErrors[field] ? (
                    <span className="text-[11px] text-status-red">{fieldErrors[field]}</span>
                  ) : null}
                </label>
              ))}

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Gender</span>
                <select
                  value={form.gender ?? ""}
                  disabled={disabled}
                  onChange={(e) => set("gender", e.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Not set</option>
                  <option value="true">Male</option>
                  <option value="false">Female</option>
                </select>
                {fieldErrors.gender ? <span className="text-[11px] text-status-red">{fieldErrors.gender}</span> : null}
              </label>

              <label className="block">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Payment plan</span>
                <select
                  value={form.payment_plan_id ?? ""}
                  disabled={disabled}
                  onChange={(e) => set("payment_plan_id", e.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Not set</option>
                  {PAYMENT_PLANS.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {fieldErrors.payment_plan_id ? (
                  <span className="text-[11px] text-status-red">{fieldErrors.payment_plan_id}</span>
                ) : null}
              </label>
            </div>

            <p className="text-[11.5px] text-faint">
              Whether this patient is active or inactive is set in Status, just above. Making someone inactive takes
              them out of recalls, reactivation and the treatment follow-ups.
            </p>

            {editingEnabled ? (
              <>
                <label className="block">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Reason (optional)</span>
                  <input
                    value={reason}
                    disabled={saving}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. patient gave us a new number at reception"
                    className={INPUT_CLASS}
                  />
                </label>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={save}
                    disabled={saving || !dirty}
                    className="pressable inline-flex items-center gap-1.5 rounded-lg bg-navy px-3.5 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-60"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Save changes
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (baseline) seed(baseline);
                      setFieldErrors({});
                      setResult(null);
                      setReason("");
                    }}
                    disabled={saving || !dirty}
                    className="pressable inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-medium text-muted hover:text-navy disabled:opacity-60"
                  >
                    <X size={14} /> Discard
                  </button>
                </div>
              </>
            ) : null}

            {result ? (
              <p className={cn("text-[12px]", result.ok ? "text-status-green" : "text-status-red")}>{result.message}</p>
            ) : null}

            {audit.length > 0 ? (
              <div className="space-y-1.5 border-t border-line pt-2.5">
                <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                  <History size={12} /> Change history
                </p>
                <ul className="space-y-1">
                  {audit.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] text-muted">
                      <span className="font-medium text-navy">{auditLine(a)}</span>
                      <span className="text-faint">
                        by {actorShort(a.actorEmail)}
                        {a.createdAt ? ` · ${relativeTime(a.createdAt, now)}` : ""}
                      </span>
                      {a.dentallyResult === "failed" ? (
                        <span className="text-status-red">- Dentally refused this, so it was not saved</span>
                      ) : null}
                      {a.reason ? <span className="text-faint">- {a.reason}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
