"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Loader2,
  AlertTriangle,
  UserPlus,
  ChevronDown,
  ChevronRight,
  Paperclip,
  FileText,
  Mail,
  Phone,
  MapPin,
  Stethoscope,
  Calendar,
  CheckCircle2,
  Lock,
  ShieldAlert,
  BadgeCheck,
  X,
} from "lucide-react";
import { SectionCard, StatCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { OnboardingStatus } from "@/lib/onboarding/types";
import {
  classifyRegisterResponse,
  REGISTER_UNREACHABLE,
  type RegisterApiResponse,
  type RegisterOutcome,
} from "@/lib/onboarding/register-result";

// Internal staff worklist for new-patient onboarding submissions. Fetches the
// auth-gated /api/onboarding/list (newest first), renders a scannable worklist, and
// expands a row to the full submission (contact, address, medical intake, dental,
// documents). Staff can mark a submission reviewed via /api/onboarding/status.
//
// Registering a patient is a SEPARATE, deliberate action: "Register in Dentally" opens a
// confirm dialogue summarising every field that will be created, dedupe-checks Dentally
// via /api/onboarding/register, and only then creates the patient for real and flips the
// row to "registered" — this is the ONE-CLICK human approval the design calls for, so
// (unlike "Mark reviewed") it is never a bare, no-consequence status flip. Documents show
// name/type/size only — the list route strips raw storage paths, so there is no download
// here (documents are stored securely).

// Mirrors the sanitised submission shape the /list route returns (files carry only
// metadata — never a storage path).
interface SanitisedFile {
  name: string;
  size: number;
  type: string;
}

interface Submission {
  id: string;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  phone: string | null;
  email: string | null;
  address: {
    line1?: string;
    line2?: string;
    city?: string;
    postcode?: string;
  } | null;
  medical: {
    conditions?: string;
    medications?: string;
    allergies?: string;
    gp?: string;
  } | null;
  dental: {
    reason?: string;
    last_visit?: string;
    concerns?: string;
  } | null;
  heardAbout: string | null;
  files: SanitisedFile[];
  consent: { sms: boolean; email: boolean; marketing: boolean; data: boolean } | null;
  status: OnboardingStatus;
  createdAt: string;
}

interface ListResponse {
  submissions?: Submission[];
  stats?: { total: number; byStatus: { status: OnboardingStatus; count: number }[] };
  error?: string;
}

const STATUS_TONE: Record<OnboardingStatus, Tone> = {
  new: "info",
  reviewed: "warning",
  registered: "success",
  archived: "neutral",
};
const STATUS_LABEL: Record<OnboardingStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  registered: "Registered",
  archived: "Archived",
};

const HEARD_LABEL: Record<string, string> = {
  google: "Google",
  social: "Facebook or Instagram",
  referral: "Friend or family",
  walk_past: "Walked past the practice",
  other: "Other",
};
const LAST_VISIT_LABEL: Record<string, string> = {
  under_6m: "Within the last 6 months",
  "6_12m": "6 to 12 months ago",
  "1_2y": "1 to 2 years ago",
  over_2y: "More than 2 years ago",
  cant_remember: "Can't remember",
};

