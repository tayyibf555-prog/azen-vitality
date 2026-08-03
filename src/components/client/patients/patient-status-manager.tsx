"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { StatusPill, type Tone } from "@/components/primitives";
import { useAuth } from "@/lib/auth/mock-auth";
import { cn, relativeTime } from "@/lib/utils";
import { Loader2, ShieldAlert, Check, X, History } from "lucide-react";
import { isPatientAdminRole } from "@/lib/patient/roles";
import { FAILED_COPY } from "@/lib/patient/tabs";
import { PanelFailed } from "@/components/client/patients/record/panel";
import type { DentallySyncResult, PatientAdminStatus } from "@/lib/patient-status/types";

// Roles allowed to SEE and USE the control come from lib/patient/roles, the same list the
// server guard reads, so the two can never drift. The server (PATCH
// /api/patients/[id]/status) is the real enforcement; this only hides UI.

const STATUS_META: Record<PatientAdminStatus, { label: string; tone: Tone; blurb: string }> = {
  active: {
    label: "Active",
    tone: "success",
    blurb: "Contactable. Included in campaigns, recalls and appointment reminders.",
  },
  inactive: {
    label: "Inactive",
    tone: "neutral",
    // Names the three lifecycles that genuinely stop, because a manager marking someone
    // inactive is quietly removing them from all the automated follow-up, and that
    // consequence should be stated rather than discovered months later.
    blurb:
      "Takes them out of the automated follow-up: no recall reminders, no reactivation, and no treatment follow-ups from the coordinator. They can still book or text you, and you can still reply.",
  },
  do_not_contact: {
    label: "Do not contact",
    tone: "danger",
    // Honest to the actual behaviour: the drain AND the inbox reply path both block a
    // suppressed patient ref, and the inbound agent hands their texts to a human instead
    // of auto-replying. So the platform genuinely sends them nothing. The second sentence
    // is the owner-confirmed clarification that patient-initiated flows still work.
    blurb: "No messages at all. The platform will not send this patient any SMS, email or WhatsApp - including replies to their own texts; incoming messages are handed to your team. They can still fill in forms or book themselves; the practice will just never message them until this is changed.",
  },
};

const ORDER: PatientAdminStatus[] = ["active", "inactive", "do_not_contact"];

interface AuditEntry {
  id: string;
  fromStatus: PatientAdminStatus | null;
  toStatus: PatientAdminStatus;
  reason: string | null;
  actorEmail: string | null;
  dentallyResult: DentallySyncResult | null;
  createdAt: string;
}

/** Honest one-liner about what happened at Dentally, shown after a save. */
function dentallyResultCopy(r: DentallySyncResult): string {
  switch (r) {
    case "synced":
      return "Updated here and in Dentally.";
    case "unsupported":
      return "Saved here. Dentally has no matching setting, so it was not changed there.";
    case "failed":
      return "Saved here. The Dentally update failed - it may need changing in Dentally directly.";
    case "skipped":
      return "Saved here. Dentally write-back is not enabled, so nothing was changed there.";
  }
}

function actorShort(email: string | null): string {
  if (!email) return "Someone";
  return email.split("@")[0] || email;
}

