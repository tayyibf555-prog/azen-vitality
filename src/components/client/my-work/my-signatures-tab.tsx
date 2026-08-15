"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, FileSignature, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusPill } from "@/components/primitives";
import {
  ESIGN_COPY,
  SIGNATURE_TYPED_CAP,
  type StaffPolicy,
  type StaffPolicySignatureSummary,
} from "@/lib/hr/esign";
import {
  myPolicies,
  panelStateFor,
  policyOpenFailureCopy,
  policyReadState,
  type LoadFailure,
} from "@/lib/my-work/rules";
import { PanelShell } from "./panel-shell";
import { useSelfServiceRead } from "./use-self-service";
import {
  instantLabel,
  longDayLabel,
  myDocumentUrlEndpoint,
  myPoliciesUrl,
  readJson,
  signPolicyUrl,
} from "./shared";

// MY SIGNATURES — practice policies waiting for me, and the ones I have confirmed.
//
// THE LEGAL FRAMING IS NOT WRITTEN HERE. `ESIGN_COPY` lives beside the e-sign
// rules so the honest caveats and the code that makes them true cannot drift
// apart, and `whatThisIs` is never rendered without `whatThisIsNot`. What this
// produces is evidence that a named login, at a recorded time, was shown version
// N of a named document and affirmed it — not a witnessed signature and not a
// qualified electronic signature.
//
// WHICH VERSION IS OWED is `myPolicies`, which leans on the e-sign lane's own
// `currentPolicies` (retired versions out, future-dated ones not yet in force)
// and `signatureBindsToVersion`. A v1 signature is never quietly counted as
// covering v2; the policy comes back onto the outstanding list, carrying the old
// signature so the screen can say when it was given.
//
// READING IS HALF THE ACT, so the document is openable from here. Each
// outstanding policy carries a "Read the policy" control that mints a two-minute
// signed URL for its `storagePath` through the same endpoint My documents uses,
// on the `mine=1` branch (`isReadablePolicyPath` admits the practice's policy
// prefix for staff; it is a second predicate, never a widening of "is it mine").
// The confirm copy then STATES what was opened rather than instructing — see
// `policyReadState`. It does not hard-block: a mint that fails must not make a
// policy unsignable, and the person may have read it on paper.
//
// Typed name only for now. The drawn-signature canvas is the HR lane's
// `signature-pad`; when it is wired here the form swaps its input for it and
// posts `{ method: "drawn", value: <data-url> }` — the route and the stored
// shape already accept both.

interface SignedUrlResponse {
  url?: string;
}

interface PoliciesResponse {
  ok?: boolean;
  ready?: boolean;
  enabled?: boolean;
  policies?: StaffPolicy[];
  signatures?: StaffPolicySignatureSummary[];
  note?: string;
  error?: string;
}