function fullName(s: Submission): string {
  const n = [s.firstName, s.lastName].filter(Boolean).join(" ").trim();
  return n || "New enquiry";
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDob(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

// The register response's shape, and the reading of it, live in
// @/lib/onboarding/register-result — a pure module with a test, because a branch
// here previously turned a REAL Dentally create into "Recorded in test mode".

export function SubmissionsWorklist({ clientSlug }: { clientSlug: string }) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});
  // The submission currently in the "Register in Dentally" confirm dialogue, if any.
  const [registerTarget, setRegisterTarget] = useState<Submission | null>(null);
  // Dentally patient ids for submissions registered THIS session, keyed by submission id.
  // Response-only (no onboarding_submission column exists to persist it), so this is a
  // transient, in-session note; it is not lost on close, only on a full page reload.
  const [registeredIds, setRegisteredIds] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/onboarding/list?client=${encodeURIComponent(clientSlug)}`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => null)) as ListResponse | null;
        if (cancelled) return;
        if (!res.ok || !json || json.error) {
          setLoadError(json?.error ?? "Could not load onboarding submissions.");
          setSubmissions([]);
          return;
        }
        setSubmissions(json.submissions ?? []);
      } catch {
        if (!cancelled) {
          setLoadError("Could not load onboarding submissions. Please try again.");
          setSubmissions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [clientSlug]);

  async function updateStatus(id: string, status: OnboardingStatus) {
    setUpdating((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await fetch("/api/onboarding/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientSlug, id, status }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (res.ok && json?.ok) {
        setSubmissions((prev) => prev.map((s) => (s.id === id ? { ...s, status } : s)));
      }
    } catch {
      // Best-effort: leave the row as-is on failure; staff can retry.
    } finally {
      setUpdating((prev) => ({ ...prev, [id]: false }));
    }
  }

  /** Called by RegisterDialog once /api/onboarding/register has actually created the
   *  patient: flips the row to registered locally (matching the server) and remembers
   *  the new Dentally id so it stays visible in the row after the dialogue closes. */
  function handleRegistered(id: string, patientId: string) {
    setSubmissions((prev) => prev.map((s) => (s.id === id ? { ...s, status: "registered" } : s)));
    setRegisteredIds((prev) => ({ ...prev, [id]: patientId }));
  }

  const counts = useMemo(() => {
    const c: Record<OnboardingStatus, number> = { new: 0, reviewed: 0, registered: 0, archived: 0 };
    for (const s of submissions) c[s.status] += 1;
    return c;
  }, [submissions]);

  // Headline numbers. While loading we show a dash so the cards never flash zero.
  const stat = (n: number) => (loading ? "—" : String(n));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="New" value={stat(counts.new)} dot="bg-status-amber" hint="Awaiting review" />
        <StatCard
          label="Reviewed"
          value={stat(counts.reviewed)}
          dot="bg-status-blue"
          hint="Checked, not yet registered"
        />
        <StatCard
          label="Registered"
          value={stat(counts.registered)}
          dot="bg-status-green"
          hint="Added to the practice"
        />
        <StatCard
          label="Total"
          value={stat(submissions.length)}
          dot="bg-line-strong"
          hint="All submissions"
        />
      </div>

      <SectionCard
      title="New patient submissions"
      description="Everyone who completed the onboarding form, newest first. Open a row to see the full details, then mark them reviewed or registered."
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Loader2 className="animate-spin" size={16} aria-hidden />
          Loading submissions&hellip;
        </div>
      ) : loadError ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
          <span>{loadError}</span>
        </div>
      ) : submissions.length === 0 ? (
        <EmptyState
          icon={UserPlus}
          title="No submissions yet"
          description="Share the onboarding link with new patients. As soon as someone completes the form, they will appear here ready for the team to review and register."
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="font-semibold text-navy">{submissions.length} total</span>
            <span aria-hidden>·</span>
            <span>{counts.new} new</span>
            <span aria-hidden>·</span>
            <span>{counts.reviewed} reviewed</span>
            <span aria-hidden>·</span>
            <span>{counts.registered} registered</span>
          </div>

          <ul className="divide-y divide-line">
            {submissions.map((s) => {
              const isOpen = expanded === s.id;
              const busy = updating[s.id];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                    className="flex w-full items-center gap-3 py-3.5 text-left transition-colors hover:bg-card-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
                  >
                    <span className="text-muted" aria-hidden>
                      {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-semibold text-navy">{fullName(s)}</span>
                        <StatusPill tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</StatusPill>
                      </span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                        <span>{whenLabel(s.createdAt)}</span>
                        {s.heardAbout ? (
                          <>
                            <span aria-hidden>·</span>
                            <span>Via {HEARD_LABEL[s.heardAbout] ?? s.heardAbout}</span>
                          </>
                        ) : null}
                        {s.files.length > 0 ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1">
                              <Paperclip size={11} aria-hidden />
                              {s.files.length} {s.files.length === 1 ? "document" : "documents"}
                            </span>
                          </>
                        ) : null}
                        {registeredIds[s.id] ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="inline-flex items-center gap-1 text-success">
                              <BadgeCheck size={11} aria-hidden />
                              Dentally ID {registeredIds[s.id]}
                            </span>
                          </>
                        ) : null}
                      </span>
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="motion-safe:[animation:assessEnter_200ms_ease-out] pb-5 pl-7 pr-1">
                      <SubmissionDetail submission={s} />

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => updateStatus(s.id, "reviewed")}
                          disabled={busy || s.status === "reviewed" || s.status === "registered"}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-card-muted hover:text-ink disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
                        >
                          {busy ? (
                            <Loader2 size={15} className="animate-spin" aria-hidden />
                          ) : (
                            <CheckCircle2 size={15} aria-hidden />
                          )}
                          Mark reviewed
                        </button>
                        {s.status === "registered" ? (
                          <span className="inline-flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-sm font-semibold text-success">
                            <CheckCircle2 size={15} aria-hidden />
                            Registered in Dentally
                            {registeredIds[s.id] ? ` · ID ${registeredIds[s.id]}` : ""}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setRegisterTarget(s)}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-sm font-semibold text-success transition-colors hover:bg-success/15 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40"
                          >
                            <UserPlus size={15} aria-hidden />
                            Register in Dentally
                          </button>
                        )}
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
      <style>{`@keyframes assessEnter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      </SectionCard>

      {registerTarget ? (
        <RegisterDialog
          submission={registerTarget}
          onClose={() => setRegisterTarget(null)}
          onRegistered={handleRegistered}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */

function SubmissionDetail({ submission: s }: { submission: Submission }) {
  const addressLines = s.address
    ? [s.address.line1, s.address.line2, s.address.city, s.address.postcode].filter(Boolean)
    : [];

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <DetailGroup title="Contact" icon={Mail}>
        <Field label="Email" value={s.email} icon={Mail} />
        <Field label="Mobile" value={s.phone} icon={Phone} />
        <Field label="Date of birth" value={s.dateOfBirth ? fmtDob(s.dateOfBirth) : null} icon={Calendar} />
      </DetailGroup>

      <DetailGroup title="Address" icon={MapPin}>
        {addressLines.length > 0 ? (
          <p className="text-sm text-ink">{addressLines.join(", ")}</p>
        ) : (
          <p className="text-sm text-muted">Not provided</p>
        )}
      </DetailGroup>

      <DetailGroup title="Reason for joining" icon={Stethoscope}>
        <Field label="Main reason" value={s.dental?.reason ?? null} />
        <Field
          label="Last dental visit"
          value={s.dental?.last_visit ? LAST_VISIT_LABEL[s.dental.last_visit] ?? s.dental.last_visit : null}
        />
        <Field label="Anything else" value={s.dental?.concerns ?? null} />
      </DetailGroup>

      <DetailGroup title="Medical intake" icon={Stethoscope}>
        <Field label="Conditions / medication" value={s.medical?.conditions ?? null} />
        <Field label="Allergies" value={s.medical?.allergies ?? null} />
        <Field label="GP / surgery" value={s.medical?.gp ?? null} />
      </DetailGroup>

      <DetailGroup title="Documents" icon={Paperclip} className="sm:col-span-2">
        {s.files.length === 0 ? (
          <p className="text-sm text-muted">No documents attached.</p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {s.files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2"
                >
                  <FileText size={15} className="shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{f.name}</span>
                  <span className="shrink-0 text-xs text-muted">{bytes(f.size)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <Lock size={12} aria-hidden />
              Documents are stored securely and are not downloadable from this list.
            </p>
          </>
        )}
      </DetailGroup>

      {s.consent ? (
        <DetailGroup title="Consent" icon={CheckCircle2} className="sm:col-span-2">
          <div className="flex flex-wrap gap-1.5">
            <ConsentChip label="Text" on={s.consent.sms} />
            <ConsentChip label="Email" on={s.consent.email} />
            <ConsentChip label="Practice updates" on={s.consent.marketing} />
            <ConsentChip label="Data processing" on={s.consent.data} />
          </div>
        </DetailGroup>
      ) : null}
    </div>
  );
}

function DetailGroup({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  icon: typeof Mail;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-line bg-card-muted/40 p-3.5", className)}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
        <Icon size={13} aria-hidden />
        {title}
      </p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | null;
  icon?: typeof Mail;
}) {
  return (
    <div className="text-sm">
      <span className="text-xs text-muted">{label}</span>
      <p className={cn("flex items-start gap-1.5", value ? "text-ink" : "text-muted")}>
        {Icon ? <Icon size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden /> : null}
        <span className="min-w-0 break-words">{value || "Not provided"}</span>
      </p>
    </div>
  );
}

function ConsentChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        on
          ? "border-success/20 bg-success/10 text-success"
          : "border-line-strong bg-card-muted text-muted",
      )}
    >
      {label}: {on ? "Yes" : "No"}
    </span>
  );
}

