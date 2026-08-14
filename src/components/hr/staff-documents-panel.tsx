"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  FolderLock,
  Loader2,
  ShieldAlert,
  Upload,
} from "lucide-react";
import { SectionCard, StatusPill, EmptyState, DataTable, type Column, type Tone } from "@/components/primitives";
import { Button } from "@/components/ui/button";
import {
  DOCUMENT_COPY,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  MAX_DOCUMENT_BYTES,
  SUGGESTED_REQUIRED_KINDS,
  documentsMissing,
  expiryState,
  formatBytes,
  isPastRetention,
  type DocumentExpiryState,
  type StaffDocument,
  type StaffDocumentKind,
} from "@/lib/hr/documents";

// ===========================================================================
// The Documents tab of Staff HR: one person's vault.
//
// A DUMB COMPONENT. Every judgement it renders — is this expired, is that person
// missing a DBS, is this past its retention date — comes from lib/hr/documents.ts,
// which is pure and unit tested. This file arranges, it does not decide.
//
// LOUD ON FAILURE, in three distinct states that must never be conflated:
//   read failed  -> an honest failure panel. NOT an empty vault.
//   not ready    -> the migration or the bucket is not in place on this environment,
//                   said in plain words so a fresh deployment is diagnosable.
//   genuinely empty -> the empty state, which is a true statement.
// The middle one is the deployment footgun the onboarding bucket left behind: a
// fresh environment failed at first upload with a message that gave no clue why.
// ===========================================================================

interface StaffOption {
  id: string;
  name: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "not-ready"; note: string }
  | { kind: "ok"; documents: StaffDocument[] };

const EXPIRY_TONE: Record<DocumentExpiryState, Tone> = {
  "no-expiry": "neutral",
  valid: "success",
  expiring: "warning",
  expired: "danger",
};

const EXPIRY_LABEL: Record<DocumentExpiryState, string> = {
  "no-expiry": "No expiry recorded",
  valid: "In date",
  expiring: "Expiring soon",
  expired: "Expired",
};

/** Today as a YYYY-MM-DD key. Computed once per render pass by the caller. */
function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Stable empty arrays, so a non-loaded state does not re-key a memo each render. */
const NO_DOCUMENTS: StaffDocument[] = [];
const NO_STAFF: StaffOption[] = [];

