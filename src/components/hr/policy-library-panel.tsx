"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  FileSignature,
  Loader2,
  PowerOff,
  ScrollText,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { SectionCard, StatusPill, EmptyState, DataTable, type Column } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/hr/documents";
import {
  ESIGN_COPY,
  currentPolicies,
  signingProgress,
  type StaffPolicy,
  type StaffPolicySignatureSummary,
} from "@/lib/hr/esign";
import { SignaturePad, type SignatureValue } from "./signature-pad";

// ===========================================================================
// The Policies tab of Staff HR: the practice's policy library, who has signed which
// VERSION of what, publishing a new version, and signing one yourself.
//
// A DUMB COMPONENT. `currentPolicies`, `signingProgress` and the whole
// version-binding rule live in lib/hr/esign.ts, pure and unit tested. This file
// arranges what they answer.
//
// THE LEGAL FRAMING IS NOT DECORATION. Every signing surface renders
// ESIGN_COPY.whatThisIs AND ESIGN_COPY.whatThisIsNot together, and the manager view
// renders ESIGN_COPY.managerNote. The tests in lib/hr/esign.test.ts pin the wording,
// because the schema supports exactly the claim that copy makes and no more: a named
// login, at a recorded time, was shown version N and affirmed it. Not a witnessed
// signature. Not a qualified electronic signature.
//
// LOUD ON FAILURE, and the three states stay distinct: read failed, not set up on
// this environment, and genuinely empty.
// ===========================================================================

