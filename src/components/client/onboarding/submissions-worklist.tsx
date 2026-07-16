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
  Inbox,
  ClipboardCheck,
  Users,
} from "lucide-react";
import { SectionCard, StatCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { cn } from "@/lib/utils";
import type { OnboardingStatus } from "@/lib/onboarding/types";

// Internal staff worklist for new-patient onboarding submissions. Fetches the
// auth-gated /api/onboarding/list (newest first), renders a scannable worklist, and
// expands a row to the full submission (contact, address, medical intake, dental,
// documents). Staff can mark a submission reviewed or registered via
// /api/onboarding/status. Documents show name/type/size only — the list route strips
// raw storage paths, so there is no download here (documents are stored securely).

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

export function SubmissionsWorklist({ clientSlug }: { clientSlug: string }) {
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [updating, setUpdating] = useState<Record<string, boolean>>({});

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

  const counts = useMemo(() => {
    const c: Record<OnboardingStatus, number> = { new: 0, reviewed: 0, registered: 0, archived: 0 };
    for (const s of submissions) c[s.status] += 1;
    return c;
  }, [submissions]);

  // Headline numbers. While loading we show a dash so the cards never flash zero.
  const stat = (n: number) => (loading ? "—" : String(n));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="New" value={stat(counts.new)} icon={Inbox} hint="Awaiting review" />
        <StatCard
          label="Reviewed"
          value={stat(counts.reviewed)}
          icon={ClipboardCheck}
          hint="Checked, not yet registered"
        />
        <StatCard
          label="Registered"
          value={stat(counts.registered)}
          icon={UserPlus}
          hint="Added to the practice"
        />
        <StatCard
          label="Total"
          value={stat(submissions.length)}
          icon={Users}
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
          description="Share the onboarding link with new patients. As soon as someone completes the form, they will appear here ready for the team to review and register. This view is mock safe, so it stays empty until a submission arrives."
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
                          disabled={busy || s.status === "reviewed"}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-sm font-semibold text-muted transition-colors hover:bg-card-muted hover:text-ink disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
                        >
                          {busy ? (
                            <Loader2 size={15} className="animate-spin" aria-hidden />
                          ) : (
                            <CheckCircle2 size={15} aria-hidden />
                          )}
                          Mark reviewed
                        </button>
                        <button
                          type="button"
                          onClick={() => updateStatus(s.id, "registered")}
                          disabled={busy || s.status === "registered"}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/10 px-3 py-1.5 text-sm font-semibold text-success transition-colors hover:bg-success/15 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/40"
                        >
                          {busy ? (
                            <Loader2 size={15} className="animate-spin" aria-hidden />
                          ) : (
                            <UserPlus size={15} aria-hidden />
                          )}
                          Mark registered
                        </button>
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
        <Field
          label="Date of birth"
          value={
            s.dateOfBirth
              ? new Date(s.dateOfBirth).toLocaleDateString("en-GB", {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })
              : null
          }
          icon={Calendar}
        />
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
