"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarOff, CheckCircle2, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, StatCard } from "@/components/primitives";
import { partitionAbsences } from "@/lib/absence/rules";
import type { AbsenceRow, AbsenceSummary } from "@/lib/absence/types";
import type { RotaStaff } from "@/lib/rota/types";
import { AbsenceList, type DecisionAction } from "./absence-list";
import { AbsenceRequestForm, type AbsenceFormValues } from "./absence-request-form";

// Holiday and absence workspace.
//
// The server has already decided everything: each row arrives with `canDecide`,
// `canCancel`, `overlapIds` and its day count computed by @/lib/absence/rules, and
// the summary counts come the same way. The only rule this file calls is
// `partitionAbsences`, and it calls the tested function rather than inlining three
// filters, so which list a row lands in stays provable.

const EMPTY_SUMMARY: AbsenceSummary = { pending: 0, upcoming: 0, awayToday: 0, total: 0 };

interface ListResponse {
  ok?: boolean;
  absences?: AbsenceRow[];
  summary?: AbsenceSummary;
  staff?: RotaStaff[];
  error?: string;
}

/**
 * The NETWORK half on its own, outside the component and holding no state: it
 * either resolves with a good payload or throws. Separating it is what lets the
 * mount effect keep its setState inside a `.then` callback (see the effect below)
 * while the reload-after-an-action path awaits the same function.
 */
async function readAbsence(clientSlug: string): Promise<ListResponse> {
  const res = await fetch(`/api/absence?client=${encodeURIComponent(clientSlug)}`);
  const data = (await res.json().catch(() => ({}))) as ListResponse;
  if (!res.ok || !data.ok) throw new Error(data.error || `Could not load absence (${res.status}).`);
  return data;
}

