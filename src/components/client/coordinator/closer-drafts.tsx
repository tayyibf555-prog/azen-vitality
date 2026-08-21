"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, Mail, MessageSquare, Sparkles, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatCard, StatusPill } from "@/components/primitives";
import { cn, gbp, relativeTime } from "@/lib/utils";
import {
  CLOSER_DISCARD_EFFECT,
  CLOSER_DISCARD_LABEL,
  CLOSER_DISCARD_REASONS,
  type CloserDiscardReason,
} from "@/lib/closer/discard";
import type { CloserDraftView } from "@/lib/closer/types";
import type { TouchChannel } from "@/lib/coordinator/types";

// ===========================================================================
// THE CLOSER'S APPROVAL SURFACE.
//
// Every message the treatment-plan closer writes stops here. Nothing it drafts can
// reach a patient until somebody on this screen releases it, and that is a
// property of the schema rather than of this component: the sweep writes a
// closer_touch and never a closer_outbox row, and the shared messaging drain reads
// closer_outbox alone.
//
// SO THIS SCREEN'S ONE JOB IS TO MAKE THE MESSAGE JUDGEABLE. The full text, never
// truncated, in an editable box. Who it is going to, what it is about, which
// follow-up of three it is, and the one figure it may mention. A person cannot
// approve what they cannot read, and a summary line with a "view" link is how an
// approval step becomes a rubber stamp.
//
// THE FILE IS SPLIT IN TWO ON PURPOSE. `CloserDraftForm` is presentational: every
// piece of state it renders arrives as a prop. `CloserDraftCard` holds the state
// and the fetches. That is what makes each state of the card — edited, choosing a
// reason, refused, working — something a test can render and read, rather than
// something reachable only by clicking.
// ===========================================================================

const CHANNEL_LABEL: Record<TouchChannel, string> = {
  sms: "SMS",
  email: "Email",
  whatsapp: "WhatsApp",
};

const CHANNEL_ICON: Record<TouchChannel, typeof MessageSquare> = {
  sms: MessageSquare,
  email: Mail,
  whatsapp: MessageSquare,
};

/** The cadence is three messages, then the closer stops for good. Say so. */
export const CADENCE_LENGTH = 3;

/** The primary button's words. Edit-then-approve is the SAME click as approve, so
 *  the label is the only thing that tells the person which one they are about to
 *  do — which makes it worth having as a rule rather than as an inline ternary. */
export function approveLabel(edited: boolean): string {
  return edited ? "Approve edited message" : "Approve";
}

export type CloserCardBusy = null | "approving" | "discarding";

// ---------------------------------------------------------------------------
// Presentational.
// ---------------------------------------------------------------------------