export function PatientStatusManager({
  siteId,
  patientId,
  dentallyActive,
  status,
  statusUnavailable = false,
  onChange,
  now,
}: {
  siteId: string;
  patientId: string;
  /** Dentally's own active flag for this patient (secondary signal). */
  dentallyActive: boolean;
  /** The platform override status lifted to the drawer, or null when none is set. */
  status: PatientAdminStatus | null;
  /** The SERVER's own override read threw before this rendered. */
  statusUnavailable?: boolean;
  onChange: (next: PatientAdminStatus | null) => void;
  now: Date;
}) {
  const { user } = useAuth();
  const canManage = user ? isPatientAdminRole(user.role) : false;
  const router = useRouter();

  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  // The authoritative status read below THREW. Held rather than swallowed: with no
  // override loaded this control falls back to Dentally's active flag, so a patient
  // the practice marked do_not_contact would present as ordinary and active. On a
  // suppression marker the safe-looking default is the wrong one.
  const [loadFailed, setLoadFailed] = useState(false);
  // The status the user has selected in the menu and is about to confirm.
  const [pending, setPending] = useState<PatientAdminStatus | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Load the authoritative override + audit trail once per patient.
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    fetch(`/api/patients/${encodeURIComponent(patientId)}/status?siteId=${encodeURIComponent(siteId)}`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((d: { ok?: boolean; override?: { status?: PatientAdminStatus } | null; audit?: AuditEntry[] }) => {
        if (!alive) return;
        if (d.ok === false) {
          setLoadFailed(true);
          return;
        }
        setLoadFailed(false);
        setAudit(d.audit ?? []);
        // Sync the lifted status to the server truth (may differ from the list hint).
        onChange(d.override?.status ?? null);
      })
      .catch(() => {
        if (alive) setLoadFailed(true);
      })
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
    // onChange is a stable setState wrapper from the parent; excluded deliberately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, siteId]);

  // The effective status: the platform override wins; with none, fall back to Dentally's
  // own active flag. This is the chip the practice sees.
  const effective: PatientAdminStatus = status ?? (dentallyActive ? "active" : "inactive");
  const meta = STATUS_META[effective];
  // Either the server render or this component's own read failed. Either way we do
  // not know this patient's status and must not print one.
  const unavailable = statusUnavailable || loadFailed;

  // Show Dentally's own flag as secondary ONLY when an override exists AND they disagree
  // (e.g. platform 'inactive' but Dentally still 'active'). do_not_contact has no Dentally
  // equivalent, so we surface the Dentally flag there too for transparency.
  const showDentallySecondary =
    status !== null && (status === "do_not_contact" || (status === "active") !== dentallyActive);

  async function confirmChange() {
    if (!pending) return;
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch(`/api/patients/${encodeURIComponent(patientId)}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteId, status: pending, reason: reason.trim() || undefined }),
      });
      const d: { ok?: boolean; status?: PatientAdminStatus; dentally?: DentallySyncResult; error?: string } =
        await res.json();
      if (!res.ok || !d.ok || !d.status) {
        setResult({ ok: false, message: d.error ? `Could not update status: ${d.error}` : "Could not update status." });
      } else {
        onChange(d.status);
        // The record page's header chip is rendered from a SERVER layout that survives
        // tab navigation, so without this the header still read "Active" after this
        // control was set to "Do not contact", and stayed wrong for the session.
        router.refresh();
        setResult({ ok: true, message: dentallyResultCopy(d.dentally ?? "skipped") });
        // Refresh the audit trail so the new entry appears immediately.
        fetch(`/api/patients/${encodeURIComponent(patientId)}/status?siteId=${encodeURIComponent(siteId)}`, {
          cache: "no-store",
        })
          .then((r) => r.json())
          .then((dd: { audit?: AuditEntry[] }) => setAudit(dd.audit ?? []))
          .catch(() => {});
      }
    } catch {
      setResult({ ok: false, message: "Could not update status." });
    } finally {
      setSaving(false);
      setPending(null);
      setReason("");
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-line bg-card-muted/30 px-4 py-3.5">
      {unavailable ? <PanelFailed>{FAILED_COPY.status}</PanelFailed> : null}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Status</span>
          {unavailable ? (
            <StatusPill tone="neutral">{FAILED_COPY.statusChip}</StatusPill>
          ) : (
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          )}
          {showDentallySecondary ? (
            <span className="text-[11px] text-faint">Dentally: {dentallyActive ? "active" : "inactive"}</span>
          ) : null}
        </div>

        {canManage ? (
          <div className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
            {ORDER.map((s) => {
              const active = effective === s;
              return (
                <button
                  key={s}
                  type="button"
                  disabled={saving}
                  aria-pressed={active}
                  onClick={() => {
                    setResult(null);
                    // Re-selecting the current status is a no-op; otherwise open confirm.
                    setPending(active ? null : s);
                  }}
                  className={cn(
                    "pressable rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                    active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
                    saving && "opacity-60",
                  )}
                >
                  {STATUS_META[s].label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Inline confirm panel (the drawer is already a modal, so we avoid stacking one). */}
      {pending ? (
        <div className="space-y-3 rounded-lg border border-line-strong bg-card px-3.5 py-3">
          <p className="flex items-start gap-2 text-[12.5px] text-ink">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-status-amber" />
            <span>
              Set this patient to <span className="font-semibold">{STATUS_META[pending].label}</span>?{" "}
              {STATUS_META[pending].blurb}
            </span>
          </p>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted">Reason (optional)</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. patient asked us to stop contacting them"
              className="mt-1 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-[13px] text-ink placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={confirmChange}
              disabled={saving}
              className="pressable inline-flex items-center gap-1.5 rounded-lg bg-navy px-3.5 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-60"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              Confirm
            </button>
            <button
              type="button"
              onClick={() => {
                setPending(null);
                setReason("");
              }}
              disabled={saving}
              className="pressable inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3.5 py-1.5 text-[12.5px] font-medium text-muted hover:text-navy disabled:opacity-60"
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Honest result line (no toast system in this app). */}
      {result ? (
        <p className={cn("text-[12px]", result.ok ? "text-status-green" : "text-status-red")}>{result.message}</p>
      ) : null}

      {/* Status history (hairline list). */}
      {loaded && audit.length > 0 ? (
        <div className="space-y-1.5 border-t border-line pt-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            <History size={12} /> Status history
          </p>
          <ul className="space-y-1">
            {audit.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline gap-x-1.5 text-[11.5px] text-muted">
                <span className="font-medium text-navy">{STATUS_META[a.toStatus]?.label ?? a.toStatus}</span>
                <span className="text-faint">
                  by {actorShort(a.actorEmail)}
                  {a.createdAt ? ` · ${relativeTime(a.createdAt, now)}` : ""}
                </span>
                {a.reason ? <span className="text-faint">- {a.reason}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
