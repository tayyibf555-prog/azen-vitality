"use client";

import { useEffect, useState } from "react";
import { PencilLine, Lightbulb, HelpCircle, Check, Loader2, MessageSquareOff } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  PageHeader,
  SectionCard,
  DataTable,
  StatusPill,
  EmptyState,
  type Column,
  type Tone,
} from "@/components/primitives";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/utils";
import type { FeedbackItem, FeedbackSeverity } from "@/lib/feedback/types";

// Agency console: every in-app "Request a change" submission across every
// client, newest first, with a mark-as-done action. Fully client-rendered
// (fetches GET /api/feedback on mount) since the agency shell already gates
// every /agency/* page to agency_admin via guardPage (src/app/agency/layout.tsx);
// the API route re-checks agency_admin independently on GET/PATCH regardless.

interface Row extends FeedbackItem {
  clientName: string;
}

// Request types, mapped onto the stored FeedbackSeverity values (unchanged
// plumbing): a change to something (bug), a new idea (idea), or a question.
const SEVERITY_META: Record<FeedbackSeverity, { label: string; icon: LucideIcon; tone: Tone }> = {
  bug: { label: "Change", icon: PencilLine, tone: "warning" },
  idea: { label: "Idea", icon: Lightbulb, tone: "info" },
  question: { label: "Question", icon: HelpCircle, tone: "neutral" },
};

export function FeedbackList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/feedback");
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; items?: Row[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not load feedback.");
      setRows(data.items ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load feedback.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function markDone(id: string) {
    setBusyId(id);
    try {
      const res = await fetch("/api/feedback", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status: "done" }),
      });
      if (!res.ok) throw new Error();
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, status: "done" } : r)));
    } catch {
      // Leave the row as-is; the button stays available to retry.
    } finally {
      setBusyId(null);
    }
  }

  const open = rows.filter((r) => r.status !== "done");

  const columns: Column<Row>[] = [
    {
      key: "page",
      header: "Page",
      cell: (r) => <span className="font-mono text-xs text-ink">{r.pagePath}</span>,
    },
    {
      key: "note",
      header: "Note",
      cell: (r) => <span className="line-clamp-2 max-w-sm text-sm text-ink">{r.note}</span>,
    },
    {
      key: "severity",
      header: "Type",
      cell: (r) => {
        const meta = SEVERITY_META[r.severity] ?? SEVERITY_META.bug;
        const Icon = meta.icon;
        return (
          <StatusPill tone={meta.tone}>
            <Icon size={12} />
            {meta.label}
          </StatusPill>
        );
      },
    },
    {
      key: "who",
      header: "From",
      cell: (r) => (
        <div className="text-xs">
          <p className="font-medium text-navy">{r.clientName}</p>
          <p className="text-muted">{r.userEmail ?? "Unknown user"}{r.role ? ` · ${r.role}` : ""}</p>
        </div>
      ),
    },
    {
      key: "when",
      header: "When",
      cell: (r) => <span className="text-xs text-muted">{relativeTime(r.createdAt, new Date())}</span>,
    },
    {
      key: "status",
      header: "Status",
      align: "right",
      cell: (r) =>
        r.status === "done" ? (
          <StatusPill tone="success">
            <Check size={12} /> Done
          </StatusPill>
        ) : (
          <Button size="sm" variant="secondary" disabled={busyId === r.id} onClick={() => markDone(r.id)}>
            {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Mark done
          </Button>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Feedback"
        description="Every in-app change request across every client, newest first."
      />

      <SectionCard
        title="Requests"
        description={loading ? "Loading..." : `${open.length} open, ${rows.length} total`}
      >
        {loadError ? (
          <EmptyState icon={MessageSquareOff} title="Could not load feedback" description={loadError} />
        ) : !loading && rows.length === 0 ? (
          <EmptyState
            icon={MessageSquareOff}
            title="No requests yet"
            description="Requests from the 'Request a change' widget will appear here."
          />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(r) => r.id}
            maxRows={100}
          />
        )}
      </SectionCard>
    </>
  );
}
