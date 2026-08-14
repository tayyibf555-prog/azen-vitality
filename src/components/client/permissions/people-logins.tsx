"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Mail,
  Plus,
  ShieldOff,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { linkableFor } from "@/lib/provisioning/rules";
import type { AuthStatus, LinkableStaff, Person } from "@/lib/provisioning/types";

// ===========================================================================
// PEOPLE & LOGINS — the practice's own user administration, as a dumb component.
//
// Every decision it renders was made by the server: which roles may be handed out,
// whether an action is allowed, and what the refusal says. This file holds no rule.
// When a write is refused it prints the sentence the API returned, verbatim, because
// that sentence came from a tested pure function and re-wording it here would create
// a second, untested copy of the rule.
//
// LOUD FAILURE, THREE WAYS. A screen about who can get in must never look calm when
// it does not know the answer:
//   * `available: false`   this environment cannot provision at all -> say so, no table;
//   * `authReadable: false` Supabase Auth could not be read -> banner, statuses show
//                          "unknown", and every status-changing control is disabled;
//   * `staffReadable: false` rota records are unavailable -> the link control is
//                          disabled with the reason, not silently empty.
// ===========================================================================

interface RoleOption {
  role: string;
  label: string;
  blurb: string;
}

interface PeopleResponse {
  ok?: boolean;
  available?: boolean;
  reason?: string;
  roles?: RoleOption[];
  delivery?: "email" | "link";
  people?: Person[];
  staff?: LinkableStaff[];
  authReadable?: boolean;
  authError?: string | null;
  staffReadable?: boolean;
  selfId?: string | null;
  error?: string;
}

const STATUS_LABEL: Record<AuthStatus, string> = {
  active: "Active",
  invited: "Invited",
  deactivated: "Deactivated",
  missing: "No login yet",
  unknown: "Unknown",
};

const STATUS_TONE: Record<AuthStatus, Tone> = {
  active: "success",
  invited: "info",
  deactivated: "danger",
  missing: "warning",
  unknown: "neutral",
};

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";
const rowSelectClass =
  "rounded-lg border border-line bg-card-muted px-2 py-1 text-[12.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30 disabled:opacity-50";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/** The one-time link panel. Shown once, copied by the owner, never persisted. */
function OneTimeLink({ link, name, onDismiss }: { link: string; name: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const absolute = link.startsWith("http") || typeof window === "undefined" ? link : `${window.location.origin}${link}`;
  return (
    <div className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-3 text-sm">
      <p className="font-semibold text-navy">Send this link to {name}</p>
      <p className="mt-1 text-[12.5px] text-muted">
        It is shown once and works once. Pass it on in person or by a message only they can read, and
        never in a shared inbox or group chat. They choose their own password; nobody here will see it.
      </p>
      <div className="mt-2.5 flex items-center gap-2">
        <input readOnly value={absolute} className="min-w-0 flex-1 rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12px] text-ink" />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void navigator.clipboard?.writeText(absolute).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            });
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
          Done
        </Button>
      </div>
    </div>
  );
}

