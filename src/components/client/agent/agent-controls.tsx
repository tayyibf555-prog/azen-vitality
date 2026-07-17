"use client";

import { useState } from "react";
import { SectionCard, DataTable, StatusPill, EmptyState, type Column, type Tone } from "@/components/primitives";
import { cn, relativeTime } from "@/lib/utils";
import { Loader2, MessageSquare } from "lucide-react";
import type { ConversationStatus } from "@/lib/agent/types";
import type { DashboardConversation } from "@/lib/agent/repository";
import { ConversationDrawer } from "./conversation-drawer";

const STATUS_TONE: Record<ConversationStatus, Tone> = {
  active: "info",
  booked: "success",
  needs_human: "warning",
  closed: "neutral",
};
const STATUS_LABEL: Record<ConversationStatus, string> = {
  active: "In conversation",
  booked: "Booked",
  needs_human: "Needs a human",
  closed: "Closed",
};

export function AgentControls({
  siteIds,
  initialEnabled,
  conversations,
  nowIso,
}: {
  siteIds: string[];
  initialEnabled: boolean;
  conversations: DashboardConversation[];
  nowIso: string;
}) {
  const now = new Date(nowIso);
  const [enabled, setEnabled] = useState(initialEnabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = conversations.find((c) => c.id === selectedId) ?? null;

  async function toggle() {
    const next = !enabled;
    setBusy(true);
    setError(null);
    try {
      await Promise.all(
        siteIds.map((siteId) =>
          fetch("/api/agent/settings", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ siteId, enabled: next }),
          }).then((r) => {
            if (!r.ok) throw new Error("failed");
          }),
        ),
      );
      setEnabled(next);
    } catch {
      setError("Could not update the setting. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<DashboardConversation>[] = [
    {
      key: "patient",
      header: "Patient",
      cell: (c) => <span className="font-semibold text-navy">{c.patientName}</span>,
    },
    {
      key: "treatment",
      header: "Enquiry",
      cell: (c) => <span className="text-ink">{c.treatment ?? "General"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (c) => <StatusPill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusPill>,
    },
    {
      key: "last",
      header: "Last message",
      cell: (c) => (
        <span className="text-muted">
          <span className="font-medium text-ink">{c.lastMessageRole === "agent" ? "Agent: " : "Patient: "}</span>
          <span className="line-clamp-1">{c.lastMessage}</span>
        </span>
      ),
      className: "max-w-[320px]",
    },
    {
      key: "count",
      header: "Msgs",
      cell: (c) => <span className="tabular-nums text-muted">{c.messageCount}</span>,
      align: "right",
    },
    {
      key: "updated",
      header: "Updated",
      cell: (c) => <span className="text-muted">{relativeTime(c.updatedAt, now)}</span>,
      align: "right",
    },
  ];

  return (
    <div className="space-y-6">
      {/* Run/pause control as a quiet hairline section, the toggle right-aligned. */}
      <SectionCard
        title={enabled ? "Agent is running" : "Agent is paused"}
        actions={
          <button
            type="button"
            onClick={toggle}
            disabled={busy}
            aria-pressed={enabled}
            className={cn(
              "pressable inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-50",
              enabled
                ? "border-success/30 bg-success/10 text-success hover:bg-success/15"
                : "border-line-strong bg-card text-muted hover:bg-card-muted",
            )}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : (
              <span className={cn("h-2 w-2 rounded-full", enabled ? "bg-success" : "bg-muted")} />
            )}
            {enabled ? "Running" : "Paused"}
          </button>
        }
      >
        <p className="text-[13px] text-muted">
          {enabled
            ? "Patient replies are answered and booked automatically. Tricky cases go to your team."
            : "Replies are not answered automatically. Every reply is routed to your team."}
        </p>
        {error ? (
          <p className="mt-3 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
        ) : null}
      </SectionCard>

      {/* Conversations */}
      <SectionCard
        title="Conversations"
        description="Every patient thread the agent is handling. Open one to read the full exchange."
        bodyClassName="p-0"
      >
        {conversations.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            title="No conversations yet"
            description="When a patient replies to outreach, the agent picks it up and the conversation appears here."
            className="m-4"
          />
        ) : (
          <DataTable
            columns={columns}
            rows={conversations}
            getRowKey={(c) => c.id}
            onRowClick={(c) => setSelectedId(c.id)}
            className="px-2 py-1"
          />
        )}
      </SectionCard>

      {selected ? (
        <ConversationDrawer conversation={selected} nowIso={nowIso} onClose={() => setSelectedId(null)} />
      ) : null}
    </div>
  );
}