export function StaffDocumentsPanel({
  clientSlug,
  staff: suppliedStaff,
  initialStaffId,
  canManage = true,
}: {
  clientSlug: string;
  /**
   * The practice's staff. OPTIONAL: when it is not supplied the panel reads the
   * site-scoped list from /api/rota/staff itself, so the whole surface mounts as
   * `<StaffDocumentsPanel clientSlug={clientSlug} />` with no server plumbing on the
   * page that hosts it. Pass it when the host already has the list and wants the
   * picker constrained to a subset.
   */
  staff?: StaffOption[];
  initialStaffId?: string;
  /** False renders the vault read only (no upload form). */
  canManage?: boolean;
}) {
  const [fetchedStaff, setFetchedStaff] = useState<StaffOption[] | null>(null);
  const staff = suppliedStaff ?? fetchedStaff ?? NO_STAFF;
  const [staffId, setStaffId] = useState(initialStaffId ?? suppliedStaff?.[0]?.id ?? "");
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [opening, setOpening] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const today = todayKey();

  // `load` deliberately does NOT set the loading state itself. Setting state
  // synchronously inside an effect body causes a cascading render (and the lint rule
  // that catches it is right), so the loading state is set by whoever ASKED for a
  // reload — the person picker, the retry button — and the initial state is already
  // loading. Refreshing after an upload keeps the current list on screen until the
  // new one arrives, which is what you want anyway.
  const load = useCallback(async () => {
    if (!staffId) return;
    try {
      const res = await fetch(
        `/api/hr/document?client=${encodeURIComponent(clientSlug)}&staffId=${encodeURIComponent(staffId)}`,
      );
      const body = (await res.json()) as {
        ok?: boolean;
        ready?: boolean;
        documents?: StaffDocument[];
        note?: string;
      };
      if (!res.ok || !body.ok) {
        setState({ kind: "failed" });
        return;
      }
      if (body.ready === false) {
        setState({ kind: "not-ready", note: body.note ?? DOCUMENT_COPY.notReady });
        return;
      }
      setState({ kind: "ok", documents: body.documents ?? [] });
    } catch {
      setState({ kind: "failed" });
    }
  }, [clientSlug, staffId]);

  // Read the practice's staff when the host did not supply them. Site-scoped by the
  // route, so the picker never lists another site's team. A failure here leaves the
  // list empty, which the render below states as "no one on the team yet" rather than
  // spinning forever.
  useEffect(() => {
    if (suppliedStaff) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/rota/staff?client=${encodeURIComponent(clientSlug)}`);
        const body = (await res.json()) as { ok?: boolean; staff?: StaffOption[] };
        if (!alive) return;
        const list = res.ok && body.ok ? (body.staff ?? []) : [];
        setFetchedStaff(list);
        setStaffId((current) => current || list[0]?.id || "");
      } catch {
        if (alive) setFetchedStaff([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [clientSlug, suppliedStaff]);

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

  const documents = state.kind === "ok" ? state.documents : NO_DOCUMENTS;
  const missing = useMemo(
    () => documentsMissing(SUGGESTED_REQUIRED_KINDS, documents, today),
    [documents, today],
  );

  /** Open a document through a 120 second signed URL. Never a public link. */
  const open = async (doc: StaffDocument) => {
    setOpening(doc.id);
    setOpenError(null);
    try {
      const res = await fetch(
        `/api/hr/document/url?client=${encodeURIComponent(clientSlug)}&path=${encodeURIComponent(doc.storagePath)}`,
      );
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setOpenError(
          body.error === "not found"
            ? "That file is no longer in storage."
            : "That file could not be opened.",
        );
        return;
      }
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch {
      setOpenError("That file could not be opened.");
    } finally {
      setOpening(null);
    }
  };

  const columns: Column<StaffDocument>[] = [
    {
      key: "label",
      header: "Document",
      cell: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-navy">{d.label}</p>
          <p className="text-[11.5px] text-faint">
            {DOCUMENT_KIND_LABELS[d.kind] ?? d.kind} · {formatBytes(d.sizeBytes)}
          </p>
        </div>
      ),
    },
    {
      key: "expiry",
      header: "Expiry",
      cell: (d) => {
        const state = expiryState(d, today);
        return (
          <div className="flex flex-col gap-1">
            <StatusPill tone={EXPIRY_TONE[state]}>{EXPIRY_LABEL[state]}</StatusPill>
            {d.expiresOn ? <span className="text-[11.5px] text-faint">{d.expiresOn}</span> : null}
          </div>
        );
      },
    },
    {
      key: "retention",
      header: "Retention",
      cell: (d) =>
        d.retainUntil ? (
          <span
            className={
              isPastRetention(d, today) ? "text-[12px] font-medium text-status-amber" : "text-[12px] text-muted"
            }
          >
            {isPastRetention(d, today) ? `Review: kept past ${d.retainUntil}` : `Keep until ${d.retainUntil}`}
          </span>
        ) : (
          <span className="text-[12px] text-faint">Not set</span>
        ),
    },
    {
      key: "open",
      header: "",
      align: "right",
      cell: (d) => (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => void open(d)}
          disabled={opening === d.id}
        >
          {opening === d.id ? <Loader2 size={14} className="animate-spin" /> : null}
          Open
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <SectionCard
        title="Documents"
        description={DOCUMENT_COPY.vaultNote}
        actions={
          staff.length > 1 ? (
            <select
              value={staffId}
              onChange={(e) => {
                setState({ kind: "loading" });
                setStaffId(e.target.value);
              }}
              aria-label="Whose documents"
              className="h-9 rounded-lg border border-line-strong bg-card px-3 text-[13px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
            >
              {staff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          ) : null
        }
      >
        {!suppliedStaff && fetchedStaff === null ? (
          // The staff list is still being read. Distinguished from "no staff", which
          // is a claim, and from "loading the vault", which has not started yet.
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            Reading the team...
          </p>
        ) : staff.length === 0 ? (
          // No staff, so nothing is loading and nothing is missing. Saying so beats a
          // spinner that never resolves, which is what an unconditional loader would
          // do here (the loader never runs without a staff id).
          <EmptyState
            icon={FolderLock}
            title="No one on the team yet"
            description="Add the practice's staff on the rota first, then their documents can be filed against them."
          />
        ) : state.kind === "loading" ? (
          <p className="flex items-center gap-2 text-[13px] text-muted">
            <Loader2 size={15} className="animate-spin" />
            Reading the vault...
          </p>
        ) : state.kind === "failed" ? (
          // LOUD FAILURE. This is not an empty vault and it must never look like one.
          <div className="flex items-start gap-3 rounded-[10px] border border-tint-red-line bg-tint-red p-4">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-status-red" />
            <div>
              <p className="text-sm font-semibold text-navy">The vault could not be read</p>
              <p className="mt-1 text-[13px] text-muted">{DOCUMENT_COPY.readFailed}</p>
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
        ) : state.kind === "not-ready" ? (
          <div className="flex items-start gap-3 rounded-[10px] border border-tint-amber-line bg-tint-amber p-4">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-status-amber" />
            <div>
              <p className="text-sm font-semibold text-navy">Not set up on this environment</p>
              <p className="mt-1 text-[13px] text-muted">{state.note}</p>
            </div>
          </div>
        ) : documents.length === 0 ? (
          <EmptyState
            icon={FolderLock}
            title="No documents on file yet"
            description="Right to work, GDC registration, DBS, indemnity and the signed contract all live here, with their expiry dates."
          />
        ) : (
          <DataTable
            columns={columns}
            rows={documents}
            getRowKey={(d) => d.id}
            maxRows={25}
          />
        )}

        {openError ? (
          <p className="mt-3 text-[12px] font-medium text-status-red">{openError}</p>
        ) : null}

        {state.kind === "ok" && documents.length > 0 && missing.length > 0 ? (
          <div className="mt-4 flex items-start gap-3 rounded-[10px] border border-tint-amber-line bg-tint-amber p-4">
            <CalendarClock size={18} className="mt-0.5 shrink-0 text-status-amber" />
            <div>
              <p className="text-sm font-semibold text-navy">
                {missing.length === 1 ? "One document is missing or expired" : `${missing.length} documents are missing or expired`}
              </p>
              <p className="mt-1 text-[13px] text-muted">
                {missing.map((k) => DOCUMENT_KIND_LABELS[k]).join(", ")}. An expired document does
                not count as held.
              </p>
            </div>
          </div>
        ) : null}
      </SectionCard>

      {canManage ? <UploadForm clientSlug={clientSlug} staffId={staffId} onUploaded={load} /> : null}

      <p className="max-w-prose text-[12px] leading-relaxed text-faint">
        {DOCUMENT_COPY.noVirusScanning} {DOCUMENT_COPY.gdprNote} {DOCUMENT_COPY.retentionNote}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload.
// ---------------------------------------------------------------------------

function UploadForm({
  clientSlug,
  staffId,
  onUploaded,
}: {
  clientSlug: string;
  staffId: string;
  onUploaded: () => Promise<void> | void;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!staffId) {
      setError("Choose whose document this is first.");
      return;
    }
    const form = new FormData(e.currentTarget);
    form.set("clientSlug", clientSlug);
    form.set("staffId", staffId);

    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setError("Choose a file to upload.");
      return;
    }
    // A friendly local check so a 10MB+ file is refused before it is sent. The
    // server check is the authoritative one and stays exactly where it is.
    if (file.size > MAX_DOCUMENT_BYTES) {
      setError("That file is too large. The limit is 10 MB.");
      return;
    }

    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/hr/document", { method: "POST", body: form });
      const body = (await res.json()) as { ok?: boolean; error?: string; detail?: string };
      if (!res.ok || !body.ok) {
        setError([body.error ?? DOCUMENT_COPY.uploadFailed, body.detail].filter(Boolean).join(" "));
        return;
      }
      setDone(true);
      formRef.current?.reset();
      await onUploaded();
    } catch {
      setError(DOCUMENT_COPY.uploadFailed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard title="Add a document" description="PDF or a photograph, up to 10 MB.">
      <form ref={formRef} onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="doc-kind" className="block text-[12px] font-medium text-muted">
            What is it
          </label>
          <select
            id="doc-kind"
            name="kind"
            defaultValue="right-to-work"
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          >
            {DOCUMENT_KINDS.map((kind: StaffDocumentKind) => (
              <option key={kind} value={kind}>
                {DOCUMENT_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="doc-label" className="block text-[12px] font-medium text-muted">
            Name it
          </label>
          <input
            id="doc-label"
            name="label"
            type="text"
            required
            maxLength={120}
            placeholder="DBS certificate 2026"
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="doc-expires" className="block text-[12px] font-medium text-muted">
            Expires on (optional)
          </label>
          <input
            id="doc-expires"
            name="expiresOn"
            type="date"
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
        </div>

        <div className="space-y-1.5">
          <label htmlFor="doc-retain" className="block text-[12px] font-medium text-muted">
            Keep until (optional)
          </label>
          <input
            id="doc-retain"
            name="retainUntil"
            type="date"
            className="h-10 w-full rounded-lg border border-line-strong bg-card px-3 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
          />
          <p className="text-[11.5px] text-faint">A reminder for a person. Nothing is deleted automatically.</p>
        </div>

        <div className="space-y-1.5 sm:col-span-2">
          <label htmlFor="doc-file" className="block text-[12px] font-medium text-muted">
            The file
          </label>
          <input
            id="doc-file"
            name="file"
            type="file"
            required
            accept="application/pdf,image/jpeg,image/png,image/heic,image/webp"
            className="block w-full text-[13px] text-ink file:mr-3 file:rounded-lg file:border file:border-line-strong file:bg-card file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-navy"
          />
        </div>

        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
            {busy ? "Uploading..." : "Upload"}
          </Button>
          {done ? <span className="text-[12.5px] font-medium text-status-green">Saved.</span> : null}
          {error ? <span className="text-[12.5px] font-medium text-status-red">{error}</span> : null}
        </div>
      </form>
    </SectionCard>
  );
}
