"use client";

import { AlertTriangle, Link2Off, Loader2 } from "lucide-react";
import type { PanelState } from "@/lib/my-work/rules";

// One renderer for every tab, so "failed", "loading", "not linked" and
// "empty" look and read the same everywhere.
//
// It holds NO conditions of its own beyond switching on the state it is handed.
// Which state a tab is in is decided by `panelStateFor` in @/lib/my-work/rules,
// where the ordering rule that matters — a failure outranks everything — is
// under test. A component cannot quietly reorder it.

export function PanelShell({
  state,
  loadingLabel,
  empty,
  children,
}: {
  state: PanelState;
  /** "Loading your shifts..." — said out loud so a slow read is not a blank box. */
  loadingLabel: string;
  /** What to render when the read succeeded and there is genuinely nothing. */
  empty: React.ReactNode;
  children: React.ReactNode;
}) {
  if (state.kind === "failed") {
    return (
      <p className="flex items-start gap-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5 text-sm text-danger">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <span>{state.message}</span>
      </p>
    );
  }

  if (state.kind === "loading") {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" />
        {loadingLabel}
      </div>
    );
  }

  if (state.kind === "unlinked") {
    return (
      <p className="flex items-start gap-2 rounded-xl border border-line bg-card-muted/20 px-4 py-3 text-[13px] text-muted">
        <Link2Off size={16} className="mt-0.5 shrink-0" />
        <span>{state.message}</span>
      </p>
    );
  }

  return <>{state.count === 0 ? empty : children}</>;
}