export function PeopleLogins({ clientSlug }: { clientSlug: string }) {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ link: string; name: string } | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", role: "client_staff" });
  const [inviting, setInviting] = useState(false);

  // THE READ IS SPLIT: `read` fetches and returns, `apply` is the only thing that
  // writes state, and the effect calls it from the promise's callback rather than
  // in its own body — the use-diary-day / use-self-service house pattern. It is a
  // lint rule (a setState reachable synchronously from an effect is a cascading
  // render) and a correctness one: `cancelled` retires an in-flight answer when
  // the screen unmounts or the practice changes, which this file did not do.
  const read = useCallback(async (): Promise<{ people: PeopleResponse | null; error: string | null }> => {
    try {
      const res = await fetch(`/api/people?client=${encodeURIComponent(clientSlug)}`);
      const json = (await res.json()) as PeopleResponse;
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not load this practice's logins.");
      return { people: json, error: null };
    } catch (e) {
      return {
        people: null,
        error: e instanceof Error ? e.message : "Could not load this practice's logins.",
      };
    }
  }, [clientSlug]);

  const apply = useCallback((result: { people: PeopleResponse | null; error: string | null }) => {
    if (result.people) setData(result.people);
    setLoadError(result.error);
  }, []);

  /** For event handlers only — never called from an effect. */
  const load = useCallback(async () => {
    apply(await read());
  }, [read, apply]);

  useEffect(() => {
    let cancelled = false;
    read()
      .then((result) => {
        if (!cancelled) apply(result);
      })
      .catch(() => {
        if (!cancelled) apply({ people: null, error: "Could not load this practice's logins." });
      });
    return () => {
      cancelled = true;
    };
  }, [read, apply]);

  async function patch(personId: string, body: Record<string, unknown>) {
    setActionError(null);
    setBusyId(personId);
    try {
      const res = await fetch(`/api/people/${encodeURIComponent(personId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, ...body }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; link?: string | null };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "That change could not be completed.");
      if (json.link) {
        const person = data?.people?.find((p) => p.id === personId);
        setIssued({ link: json.link, name: person?.name ?? "them" });
      }
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "That change could not be completed.");
    } finally {
      setBusyId(null);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setActionError(null);
    setInviting(true);
    try {
      const res = await fetch("/api/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, ...form }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; link?: string | null };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Could not add that person.");
      if (json.link) setIssued({ link: json.link, name: form.name });
      setShowInvite(false);
      setForm({ name: "", email: "", role: "client_staff" });
      await load();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Could not add that person.");
    } finally {
      setInviting(false);
    }
  }

  if (loadError) {
    return (
      <SectionCard title="Couldn't load logins">
        <p className="text-sm text-muted">{loadError}</p>
        <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={() => void load()}>
          Try again
        </Button>
      </SectionCard>
    );
  }

  if (!data) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> Loading logins…
      </p>
    );
  }

  if (data.available === false) {
    return (
      <SectionCard title="People & logins">
        <div className="flex items-start gap-2.5 rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-status-amber" />
          <div className="text-sm">
            <p className="font-semibold text-navy">Not switched on in this environment</p>
            <p className="mt-0.5 text-[12.5px] text-muted">{data.reason}</p>
          </div>
        </div>
      </SectionCard>
    );
  }

  const people = data.people ?? [];
  const staff = data.staff ?? [];
  const roles = data.roles ?? [];
  const authReadable = data.authReadable !== false;
  const staffReadable = data.staffReadable !== false;
  const selfId = data.selfId ?? null;

  return (
    <div className="space-y-6">
      {issued ? <OneTimeLink link={issued.link} name={issued.name} onDismiss={() => setIssued(null)} /> : null}

      {!authReadable ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-status-amber" />
          <div className="text-sm">
            <p className="font-semibold text-navy">Sign-in status could not be read</p>
            <p className="mt-0.5 text-[12.5px] text-muted">
              {data.authError ?? "The sign-in directory did not answer."} Everything below is this
              practice&apos;s record of who should have access; whether each login actually works is not
              known right now, so those controls are switched off.
            </p>
          </div>
        </div>
      ) : null}

      {actionError ? (
        <p className="rounded-xl border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
          {actionError}
        </p>
      ) : null}

      <SectionCard
        title="People & logins"
        description="Who can sign in to this practice, what they can reach, and which staff record each login belongs to."
        actions={
          <Button type="button" variant="primary" size="sm" onClick={() => setShowInvite((v) => !v)}>
            {showInvite ? <Plus size={14} className="rotate-45" /> : <UserPlus size={14} />}
            {showInvite ? "Cancel" : "Invite somebody"}
          </Button>
        }
      >
        {showInvite ? (
          <form onSubmit={invite} className="mb-5 rounded-xl border border-line bg-card-muted/60 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="pl-name" className={labelClass}>
                  Full name <span className="text-danger">*</span>
                </label>
                <input
                  id="pl-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Blerta Hoxha"
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label htmlFor="pl-email" className={labelClass}>
                  Work email <span className="text-danger">*</span>
                </label>
                <input
                  id="pl-email"
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  placeholder="blerta@vitalitydental.co.uk"
                  className={inputClass}
                  required
                />
              </div>
              <div>
                <label htmlFor="pl-role" className={labelClass}>
                  Access level <span className="text-danger">*</span>
                </label>
                <select
                  id="pl-role"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  className={inputClass}
                >
                  {roles.map((r) => (
                    <option key={r.role} value={r.role}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="mt-2 text-[12.5px] text-muted">
              {roles.find((r) => r.role === form.role)?.blurb ?? ""}
            </p>
            <p className="mt-2 text-[12.5px] text-muted">
              {data.delivery === "email"
                ? "They will get an email with a link to choose their own password. You will never see it."
                : "You will get a one-time link to pass on. They choose their own password; you will never see it."}
            </p>
            <div className="mt-3 flex justify-end">
              <Button type="submit" variant="primary" size="sm" disabled={inviting}>
                {inviting ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
                Send invite
              </Button>
            </div>
          </form>
        ) : null}

        {people.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No logins yet"
            description="Invite the people who need to use the platform. Each one chooses their own password."
          />
        ) : (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-wide text-muted">
                  <th className="px-1 py-2 font-semibold">Person</th>
                  <th className="px-1 py-2 font-semibold">Access level</th>
                  <th className="px-1 py-2 font-semibold">Sign-in</th>
                  <th className="px-1 py-2 font-semibold">Staff record</th>
                  <th className="px-1 py-2 text-right font-semibold">Login</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const isSelf = selfId !== null && p.id === selfId;
                  const busy = busyId === p.id;
                  const options = linkableFor(staff, p.id);
                  return (
                    <tr key={p.id} className="border-b border-line/70 align-middle">
                      <td className="px-1 py-2.5">
                        <p className="font-semibold text-navy">
                          {p.name}
                          {isSelf ? <span className="ml-1.5 text-[11.5px] font-medium text-muted">(you)</span> : null}
                        </p>
                        <p className="text-[12px] text-muted">{p.email}</p>
                      </td>
                      <td className="px-1 py-2.5">
                        <select
                          aria-label={`Access level for ${p.name}`}
                          className={rowSelectClass}
                          value={p.role}
                          disabled={busy || isSelf || !authReadable}
                          onChange={(e) => void patch(p.id, { action: "role", role: e.target.value })}
                        >
                          {roles.map((r) => (
                            <option key={r.role} value={r.role}>
                              {r.label}
                            </option>
                          ))}
                          {roles.every((r) => r.role !== p.role) ? (
                            <option value={p.role}>{p.role}</option>
                          ) : null}
                        </select>
                      </td>
                      <td className="px-1 py-2.5">
                        <StatusPill tone={STATUS_TONE[p.authStatus]}>{STATUS_LABEL[p.authStatus]}</StatusPill>
                        <p className="mt-1 text-[11.5px] text-muted">
                          {p.authStatus === "unknown" ? "not checked" : `signed in ${relative(p.lastSignInAt)}`}
                        </p>
                      </td>
                      <td className="px-1 py-2.5">
                        {!staffReadable ? (
                          <span className="text-[12px] text-muted">Staff records unavailable</span>
                        ) : (
                          <select
                            aria-label={`Staff record for ${p.name}`}
                            className={rowSelectClass}
                            value={p.linkedStaff?.id ?? ""}
                            disabled={busy}
                            onChange={(e) =>
                              void patch(p.id, { action: "link-staff", staffId: e.target.value || null })
                            }
                          >
                            <option value="">Not linked</option>
                            {options.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name} — {s.role}
                              </option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="px-1 py-2.5">
                        <div className="flex items-center justify-end gap-1.5">
                          {busy ? <Loader2 size={14} className="animate-spin text-muted" /> : null}
                          {p.authStatus !== "active" && authReadable ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => void patch(p.id, { action: "resend-invite" })}
                            >
                              <Link2 size={13} /> Resend invite
                            </Button>
                          ) : null}
                          {p.authStatus === "deactivated" ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={busy}
                              onClick={() => void patch(p.id, { action: "reactivate" })}
                            >
                              Reactivate
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy || isSelf || !authReadable || p.authStatus === "missing"}
                              onClick={() => void patch(p.id, { action: "deactivate" })}
                            >
                              <ShieldOff size={13} /> Deactivate
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="How access works here">
        <ul className="space-y-1.5 text-[12.5px] text-muted">
          <li>
            <strong className="text-navy">Nobody here ever sets a password.</strong> An invite sends a
            one-time link; the person chooses their own password in their own browser.
          </li>
          <li>
            <strong className="text-navy">Deactivating is reversible.</strong> It blocks the login and
            keeps everything else — their access level, their staff record and their history — exactly
            as it is. Reactivate and their old password still works.
          </li>
          <li>
            <strong className="text-navy">You cannot lock the practice out.</strong> You cannot
            deactivate or change your own access level, and the last owner login cannot be removed.
          </li>
          <li>
            <strong className="text-navy">Linking a staff record</strong> is what lets somebody clock in
            and see their own rota. One login belongs to one staff record.
          </li>
        </ul>
      </SectionCard>
    </div>
  );
}