interface StaffOption {
  id: string;
  name: string;
  role: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "not-ready"; note: string }
  | {
      kind: "ok";
      enabled: boolean;
      canPublish: boolean;
      policies: StaffPolicy[];
      signatures: StaffPolicySignatureSummary[];
      staff: StaffOption[];
    };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function PolicyLibraryPanel({ clientSlug }: { clientSlug: string }) {
  // WHETHER THIS PERSON MAY PUBLISH IS NOT DECIDED HERE. It arrives on the response,
  // computed by the same guard the POST enforces, so the screen and the server cannot
  // disagree and a component cannot promote anybody by getting a prop wrong.
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const today = todayKey();

  // No synchronous setState here: setting state inside an effect body causes a
  // cascading render. The initial state is already loading, and whoever ASKS for a
  // reload (the retry button) sets it from the handler. A refresh after signing or
  // publishing keeps the current list on screen until the new one arrives.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/hr/policy?client=${encodeURIComponent(clientSlug)}`);
      const body = (await res.json()) as {
        ok?: boolean;
        ready?: boolean;
        enabled?: boolean;
        canPublish?: boolean;
        policies?: StaffPolicy[];
        signatures?: StaffPolicySignatureSummary[];
        staff?: StaffOption[];
        note?: string;
      };
      if (!res.ok || !body.ok) {
        setState({ kind: "failed" });
        return;
      }
      if (body.ready === false) {
        setState({ kind: "not-ready", note: body.note ?? ESIGN_COPY.notReady });
        return;
      }
      setState({
        kind: "ok",
        enabled: body.enabled !== false,
        // Default CLOSED: a response that somehow omits the flag must not hand
        // somebody a publish form.
        canPublish: body.canPublish === true,
        policies: body.policies ?? [],
        signatures: body.signatures ?? [],
        staff: body.staff ?? [],
      });
    } catch {
      setState({ kind: "failed" });
    }
  }, [clientSlug]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  const inForce = useMemo(
    () => (state.kind === "ok" ? currentPolicies(state.policies, today) : []),
    [state, today],
  );

  if (state.kind === "loading") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted">
        <Loader2 size={15} className="animate-spin" />
        Reading the policy library...
      </p>
    );
  }

  if (state.kind === "failed") {
    // LOUD FAILURE. Not an empty library.
    return (
      <div className="flex items-start gap-3 rounded-[10px] border border-tint-red-line bg-tint-red p-4">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-status-red" />
        <div>
          <p className="text-sm font-semibold text-navy">The policy library could not be read</p>
          <p className="mt-1 text-[13px] text-muted">{ESIGN_COPY.readFailed}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => {
              setState({ kind: "loading" });
              void load();
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (state.kind === "not-ready") {
    return (
      <div className="flex items-start gap-3 rounded-[10px] border border-tint-amber-line bg-tint-amber p-4">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-status-amber" />
        <div>
          <p className="text-sm font-semibold text-navy">Not set up on this environment</p>
          <p className="mt-1 text-[13px] text-muted">{state.note}</p>
        </div>
      </div>
    );
  }

  const columns: Column<StaffPolicy>[] = [
    {
      key: "title",
      header: "Policy",
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-navy">{p.title}</p>
          <p className="text-[11.5px] text-faint">
            Version {p.version} · in force from {p.effectiveFrom} · {formatBytes(p.sizeBytes)}
          </p>
        </div>
      ),
    },
    {
      key: "signed",
      header: "Signed",
      cell: (p) => {
        const { signed, outstanding } = signingProgress(p, state.staff, state.signatures);
        const total = signed.length + outstanding.length;
        return (
          <div className="flex flex-col gap-1">
            <StatusPill tone={outstanding.length === 0 ? "success" : "warning"}>
              {signed.length} of {total}
            </StatusPill>
            {outstanding.length > 0 ? (
              <span className="text-[11.5px] text-faint">
                Waiting on {outstanding.slice(0, 3).map((s) => s.name).join(", ")}
                {outstanding.length > 3 ? ` and ${outstanding.length - 3} more` : ""}
              </span>
            ) : null}
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      {!state.enabled ? (
        <div className="flex items-start gap-3 rounded-[10px] border border-line-strong bg-card-muted p-4">
          <PowerOff size={18} className="mt-0.5 shrink-0 text-muted" />
          <div>
            <p className="text-sm font-semibold text-navy">Policy signing is switched off</p>
            <p className="mt-1 text-[13px] text-muted">{ESIGN_COPY.switchedOff}</p>
          </div>
        </div>
      ) : null}

      <SectionCard
        title="Policies in force"
        description="The version of each policy the practice is currently asking people to sign."
      >
        {inForce.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No policies published yet"
            description="Upload the practice's policy documents here and each person will be asked to read and confirm the version that is in force."
          />
        ) : (
          <DataTable columns={columns} rows={inForce} getRowKey={(p) => p.id} />
        )}
        <p className="mt-4 max-w-prose text-[12px] leading-relaxed text-faint">
          {ESIGN_COPY.managerNote} {ESIGN_COPY.corroborationNote} {ESIGN_COPY.retiredNote}
        </p>
      </SectionCard>

      {state.enabled && inForce.length > 0 ? (
        <SignOffPanel clientSlug={clientSlug} policies={inForce} onSigned={load} />
      ) : null}

      {state.canPublish ? (
        <PublishForm
          clientSlug={clientSlug}
          existing={state.policies}
          enabled={state.enabled}
          onPublished={load}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign it yourself.
// ---------------------------------------------------------------------------

function SignOffPanel({
  clientSlug,
  policies,
  onSigned,
}: {
  clientSlug: string;
  policies: StaffPolicy[];
  onSigned: () => Promise<void> | void;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const [signature, setSignature] = useState<SignatureValue | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedAt, setSignedAt] = useState<string | null>(null);

  const policy = policies.find((p) => p.id === policyId) ?? policies[0];

  const submit = async () => {
    if (!policy || !signature) return;
    setBusy(true);
    setError(null);
    setSignedAt(null);
    try {
      const res = await fetch(`/api/hr/policy/${encodeURIComponent(policy.id)}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          method: signature.method,
          value: signature.value,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; error?: string; signedAt?: string };
      if (!res.ok || !body.ok) {
        // Every one of the server's honest refusals reaches the person verbatim: the
        // login is not linked to a staff record, signing is switched off, sign in is
        // not configured on this environment. None of them is "something went wrong".
        setError(body.error ?? "That signature could not be recorded.");
        return;
      }
      setSignedAt(body.signedAt ?? null);
      setSignature(null);
      await onSigned();
    } catch {
      setError("That signature could not be recorded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Sign a policy"
      description="Read the document, then confirm it. Your signature is recorded against this exact version."
    >
      <div className="space-y-4">
        <div className="max-w-[520px] space-y-1.5">
          <label htmlFor="policy-choice" className="block text-[12px] font-medium text-muted">
            Which policy
          </label>
          <select
            id="policy-choice"
            value={policy?.id ?? ""}
            onChange={(e) => {
              setPolicyId(e.target.value);
              setSignature(null);
              setSignedAt(null);
              setError(null);
            }}
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} (version {p.version})
              </option>
            ))}
          </select>
          <p className="text-[11.5px] text-faint">{ESIGN_COPY.versionBinding}</p>
        </div>

        <SignaturePad onChange={setSignature} disabled={busy} />

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void submit()} disabled={busy || !signature}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <FileSignature size={15} />}
            {busy ? "Recording..." : "Confirm and sign"}
          </Button>
          {signedAt ? (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-status-green">
              <BadgeCheck size={15} />
              Recorded at {new Date(signedAt).toLocaleString("en-GB")}
            </span>
          ) : null}
          {error ? <span className="text-[12.5px] font-medium text-status-red">{error}</span> : null}
        </div>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Publish a version. Owner and agency only.
// ---------------------------------------------------------------------------

function PublishForm({
  clientSlug,
  existing,
  enabled,
  onPublished,
}: {
  clientSlug: string;
  existing: StaffPolicy[];
  enabled: boolean;
  onPublished: () => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Existing slugs, so publishing a NEW VERSION of an existing policy is a choice
  // rather than a typing exercise (a typo would silently start a second policy).
  const slugs = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of existing) if (!seen.has(p.slug)) seen.set(p.slug, p.title);
    return [...seen.entries()];
  }, [existing]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    form.set("clientSlug", clientSlug);
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch("/api/hr/policy", { method: "POST", body: form });
      const body = (await res.json()) as {
        ok?: boolean;
        error?: string;
        detail?: string;
        policy?: StaffPolicy;
      };
      if (!res.ok || !body.ok) {
        setError([body.error ?? "That policy could not be published.", body.detail].filter(Boolean).join(" "));
        return;
      }
      setDone(`Published version ${body.policy?.version ?? ""}.`);
      formRef.current?.reset();
      await onPublished();
    } catch {
      setError("That policy could not be published.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Publish a policy"
      description="A PDF, up to 10 MB. Publishing a new version asks everyone to read and sign it again; earlier versions are retired, never deleted."
    >
      {!enabled ? (
        <p className="text-[13px] text-muted">{ESIGN_COPY.switchedOff}</p>
      ) : (
        <form ref={formRef} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="policy-title" className="block text-[12px] font-medium text-muted">
              Title
            </label>
            <input
              id="policy-title"
              name="title"
              type="text"
              required
              maxLength={160}
              placeholder="Infection control policy"
              className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="policy-slug" className="block text-[12px] font-medium text-muted">
              New version of
            </label>
            <select
              id="policy-slug"
              name="slug"
              defaultValue=""
              className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              <option value="">A brand new policy</option>
              {slugs.map(([slug, title]) => (
                <option key={slug} value={slug}>
                  {title}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="policy-effective" className="block text-[12px] font-medium text-muted">
              In force from
            </label>
            <input
              id="policy-effective"
              name="effectiveFrom"
              type="date"
              required
              className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            />
            <p className="text-[11.5px] text-faint">
              A future date is not offered for signature until it arrives.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="policy-file" className="block text-[12px] font-medium text-muted">
              The document (PDF)
            </label>
            <input
              id="policy-file"
              name="file"
              type="file"
              required
              accept="application/pdf"
              className="block w-full text-[13px] text-ink file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-card file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-navy"
            />
          </div>

          <div className="flex items-center gap-3 sm:col-span-2">
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
              {busy ? "Publishing..." : "Publish"}
            </Button>
            {done ? <span className="text-[12.5px] font-medium text-status-green">{done}</span> : null}
            {error ? <span className="text-[12.5px] font-medium text-status-red">{error}</span> : null}
          </div>
        </form>
      )}
    </SectionCard>
  );
}