export function AbsenceWorkspace({
  clientSlug,
  isAllSites,
  siteName,
}: {
  clientSlug: string;
  /** True when the top-bar switcher is on "All sites". */
  isAllSites: boolean;
  /** The selected site's name when a single site is chosen, else null. */
  siteName: string | null;
}) {
  const [rows, setRows] = useState<AbsenceRow[]>([]);
  const [staff, setStaff] = useState<RotaStaff[]>([]);
  const [summary, setSummary] = useState<AbsenceSummary>(EMPTY_SUMMARY);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Applying a good payload, and applying a failure, are ONE function each, shared
  // by the mount effect and by the reload after an action so the two cannot drift.
  const applyLoaded = useCallback((data: ListResponse) => {
    setRows(data.absences ?? []);
    setStaff(data.staff ?? []);
    setSummary(data.summary ?? EMPTY_SUMMARY);
    setLoadError(null);
    setLoading(false);
  }, []);

  const applyFailure = useCallback((err: unknown) => {
    setLoadError(err instanceof Error ? err.message : "Could not load absence.");
    setRows([]);
    setSummary(EMPTY_SUMMARY);
    setLoading(false);
  }, []);

  // THE FETCH IS IN THE EFFECT, THE setState IS IN ITS CALLBACK — the same shape as
  // useDiaryDay (src/components/client/calendar/use-diary-day.ts), which is the
  // house pattern for this exact job. Two reasons, and the lint rule is the lesser:
  //
  //  - it stops the mount doing a render, a synchronous setState and a second render
  //    before the request has even been issued (react-hooks/set-state-in-effect);
  //  - `cancelled` retires an in-flight answer when the client changes or the screen
  //    unmounts, which the previous `void load()` did not: its response landed
  //    whenever it arrived, so a slow reply for one practice could repaint over a
  //    faster one for the next.
  useEffect(() => {
    let cancelled = false;
    readAbsence(clientSlug)
      .then((data) => {
        if (!cancelled) applyLoaded(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) applyFailure(err);
      });
    return () => {
      cancelled = true;
    };
  }, [clientSlug, applyLoaded, applyFailure]);

  // The reload after an approve, refuse, cancel or new request. Called from event
  // handlers only, never from an effect. It deliberately does NOT put the spinner
  // back: the list you have just acted on should not vanish and return, and the
  // row's own busy state already says what is happening.
  const reload = useCallback(async () => {
    try {
      applyLoaded(await readAbsence(clientSlug));
    } catch (err) {
      applyFailure(err);
    }
  }, [clientSlug, applyLoaded, applyFailure]);

  const parts = useMemo(() => partitionAbsences(rows), [rows]);

  async function submitRequest(values: AbsenceFormValues) {
    setSubmitting(true);
    setFormError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/absence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          staffId: values.staffId,
          kind: values.kind,
          startDate: values.startDate,
          endDate: values.endDate,
          note: values.note.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        overlapIds?: string[];
        error?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not add the request (${res.status}).`);
      setShowForm(false);
      setMessage(
        (data.overlapIds?.length ?? 0) > 0
          ? "Request added. It clashes with time off already booked for that person, so check before approving."
          : "Request added and waiting for a decision.",
      );
      await reload();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not add the request.");
    } finally {
      setSubmitting(false);
    }
  }

  async function patch(id: string, body: Record<string, unknown>, failure: string) {
    if (busyId) return;
    setBusyId(id);
    setActionError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/absence/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `${failure} (${res.status}).`);
      await reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : failure);
    } finally {
      setBusyId(null);
    }
  }

  function decide(id: string, action: DecisionAction, note: string) {
    void patch(
      id,
      { action, decisionNote: note.trim() || null },
      action === "approve" ? "Could not approve the request" : "Could not refuse the request",
    );
  }

  function cancel(id: string) {
    if (!window.confirm("Cancel this absence? It goes back on the rota as a working day.")) return;
    void patch(id, { action: "cancel" }, "Could not cancel the absence");
  }

  const scopeHint = isAllSites || !siteName ? "Across all sites" : `At ${siteName}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard
          label="Awaiting decision"
          value={summary.pending}
          dot="bg-status-amber"
          hint="Requests still to answer"
          emphasis
        />
        <StatCard label="Away today" value={summary.awayToday} dot="bg-status-blue" hint={scopeHint} />
        <StatCard
          label="Booked ahead"
          value={summary.upcoming}
          dot="bg-status-green"
          hint="Approved and still to come"
        />
        <StatCard label="Staff" value={staff.length} dot="bg-line-strong" hint="On the rota" />
      </div>

      {message ? (
        <p className="flex items-start gap-2 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success">
          <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
          {message}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{actionError}</p>
      ) : null}

      <SectionCard
        title="Awaiting decision"
        description="Requests nobody has answered yet. Approving takes the person off the rota for those days; nobody can approve their own request."
        actions={
          <Button
            variant={showForm ? "secondary" : "primary"}
            size="sm"
            onClick={() => {
              setFormError(null);
              setShowForm((s) => !s);
            }}
          >
            {showForm ? <X size={15} /> : <Plus size={15} />}
            {showForm ? "Cancel" : "Record absence"}
          </Button>
        }
      >
        <div className="space-y-5">
          {showForm ? (
            <AbsenceRequestForm
              staff={staff}
              submitting={submitting}
              error={formError}
              onSubmit={submitRequest}
              onCancel={() => {
                setShowForm(false);
                setFormError(null);
              }}
            />
          ) : null}

          {loadError ? (
            <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
              {loadError}
            </p>
          ) : loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
              <Loader2 size={16} className="animate-spin" />
              Loading absence...
            </div>
          ) : summary.total === 0 ? (
            <EmptyState
              icon={CalendarOff}
              title="No absence recorded"
              description="Record holiday, sickness, training or unpaid leave here. Once it is approved the rota stops scheduling that person for those days."
            >
              <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
                <Plus size={15} /> Record absence
              </Button>
            </EmptyState>
          ) : (
            <AbsenceList
              rows={parts.awaiting}
              staff={staff}
              busyId={busyId}
              onDecide={decide}
              onCancel={cancel}
              emptyMessage="Nothing is waiting for a decision."
            />
          )}
        </div>
      </SectionCard>

      {!loading && !loadError && summary.total > 0 ? (
        <>
          <SectionCard
            title="Booked and coming up"
            description="Decided absence that has not finished yet. Approved days are already out of the generated rota."
          >
            <AbsenceList
              rows={parts.upcoming}
              staff={staff}
              busyId={busyId}
              onDecide={decide}
              onCancel={cancel}
              emptyMessage="Nothing booked in the period shown."
            />
          </SectionCard>

          <SectionCard title="Finished" description="Absence that has already been and gone.">
            <AbsenceList
              rows={parts.past}
              staff={staff}
              busyId={busyId}
              onDecide={decide}
              onCancel={cancel}
              emptyMessage="Nothing has finished in the period shown."
            />
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