export function MySignaturesTab({
  clientSlug,
  today,
  selfStaffId,
  identityLoading,
  identityFailure,
}: {
  clientSlug: string;
  /** London day key, resolved on the server: it decides which version is in force. */
  today: string;
  selfStaffId: string | null;
  identityLoading: boolean;
  identityFailure: LoadFailure | null;
}) {
  const url = selfStaffId ? myPoliciesUrl(clientSlug) : null;
  const { data, loading, failure, reload } = useSelfServiceRead<PoliciesResponse>(url);

  const [openId, setOpenId] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The policy whose signed URL is being minted right now, if any. */
  const [openingId, setOpeningId] = useState<string | null>(null);
  /** Policy ids opened during this visit. Not persisted: it is not a permission. */
  const [readIds, setReadIds] = useState<Set<string>>(new Set());
  const [readError, setReadError] = useState<string | null>(null);

  const view = useMemo(
    () => myPolicies(data?.policies ?? [], data?.signatures ?? [], selfStaffId, today),
    [data, selfStaffId, today],
  );
  const total = view.outstanding.length + view.signed.length;

  // Neither "not set up" nor "switched off" is an empty library, and neither may
  // render as one. Both become a failure carrying the e-sign lane's own words.
  const unavailable: LoadFailure | null = !data
    ? null
    : data.ready === false
      ? { status: 503, serverMessage: data.note ?? ESIGN_COPY.notReady }
      : data.enabled === false
        ? { status: 503, serverMessage: ESIGN_COPY.switchedOff }
        : null;

  const state = panelStateFor({
    subject: "your policy signatures",
    consequence: "there is nothing here to sign",
    loading: identityLoading || loading,
    linked: selfStaffId !== null,
    failure: identityFailure ?? failure ?? unavailable,
    count: total,
  });

  async function openPolicy(policy: StaffPolicy) {
    if (openingId) return;
    setOpeningId(policy.id);
    setReadError(null);
    // Opened BEFORE the await so the browser attributes the window to the click
    // rather than to a promise, which is what stops a popup blocker eating it.
    // Same shape as My documents.
    const tab = window.open("", "_blank", "noopener,noreferrer");
    try {
      const { data: signed, failure: signFailure } = await readJson<SignedUrlResponse>(
        myDocumentUrlEndpoint(clientSlug, policy.storagePath),
      );
      if (signFailure || !signed?.url) {
        tab?.close();
        setReadError(policyOpenFailureCopy(policy.title));
        return;
      }
      if (tab) tab.location.href = signed.url;
      else window.location.href = signed.url;
      setReadIds((ids) => new Set(ids).add(policy.id));
    } finally {
      setOpeningId(null);
    }
  }

  async function sign(policy: StaffPolicy) {
    setSubmitting(true);
    setSignError(null);
    setMessage(null);
    try {
      const res = await fetch(signPolicyUrl(policy.id), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NO staffId and NO timestamp: the signer comes from the session and the
        // time from the server clock. A signature you could post on somebody
        // else's behalf, at a time you chose, would be worth nothing as evidence.
        body: JSON.stringify({ clientSlug, method: "typed", value: typed.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || `Could not record your signature (${res.status}).`);
      setOpenId(null);
      setTyped("");
      setMessage(`Recorded against version ${policy.version} of ${policy.title}.`);
      await reload();
    } catch (err) {
      setSignError(err instanceof Error ? err.message : "Could not record your signature.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SectionCard
      title="My signatures"
      description="Practice policies you have been asked to read and confirm, and the ones you have already confirmed."
      actions={
        state.kind === "ready" && view.outstanding.length > 0 ? (
          <StatusPill tone="warning">{view.outstanding.length} waiting for you</StatusPill>
        ) : null
      }
    >
      <div className="space-y-4">
        {message ? (
          <p className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            {message}
          </p>
        ) : null}
        {/* NOTHING WAS SHOWN. Said plainly, rather than leaving somebody to
            confirm a document they never saw. */}
        {readError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {readError}
          </p>
        ) : null}

        <PanelShell
          state={state}
          loadingLabel="Loading your policies..."
          empty={
            <EmptyState
              icon={FileSignature}
              title="Nothing is waiting for your signature"
              description="When the practice issues a policy that staff are asked to confirm, it appears here with the version you are confirming."
            />
          }
        >
          <div className="space-y-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Waiting for you</p>
              {view.outstanding.length === 0 ? (
                <p className="mt-2 text-[13px] text-muted">Nothing is waiting for your signature.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {view.outstanding.map(({ policy, superseded }) => {
                    const read = policyReadState({
                      title: policy.title,
                      version: policy.version,
                      opening: openingId === policy.id,
                      opened: readIds.has(policy.id),
                    });
                    return (
                    <li key={policy.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-navy">{policy.title}</p>
                          <p className="mt-0.5 text-[12.5px] text-muted">
                            Version {policy.version} · In force from {longDayLabel(policy.effectiveFrom)}
                          </p>
                          {superseded ? (
                            <p className="mt-0.5 text-[12.5px] text-muted">
                              You confirmed version {superseded.policyVersion} on{" "}
                              {instantLabel(superseded.signedAt)}. {ESIGN_COPY.versionBinding}
                            </p>
                          ) : null}
                        </div>
                        {/* READ, then CONFIRM: two controls, in that order, so the
                            screen offers the half of the act it used to omit. */}
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={read.busy}
                          onClick={() => void openPolicy(policy)}
                        >
                          {read.busy ? (
                            <Loader2 size={15} className="animate-spin" />
                          ) : (
                            <ExternalLink size={15} />
                          )}
                          {read.openLabel}
                        </Button>
                        <Button
                          variant={openId === policy.id ? "secondary" : "primary"}
                          size="sm"
                          onClick={() => {
                            setSignError(null);
                            setTyped("");
                            setOpenId((id) => (id === policy.id ? null : policy.id));
                          }}
                        >
                          <FileSignature size={15} />
                          {openId === policy.id ? "Close" : "Confirm"}
                        </Button>
                      </div>

                      {openId === policy.id ? (
                        <form
                          className="mt-3 rounded-xl border border-line-strong bg-card-muted/40 p-4"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!submitting) void sign(policy);
                          }}
                        >
                          {/* The claim and its caveat, always together, always in
                              the e-sign lane's words rather than a paraphrase. */}
                          <p className="flex items-start gap-2 text-[12.5px] text-muted">
                            <ShieldCheck size={15} className="mt-0.5 shrink-0" />
                            <span>
                              {ESIGN_COPY.whatThisIs} {ESIGN_COPY.whatThisIsNot}
                            </span>
                          </p>

                          {/* The copy states what was OPENED once it has been,
                              and asks for it first when it has not. Deliberately
                              not a lock on the button: a mint that fails must
                              never make a policy unsignable. */}
                          <p className="mt-3 text-[12.5px] text-navy">{read.confirmPrompt}</p>

                          <label htmlFor={`sign-${policy.id}`} className="mt-3 block text-xs font-semibold text-navy">
                            Type your full name to confirm version {policy.version}{" "}
                            <span className="text-danger">*</span>
                          </label>
                          <input
                            id={`sign-${policy.id}`}
                            type="text"
                            required
                            maxLength={SIGNATURE_TYPED_CAP}
                            value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            placeholder="Your full name"
                            className="mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30 sm:max-w-sm"
                          />

                          {signError ? (
                            <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                              {signError}
                            </p>
                          ) : null}

                          <div className="mt-4 flex items-center gap-2">
                            <Button
                              type="submit"
                              variant="primary"
                              size="sm"
                              disabled={submitting || typed.trim() === ""}
                            >
                              {submitting ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                              Confirm version {policy.version}
                            </Button>
                            <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={() => setOpenId(null)}>
                              Not now
                            </Button>
                          </div>
                        </form>
                      ) : null}
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted">Confirmed</p>
              {view.signed.length === 0 ? (
                <p className="mt-2 text-[13px] text-muted">You have not confirmed any policies yet.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
                  {view.signed.map(({ policy, signature }) => (
                    <li key={policy.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-navy">{policy.title}</p>
                        <p className="mt-0.5 text-[12.5px] text-muted">
                          Version {signature?.policyVersion ?? policy.version} · Confirmed{" "}
                          {instantLabel(signature?.signedAt)}
                        </p>
                      </div>
                      <StatusPill tone="success">Confirmed</StatusPill>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="text-[12px] text-muted">{ESIGN_COPY.corroborationNote}</p>
          </div>
        </PanelShell>
      </div>
    </SectionCard>
  );
}