/* ------------------------------------------------------------------------- */
/* Register in Dentally: confirm -> dedupe-check -> create (one click, human-  */
/* approved). Talks to POST /api/onboarding/register (submissionId, force?).   */
/* ------------------------------------------------------------------------- */

type RegisterPhase = { kind: "confirm" } | { kind: "working" } | RegisterOutcome;

function RegisterDialog({
  submission: s,
  onClose,
  onRegistered,
}: {
  submission: Submission;
  onClose: () => void;
  onRegistered: (submissionId: string, patientId: string) => void;
}) {
  const [phase, setPhase] = useState<RegisterPhase>({ kind: "confirm" });
  const working = phase.kind === "working";
  const name = fullName(s);

  // Escape closes, except mid-request (nothing to interrupt safely).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !working) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, working]);

  async function submit(force: boolean) {
    setPhase({ kind: "working" });
    try {
      const res = await fetch("/api/onboarding/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ submissionId: s.id, ...(force ? { force: true } : {}) }),
      });
      const json = (await res.json().catch(() => null)) as RegisterApiResponse | null;
      // One pure function decides what happened, so "blocked" can never again be
      // rendered as a success with a reassuring footnote.
      const outcome = classifyRegisterResponse(res.status, json);
      // The row is only marked registered when a patient was ACTUALLY created.
      if (outcome.kind === "success") onRegistered(s.id, outcome.patientId);
      setPhase(outcome);
    } catch {
      setPhase({ kind: "error", message: REGISTER_UNREACHABLE });
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={working ? undefined : onClose}
        className="absolute inset-0 bg-navy/40 backdrop-blur-[1px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Register ${name} in Dentally`}
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-line bg-card shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-blue-deep">
              <UserPlus size={12} aria-hidden />
              Register in Dentally
            </p>
            <p className="mt-1 truncate text-sm font-semibold text-navy">{name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={working}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-muted transition-colors hover:bg-card-muted hover:text-ink disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
          >
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className="px-5 py-4">
          {phase.kind === "confirm" || phase.kind === "working" ? (
            <>
              <p className="text-sm text-muted">
                This checks Dentally for an existing match, then creates a new patient with
                exactly these details:
              </p>
              <dl className="mt-3 space-y-1.5 rounded-xl border border-line bg-card-muted/40 p-3.5 text-sm">
                <SummaryRow label="Name" value={name} />
                <SummaryRow
                  label="Date of birth"
                  value={s.dateOfBirth ? fmtDob(s.dateOfBirth) : "Not captured"}
                />
                <SummaryRow label="Mobile" value={s.phone ?? "Not provided"} />
                <SummaryRow label="Email" value={s.email ?? "Not provided"} />
                <SummaryRow
                  label="Consent to contact"
                  value={
                    s.consent
                      ? [s.consent.sms ? "SMS" : null, s.consent.email ? "Email" : null].filter(Boolean).join(", ") ||
                        "None given"
                      : "Not captured"
                  }
                />
              </dl>
              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={working}>
                  Cancel
                </Button>
                <Button type="button" variant="primary" size="sm" onClick={() => submit(false)} disabled={working}>
                  {working ? (
                    <Loader2 size={15} className="animate-spin" aria-hidden />
                  ) : (
                    <UserPlus size={15} aria-hidden />
                  )}
                  Confirm &amp; register
                </Button>
              </div>
            </>
          ) : phase.kind === "duplicate" ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3.5 py-3 text-sm">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-status-amber" aria-hidden />
                <div>
                  <p className="font-semibold text-navy">A patient who looks like this already exists</p>
                  <p className="mt-1 text-muted">
                    {phase.match.name}
                    {phase.match.dateOfBirth ? ` (born ${fmtDob(phase.match.dateOfBirth)})` : ""} at{" "}
                    {phase.match.site}, matched on {phase.match.matchedOn}.
                  </p>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted">
                Nothing has been created. Only continue if you are sure this is a different person.
              </p>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={working}>
                  Cancel
                </Button>
                <Button type="button" variant="primary" size="sm" onClick={() => submit(true)} disabled={working}>
                  {working ? <Loader2 size={15} className="animate-spin" aria-hidden /> : null}
                  Create anyway, this is a different person
                </Button>
              </div>
            </>
          ) : phase.kind === "success" ? (
            <>
              <div className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3.5 py-3 text-sm">
                <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-semibold text-success">Registered in Dentally</p>
                  <p className="mt-1 text-ink">
                    Dentally patient ID: <span className="font-mono">{phase.patientId}</span>
                  </p>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="primary" size="sm" onClick={onClose}>
                  Done
                </Button>
              </div>
            </>
          ) : phase.kind === "blocked" ? (
            /* SWITCHED OFF, not failed. Amber and not red, because nothing went
               wrong and a retry will not help: this environment simply cannot
               register patients. The words say plainly that nothing was created —
               the state this replaces said "Registered in Dentally / Recorded in
               test mode" over a create that had, in fact, just run for real. */
            <>
              <div className="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/10 px-3.5 py-3 text-sm">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-status-amber" aria-hidden />
                <div>
                  <p className="font-semibold text-navy">Registering is switched off</p>
                  <p className="mt-1 text-muted">{phase.message}</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-muted">
                This submission is unchanged and stays on the worklist, so it can be registered
                once it is switched on.
              </p>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          ) : (
            <>
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3.5 py-3 text-sm text-danger"
              >
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>{phase.message}</span>
              </div>
              <div className="mt-4 flex justify-end">
                <Button type="button" variant="secondary" size="sm" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="truncate pl-3 text-right font-medium text-ink">{value}</dd>
    </div>
  );
}
