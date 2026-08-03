"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Loader2,
  Check,
  Clock,
  ExternalLink,
  UserCheck,
  UserMinus,
  ListChecks,
  ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { TASK_KIND_LABEL, type Task, type TaskKind } from "@/lib/task-queue/types";
import { shellBase } from "@/lib/nav-shell";

// The list API's shape. Kept local so this file owns its own contract.
interface ListResponse {
  ok?: boolean;
  tasks?: Task[];
  counts?: { total: number; byKind?: { kind: TaskKind; count: number }[] };
  error?: string;
}

const SNOOZE_OPTIONS: { label: string; minutes: number }[] = [
  { label: "1 hour", minutes: 60 },
  { label: "1 day", minutes: 1440 },
  { label: "3 days", minutes: 4320 },
];

type ActiveAction = "complete" | "claim" | "unclaim" | "snooze";

export function TaskQueueBoard({
  clientSlug,
  maxRows,
  title = "Worklist",
  description = "The next thing to do, ranked. Working from the top keeps the practice ahead of every lead, recall and plan.",
  plain,
}: {
  clientSlug: string;
  /** Cap the visible rows (Home embed). A "View all" link appears when truncated. */
  maxRows?: number;
  title?: string;
  description?: string;
  /** Render as a plain hairline section instead of a boxed card (Home). */
  plain?: boolean;
}) {
  // "View all" must stay in the tree the reader is already in: this board is
  // embedded on BOTH the /c home and the /owner home, and a hard-coded /c link
  // ejected the owner from their own shell.
  const basePath = shellBase(usePathname(), clientSlug);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Filters: a single active kind (null = all) plus a "Mine" toggle.
  const [kindFilter, setKindFilter] = useState<TaskKind | null>(null);
  const [mineOnly, setMineOnly] = useState(false);

  // Per-row in-flight guard + which snooze menu is open, keyed by task key.
  const [busyKey, setBusyKey] = useState<{ key: string; action: ActiveAction } | null>(null);
  const [snoozeOpen, setSnoozeOpen] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/task-queue/list?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as ListResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load tasks (${res.status}).`);
      setTasks(data.tasks ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load tasks.");
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  // Reset filters + refetch whenever the client changes.
  useEffect(() => {
    setKindFilter(null);
    setMineOnly(false);
    setSnoozeOpen(null);
    setActionError(null);
    void load();
  }, [load]);

  // Dismiss the open snooze menu on an outside click or Escape (matches the app's
  // Esc-closes-popups convention). Clicks inside any snooze root are ignored so the
  // toggle / menu items keep working and switching rows still opens the other menu.
  useEffect(() => {
    if (!snoozeOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest?.("[data-snooze-root]")) setSnoozeOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSnoozeOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [snoozeOpen]);

  // Counts per kind, in the priority-sorted order each kind first appears.
  const kindCounts = useMemo(() => {
    const m = new Map<TaskKind, number>();
    for (const t of tasks) m.set(t.kind, (m.get(t.kind) ?? 0) + 1);
    return Array.from(m, ([kind, count]) => ({ kind, count }));
  }, [tasks]);

  const visible = useMemo(() => {
    return tasks.filter((t) => {
      if (kindFilter && t.kind !== kindFilter) return false;
      if (mineOnly && !t.assignee) return false;
      return true;
    });
  }, [tasks, kindFilter, mineOnly]);

  // POST an action. complete/dismiss/snooze remove the row optimistically and
  // revert on error; claim/unclaim patch the row in place.
  async function act(task: Task, action: "complete" | "dismiss" | "snooze" | "claim" | "unclaim", snoozeMinutes?: number) {
    if (busyKey) return;
    const removes = action === "complete" || action === "dismiss" || action === "snooze";
    const guardAction: ActiveAction =
      action === "dismiss" ? "complete" : (action as ActiveAction);
    setBusyKey({ key: task.key, action: guardAction });
    setActionError(null);
    setSnoozeOpen(null);

    const prev = tasks;
    if (removes) {
      setTasks((list) => list.filter((t) => t.key !== task.key));
    } else if (action === "claim" || action === "unclaim") {
      // We can't know the current user's email client-side, so on claim we mark the
      // row as assigned without a name; the next load resolves the real assignee.
      const assignee = action === "claim" ? task.assignee ?? "you" : null;
      setTasks((list) => list.map((t) => (t.key === task.key ? { ...t, assignee } : t)));
    }

    try {
      const res = await fetch("/api/task-queue/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, taskKey: task.key, action, snoozeMinutes }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        overlay?: { assignee?: string | null };
      };
      if (!res.ok || !data.ok) throw new Error(data.error || "action failed");
      // Reconcile a claim/unclaim to the server's real assignee (the optimistic
      // placeholder above is replaced by the actual email the API resolved).
      if (action === "claim" || action === "unclaim") {
        const assignee = data.overlay?.assignee ?? null;
        setTasks((list) => list.map((t) => (t.key === task.key ? { ...t, assignee } : t)));
      }
    } catch (err) {
      setTasks(prev); // revert
      setActionError(err instanceof Error ? err.message : "Could not update the task.");
    } finally {
      setBusyKey(null);
    }
  }

  const total = tasks.length;
  // Home embed: show the top rows only; the queue is priority-sorted by the API,
  // so the cap keeps the highest-priority work visible and links to the rest.
  const shown = maxRows !== undefined ? visible.slice(0, maxRows) : visible;
  const truncated = visible.length - shown.length;

  return (
    <SectionCard
      plain={plain}
      title={title}
      description={description}
      actions={
        <button
          type="button"
          onClick={() => setMineOnly((v) => !v)}
          className={cn(
            "pressable rounded-md border px-3 py-1 text-xs font-medium transition-colors",
            mineOnly
              ? "border-navy bg-navy font-semibold text-white"
              : "border-line-strong bg-card text-muted hover:text-navy",
          )}
        >
          {mineOnly ? "Showing claimed" : "Claimed only"}
        </button>
      }
    >
      <div className="space-y-4">
        {/* Counts header + per-kind filter chips */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setKindFilter(null)}
            className={cn(
              "pressable rounded-md border px-3 py-1 text-xs font-medium transition-colors",
              kindFilter === null
                ? "border-navy bg-navy font-semibold text-white"
                : "border-line-strong bg-card text-muted hover:text-navy",
            )}
          >
            All <span className="tabular-nums">{total}</span>
          </button>
          {kindCounts.map(({ kind, count }) => (
            <button
              key={kind}
              type="button"
              onClick={() => setKindFilter((k) => (k === kind ? null : kind))}
              className={cn(
                "pressable rounded-md border px-3 py-1 text-xs font-medium transition-colors",
                kindFilter === kind
                  ? "border-navy bg-navy font-semibold text-white"
                  : "border-line-strong bg-card text-muted hover:text-navy",
              )}
            >
              {TASK_KIND_LABEL[kind]} <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>

        {actionError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
            {actionError}
          </p>
        ) : null}

        {/* List */}
        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading tasks...
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title={total === 0 ? "All clear" : "Nothing matches this filter"}
            description={
              total === 0
                ? "Nothing needs your attention right now."
                : "Try a different kind, or clear the filters."
            }
          />
        ) : (
          // Hairline list rows (Apple-style restraint) instead of boxed row cards:
          // dividers + vertical rhythm carry the separation.
          <ul className="divide-y divide-line">
            {shown.map((task) => {
              const busy = busyKey?.key === task.key;
              return (
                <li key={task.key} className="px-1 py-3.5 first:pt-1">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone="neutral">{TASK_KIND_LABEL[task.kind]}</StatusPill>
                        <span className="font-semibold text-navy">{task.title}</span>
                        {task.assignee ? (
                          <StatusPill tone="neutral">
                            <UserCheck size={11} />
                            {task.assignee}
                          </StatusPill>
                        ) : null}
                      </div>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
                        {task.subtitle ? <span className="text-ink">{task.subtitle}</span> : null}
                        {task.subtitle && task.dueHint ? (
                          <span className="text-line-strong">/</span>
                        ) : null}
                        {task.dueHint ? <span>{task.dueHint}</span> : null}
                      </p>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <a
                        href={task.href}
                        className="inline-flex items-center gap-1.5 rounded-md border border-line-strong bg-card px-2.5 py-1 text-xs font-medium text-navy transition-colors hover:bg-[#f7f9fc]"
                      >
                        <ExternalLink size={13} /> Open
                      </a>

                      {task.assignee ? (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => act(task, "unclaim")}
                        >
                          {busy && busyKey?.action === "unclaim" ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <UserMinus size={14} />
                          )}
                          Unclaim
                        </Button>
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => act(task, "claim")}
                        >
                          {busy && busyKey?.action === "claim" ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <UserCheck size={14} />
                          )}
                          Claim
                        </Button>
                      )}

                      <div className="relative" data-snooze-root>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busy}
                          onClick={() => setSnoozeOpen((k) => (k === task.key ? null : task.key))}
                        >
                          {busy && busyKey?.action === "snooze" ? (
                            <Loader2 size={14} className="animate-spin" />
                          ) : (
                            <Clock size={14} />
                          )}
                          Snooze
                          <ChevronDown size={13} />
                        </Button>
                        {snoozeOpen === task.key ? (
                          <div className="absolute right-0 z-10 mt-1 w-32 overflow-hidden rounded-lg border border-line-strong bg-card shadow-md">
                            {SNOOZE_OPTIONS.map((o) => (
                              <button
                                key={o.minutes}
                                type="button"
                                onClick={() => act(task, "snooze", o.minutes)}
                                className="block w-full px-3 py-1.5 text-left text-xs font-medium text-navy transition-colors hover:bg-[#f7f9fc]"
                              >
                                {o.label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      <Button
                        variant="primary"
                        size="sm"
                        disabled={busy}
                        onClick={() => act(task, "complete")}
                      >
                        {busy && busyKey?.action === "complete" ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Check size={14} />
                        )}
                        Done
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
            {truncated > 0 ? (
              <li className="px-1 py-3">
                <a
                  href={`${basePath}/task-queue`}
                  className="text-caption font-medium text-blue-royal hover:underline"
                >
                  View all {visible.length} tasks →
                </a>
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </SectionCard>
  );
}