export function CloserDraftForm({
  draft,
  nowIso,
  body,
  busy,
  error,
  choosingReason,
  reason,
  onBodyChange,
  onRevert,
  onApprove,
  onOpenDiscard,
  onCancelDiscard,
  onPickReason,
  onConfirmDiscard,
}: {
  draft: CloserDraftView;
  nowIso: string;
  body: string;
  busy: CloserCardBusy;
  error: string | null;
  choosingReason: boolean;
  reason: CloserDiscardReason | null;
  onBodyChange: (value: string) => void;
  onRevert: () => void;
  onApprove: () => void;
  onOpenDiscard: () => void;
  onCancelDiscard: () => void;
  onPickReason: (reason: CloserDiscardReason) => void;
  onConfirmDiscard: () => void;
}) {
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const edited = body.trim() !== draft.body.trim();
  const working = busy !== null;
  const Icon = CHANNEL_ICON[draft.channel];

  return (
    <article className="rounded-lg border border-line-strong bg-card">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-navy">{draft.patientName}</p>
          <p className="mt-0.5 truncate text-sm text-muted">{draft.treatment}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill tone="neutral">
            Follow-up {draft.step} of {CADENCE_LENGTH}
          </StatusPill>
          <StatusPill tone="info">{CHANNEL_LABEL[draft.channel]}</StatusPill>
          {/* The figure, labelled for what it IS. It is the cost of the treatment
              still to be done, and the drafter refuses any wording that calls it a
              debt, so the screen must not quietly call it one either. */}
          <StatusPill tone="neutral">{gbp(draft.amountOutstanding)} of treatment left</StatusPill>
        </div>
      </header>

      <div className="space-y-3 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            <Icon size={13} />
            Message
          </p>
          <p className="text-xs text-muted">Drafted {relativeTime(draft.createdAt, now)}</p>
        </div>

        {/* THE WHOLE MESSAGE, EDITABLE IN PLACE. Not a preview, not a clamp: this is
            the text that will be sent, and editing it is the same click as approving
            it. An edit is re-scanned against the patient-messaging rules server-side
            before anything can be queued. */}
        <textarea
          aria-label={`Message to ${draft.patientName}`}
          value={body}
          onChange={(e) => onBodyChange(e.target.value)}
          disabled={working}
          rows={Math.min(12, Math.max(4, body.split("\n").length + 2))}
          className="w-full resize-y rounded-lg border border-line-strong bg-card px-3 py-2 text-sm leading-relaxed text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 disabled:opacity-60"
        />

        {edited ? (
          <p className="text-xs font-medium text-muted">
            Edited. Your wording is checked against the patient-messaging rules before it is queued.
          </p>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-warning/25 bg-warning/10 px-3 py-2 text-sm text-[#9a6700]"
          >
            {error}
          </p>
        ) : null}

        {!choosingReason ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={onApprove} disabled={working} variant="primary">
              {busy === "approving" ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Check size={15} />
              )}
              {approveLabel(edited)}
            </Button>
            {edited ? (
              <Button onClick={onRevert} disabled={working} variant="ghost">
                <Undo2 size={15} />
                Undo my edit
              </Button>
            ) : null}
            <Button onClick={onOpenDiscard} disabled={working} variant="secondary" className="ml-auto">
              <Trash2 size={15} />
              Discard
            </Button>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg border border-line bg-card-muted/50 p-3">
            {/* THE REASON IS REQUIRED AND NOTHING IS PRESELECTED. The reason is an
                input to the closer's own stop rules, not a note: three of the five
                stop the follow-up for good. A default choice would let a stray
                click retire a patient's follow-up silently. */}
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Why is this not going out?
            </p>
            <div className="space-y-1">
              {CLOSER_DISCARD_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => onPickReason(r)}
                  disabled={working}
                  aria-pressed={reason === r}
                  className={cn(
                    "flex w-full flex-col rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50",
                    reason === r
                      ? "border-blue-dark/30 bg-[#f0f4f9]"
                      : "border-line-strong bg-card hover:bg-card-muted",
                  )}
                >
                  <span className="text-sm font-semibold text-navy">{CLOSER_DISCARD_LABEL[r]}</span>
                  <span className="text-xs text-muted">{CLOSER_DISCARD_EFFECT[r]}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <Button onClick={onConfirmDiscard} disabled={working || !reason} variant="primary">
                {busy === "discarding" ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Trash2 size={15} />
                )}
                Confirm discard
              </Button>
              <Button onClick={onCancelDiscard} disabled={working} variant="ghost">
                Keep it
              </Button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Stateful.
// ---------------------------------------------------------------------------

interface ActionResponse {
  ok?: boolean;
  error?: string;
  refused?: boolean;
  category?: string;
  alreadyActioned?: boolean;
}

export type CloserPost = (
  action: "approve" | "discard",
  payload: Record<string, unknown>,
) => Promise<ActionResponse>;

const postToApi: CloserPost = async (action, payload) => {
  const res = await fetch(`/api/closer/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json().catch(() => ({}))) as ActionResponse;
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

/**
 * The card's state before anybody has touched it.
 *
 * A named constant rather than four inline `useState` defaults, because two of
 * them are safety properties and a safety property that lives only inside a hook
 * call cannot be asserted without a browser: the reason chooser starts CLOSED, and
 * NO reason is preselected. Three of the five discard reasons stop a patient's
 * follow-up for good, so a preselected one would turn a stray double-click into a
 * silent, permanent decision.
 */
export interface CloserCardState {
  busy: CloserCardBusy;
  error: string | null;
  choosingReason: boolean;
  reason: CloserDiscardReason | null;
}

export const INITIAL_CARD_STATE: CloserCardState = {
  busy: null,
  error: null,
  choosingReason: false,
  reason: null,
};

/**
 * Submit an approval.
 *
 * EXPORTED, AND ITS DEPENDENCIES ARE INJECTED, for one reason that is worth
 * stating: `setBody` IS NOT AMONG THEM. When the server refuses an edit, the
 * person's wording must survive so they can change the one thing that was wrong
 * instead of starting again — and the strongest form of that promise is a function
 * that has no way to clear the box, rather than a catch block that remembers not
 * to. The same shape makes the "an unchanged approval posts no body" rule testable
 * without a DOM.
 */
export async function runApprove(deps: {
  touchId: string;
  body: string;
  edited: boolean;
  post: CloserPost;
  setBusy: (b: CloserCardBusy) => void;
  setError: (e: string | null) => void;
  onDone: (touchId: string) => void;
}): Promise<void> {
  deps.setError(null);
  deps.setBusy("approving");
  try {
    // The edited text is sent ONLY when it differs. An unchanged approval posts no
    // body at all, so the row the drain sends is byte-for-byte the text that was
    // scanned when it was drafted.
    await deps.post("approve", {
      touchId: deps.touchId,
      ...(deps.edited ? { body: deps.body.trim() } : {}),
    });
    deps.onDone(deps.touchId);
  } catch (err) {
    // The server's refusal is already a plain-English sentence aimed at whoever
    // typed the words; it is shown as-is.
    deps.setError(err instanceof Error ? err.message : "Could not approve this message.");
    deps.setBusy(null);
  }
}

/** Submit a discard. Refuses to fire without a reason, so the API is never asked
 *  to guess what a human meant. */
export async function runDiscard(deps: {
  touchId: string;
  reason: CloserDiscardReason | null;
  post: CloserPost;
  setBusy: (b: CloserCardBusy) => void;
  setError: (e: string | null) => void;
  onDone: (touchId: string) => void;
}): Promise<void> {
  if (!deps.reason) return;
  deps.setError(null);
  deps.setBusy("discarding");
  try {
    await deps.post("discard", { touchId: deps.touchId, reason: deps.reason });
    deps.onDone(deps.touchId);
  } catch (err) {
    deps.setError(err instanceof Error ? err.message : "Could not discard this message.");
    deps.setBusy(null);
  }
}

export function CloserDraftCard({
  draft,
  nowIso,
  onDone,
  post = postToApi,
  initialState = INITIAL_CARD_STATE,
}: {
  draft: CloserDraftView;
  nowIso: string;
  /** Called once this draft has left the queue, so the list can drop it. */
  onDone: (touchId: string) => void;
  /** Injected in tests. Production always uses the real endpoint. */
  post?: CloserPost;
  /**
   * The seam that makes each of the card's states renderable.
   *
   * A static render cannot click, so without this the only reachable state is the
   * one the card opens in — and the two properties worth proving (the reason
   * chooser starts closed, and once opened NOTHING is preselected) live on
   * opposite sides of a click. Production never passes it.
   */
  initialState?: CloserCardState;
}) {
  const [body, setBody] = useState(draft.body);
  const [busy, setBusy] = useState<CloserCardBusy>(initialState.busy);
  const [error, setError] = useState<string | null>(initialState.error);
  const [choosingReason, setChoosingReason] = useState(initialState.choosingReason);
  const [reason, setReason] = useState<CloserDiscardReason | null>(initialState.reason);

  const edited = body.trim() !== draft.body.trim();
  const common = { post, setBusy, setError, onDone, touchId: draft.touchId };

  const approve = () => runApprove({ ...common, body, edited });
  const discard = () => runDiscard({ ...common, reason });

  return (
    <CloserDraftForm
      draft={draft}
      nowIso={nowIso}
      body={body}
      busy={busy}
      error={error}
      choosingReason={choosingReason}
      reason={reason}
      onBodyChange={setBody}
      onRevert={() => setBody(draft.body)}
      onApprove={approve}
      onOpenDiscard={() => setChoosingReason(true)}
      onCancelDiscard={() => {
        setChoosingReason(false);
        setReason(null);
      }}
      onPickReason={setReason}
      onConfirmDiscard={discard}
    />
  );
}

// ---------------------------------------------------------------------------
// The panel.
// ---------------------------------------------------------------------------

export function CloserDraftsPanel({
  drafts,
  counts,
  nowIso,
}: {
  drafts: CloserDraftView[];
  counts: { awaiting: number; sent: number; replies: number };
  nowIso: string;
}) {
  const [queue, setQueue] = useState(drafts);
  const done = drafts.length - queue.length;

  return (
    <div className="space-y-5">
      {/* The status strip. Three numbers, and one sentence about the third: replies
          are handled by the shared inbound path (the reply stops this follow-up and
          goes to Conversations), and NOTHING on this screen answers a patient. */}
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Awaiting approval"
          value={Math.max(0, counts.awaiting - done)}
          dot="bg-status-amber"
        />
        <StatCard label="Sent" value={counts.sent} dot="bg-status-blue" />
        <StatCard
          label="Replies"
          value={counts.replies}
          dot="bg-status-green"
          hint="Answered in Conversations, not here."
        />
      </div>

      <SectionCard
        title="Closer drafts"
        description="Follow-ups on treatment that was planned and never completed. Nothing is sent until it is approved here."
        bodyClassName="pt-4"
      >
        {queue.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title={done > 0 ? "That is the queue cleared" : "No drafts waiting"}
            description={
              done > 0
                ? "Every draft has been dealt with. New ones appear here as the closer writes them."
                : "The closer writes a follow-up when a treatment plan has been sitting unfinished for three weeks. Drafts appear here for approval before anything is sent."
            }
          />
        ) : (
          <div className="space-y-4">
            {queue.map((d) => (
              <CloserDraftCard
                key={d.touchId}
                draft={d}
                nowIso={nowIso}
                onDone={(id) => setQueue((prev) => prev.filter((x) => x.touchId !== id))}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
