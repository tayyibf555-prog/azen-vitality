"use client";

import { useMemo, useState } from "react";
import { Clock, Loader2, LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill } from "@/components/primitives";
import {
  clockActionLabel,
  clockStateSentence,
  myClockRow,
  panelStateFor,
  type LoadFailure,
  type SelfClockRow,
} from "@/lib/my-work/rules";
import { PanelShell } from "./panel-shell";
import { useSelfServiceRead } from "./use-self-service";
import { instantLabel, myClockUrl } from "./shared";

// MY CLOCK — clocking yourself in and out, and nothing else.
//
// WHY IT IS HERE. `people.clock.self` is granted to `client_staff` because "a
// nurse clocking herself in is the whole reason it exists", and POST
// /api/staff-check-in already takes the self path with no staffId in the body.
// But `staff-check-in` is not in STAFF_SLUGS, so that page 404s for her: the
// capability and the open route existed with no door. This is the door.
//
// IT IS A SMALL, HONEST SURFACE, deliberately. The manager's screen shows the
// whole team, today's rota comparison and the exception list; this shows one
// person one fact and one button. Anything more would be a second attendance
// screen to keep in step with the first.
//
// EVERY RULE COMES FROM SOMEWHERE ELSE. Which tap is legal is `nextKind`, decided
// by the clocking lane's own state machine and re-checked server side by
// `validateClock`; which row is mine and what the sentence says are in
// @/lib/my-work/rules. This file formats and posts.

interface CheckInResponse {
  ok?: boolean;
  ready?: boolean;
  canManage?: boolean;
  me?: { id: string } | null;
  view?: { rows?: SelfClockRow[] };
  error?: string;
}

export function MyClockTab({
  clientSlug,
  selfStaffId,
  identityLoading,
  identityFailure,
}: {
  clientSlug: string;
  selfStaffId: string | null;
  identityLoading: boolean;
  identityFailure: LoadFailure | null;
}) {
  const url = selfStaffId ? myClockUrl(clientSlug) : null;
  const { data, loading, failure, reload } = useSelfServiceRead<CheckInResponse>(url);

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const row = useMemo(
    () => myClockRow(data?.view?.rows ?? [], selfStaffId),
    [data, selfStaffId],
  );

  // "Clocking is not switched on for this practice yet" is a failure to answer,
  // not an answer, exactly as the vault's `ready:false` is.
  const notReady: LoadFailure | null =
    data && data.ready === false
      ? {
          status: 503,
          serverMessage:
            "Clocking is not switched on for this practice yet, so there is nothing to show.",
        }
      : null;

  const state = panelStateFor({
    subject: "your clocking",
    consequence: "there is nothing to clock",
    loading: identityLoading || loading,
    linked: selfStaffId !== null,
    failure: identityFailure ?? failure ?? notReady,
    // Always 1 when ready: this tab has one thing to show, and PanelShell's
    // `empty` would otherwise swallow the button on the very day it is needed.
    count: 1,
  });

  async function tap() {
    if (busy || !row) return;
    setBusy(true);
    setActionError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/staff-check-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // NO staffId. The server resolves it from the session for the self path,
        // and sending one would take the manager branch — which refuses her.
        body: JSON.stringify({ clientSlug, kind: row.nextKind }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !body.ok) throw new Error(body.error || `That did not record (${res.status}).`);
      setMessage(row.nextKind === "in" ? "Clocked in. Have a good shift." : "Clocked out. Thank you.");
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "That did not record.");
    } finally {
      setBusy(false);
    }
  }

  const sinceLabel = row?.state === "in" && row.since ? instantLabel(row.since) : null;

  return (
    <SectionCard
      title="My clock"
      description="Clocking yourself in and out. Your practice manager sees the same record on the attendance screen."
      actions={
        state.kind === "ready" && row ? (
          <StatusPill tone={row.state === "in" ? "success" : "neutral"}>
            <Clock size={13} />
            {row.state === "in" ? "Clocked in" : "Clocked out"}
          </StatusPill>
        ) : null
      }
    >
      <div className="space-y-4">
        {message ? (
          <p className="rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
            {message}
          </p>
        ) : null}
        {actionError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        ) : null}

        <PanelShell
          state={state}
          loadingLabel="Loading your clocking..."
          empty={null}
        >
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line px-4 py-3">
            <p className="text-sm text-ink">{clockStateSentence(row, sinceLabel)}</p>
            {row ? (
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void tap()}>
                {busy ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : row.nextKind === "in" ? (
                  <LogIn size={15} />
                ) : (
                  <LogOut size={15} />
                )}
                {clockActionLabel(row.nextKind)}
              </Button>
            ) : null}
          </div>
        </PanelShell>
      </div>
    </SectionCard>
  );
}
