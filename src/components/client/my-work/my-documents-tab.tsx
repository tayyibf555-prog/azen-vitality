"use client";

import { useMemo, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatusPill } from "@/components/primitives";
import { DOCUMENT_COPY, DOCUMENT_KIND_LABELS, type StaffDocument } from "@/lib/hr/documents";
import { myDocuments, panelStateFor, type LoadFailure } from "@/lib/my-work/rules";
import { PanelShell } from "./panel-shell";
import { useSelfServiceRead } from "./use-self-service";
import { longDayLabel, myDocumentUrlEndpoint, myDocumentsUrl, readJson, sizeLabel } from "./shared";

// MY DOCUMENTS — the caller's own file, read-only.
//
// The bytes live in a PRIVATE storage bucket. This tab never holds a URL: it
// asks the vault lane's route to mint a short-lived signed one at the moment the
// person presses Open, and hands back the exact `storagePath` the server gave
// it (which that route re-checks against the practice prefix regardless, because
// a path from a browser is a request, not a fact). No public URL is produced
// anywhere in this codebase and none is produced here.
//
// It is deliberately READ-ONLY. Uploading identity documents, DBS certificates
// and right-to-work checks is the practice's act, done on the HR file by a
// manager, so there is no upload control on a self-service screen.
//
// `ready: false` from the vault route means the storage bucket is not connected
// yet. That is NOT an empty vault and must never render as one — it is turned
// into a failure carrying the vault lane's own words.

interface DocumentsResponse {
  ok?: boolean;
  ready?: boolean;
  documents?: StaffDocument[];
  note?: string;
  error?: string;
}

interface SignedUrlResponse {
  url?: string;
  expiresIn?: number;
  error?: string;
}

const EXPIRY_TONE = {
  expired: "danger",
  expiring: "warning",
  valid: "success",
} as const;

const EXPIRY_LABEL = {
  expired: "Expired",
  expiring: "Expiring soon",
  valid: "In date",
} as const;

export function MyDocumentsTab({
  clientSlug,
  today,
  selfStaffId,
  identityLoading,
  identityFailure,
}: {
  clientSlug: string;
  /** London day key, resolved on the server, so the expiry states cannot drift. */
  today: string;
  selfStaffId: string | null;
  identityLoading: boolean;
  identityFailure: LoadFailure | null;
}) {
  const url = selfStaffId ? myDocumentsUrl(clientSlug) : null;
  const { data, loading, failure } = useSelfServiceRead<DocumentsResponse>(url);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const rows = useMemo(
    () => myDocuments(data?.documents ?? [], selfStaffId, today),
    [data, selfStaffId, today],
  );

  // "Not set up yet" is a failure to answer, not an answer.
  const notReady: LoadFailure | null =
    data && data.ready === false ? { status: 503, serverMessage: data.note ?? DOCUMENT_COPY.notReady } : null;

  const state = panelStateFor({
    subject: "your documents",
    consequence: "there are no documents to show",
    loading: identityLoading || loading,
    linked: selfStaffId !== null,
    failure: identityFailure ?? failure ?? notReady,
    count: rows.length,
  });

  async function open(doc: StaffDocument) {
    if (busyId) return;
    setBusyId(doc.id);
    setOpenError(null);
    // The window is opened BEFORE the await so the browser attributes it to the
    // click rather than to a promise, which is what stops a popup blocker
    // swallowing it.
    const tab = window.open("", "_blank", "noopener,noreferrer");
    try {
      const { data: signed, failure: signFailure } = await readJson<SignedUrlResponse>(
        myDocumentUrlEndpoint(clientSlug, doc.storagePath),
      );
      if (signFailure || !signed?.url) {
        tab?.close();
        setOpenError(
          `We could not open ${doc.label}. The link could not be created, so nothing was shown — try again in a moment.`,
        );
        return;
      }
      if (tab) tab.location.href = signed.url;
      else window.location.href = signed.url;
    } finally {
      setBusyId(null);
    }
  }

  return (
    <SectionCard
      title="My documents"
      description="Your own file: contracts, registrations, checks and certificates the practice holds for you. Links last two minutes and are yours alone."
    >
      <div className="space-y-4">
        {openError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {openError}
          </p>
        ) : null}

        <PanelShell
          state={state}
          loadingLabel="Loading your documents..."
          empty={
            <EmptyState
              icon={FileText}
              title="No documents on your file yet"
              description="Contracts, right-to-work checks, registrations and training certificates the practice holds for you appear here as they are added."
            />
          }
        >
          <ul className="divide-y divide-line rounded-xl border border-line">
            {rows.map(({ doc, expiry }) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-navy">{doc.label}</p>
                  <p className="mt-0.5 text-[12.5px] text-muted">
                    {DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind}
                    {doc.sizeBytes ? ` · ${sizeLabel(doc.sizeBytes)}` : ""}
                    {doc.expiresOn ? ` · Expires ${longDayLabel(doc.expiresOn)}` : " · No expiry recorded"}
                  </p>
                </div>
                {expiry === "no-expiry" ? null : (
                  <StatusPill tone={EXPIRY_TONE[expiry]}>{EXPIRY_LABEL[expiry]}</StatusPill>
                )}
                <Button variant="secondary" size="sm" disabled={busyId !== null} onClick={() => void open(doc)}>
                  {busyId === doc.id ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </PanelShell>
      </div>
    </SectionCard>
  );
}
