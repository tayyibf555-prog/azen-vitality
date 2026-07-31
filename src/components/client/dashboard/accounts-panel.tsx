"use client";

import Link from "next/link";
import { formatPenceGbp } from "@/lib/dashboard/money";
import type { AccountsPanel as Panel } from "@/lib/dashboard/view";
import { num } from "@/lib/utils";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { PanelTitle, Unavailable } from "./parts";

// ---------------------------------------------------------------------------
// The ACCOUNTS panel: one large balance, then the ten patients who owe most.
//
// The headline is printed as a negative, which is how Dentally prints it and how
// she reads it: money the practice is owed shows as minus. It is deliberately
// the net figure, credits included, and the ranked list underneath adds up to
// more than it whenever a patient is in credit. Both figures stay available: the
// mark beside the headline carries the difference, in full.
//
// This panel is a SNAPSHOT, not a window: an account balance is what is owed
// now, so it does not move when the period changes. The mark says so, because a
// figure that ignores the selected period without explaining itself reads as a
// bug.
// ---------------------------------------------------------------------------

export function AccountsPanelView({
  panel,
  clientSlug,
  caveats,
  onOpenCaveat,
}: {
  panel: Panel;
  clientSlug: string;
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  const net = panel.netBalancePence;

  return (
    <section aria-label="Accounts" className="flex h-full min-w-0 flex-col">
      <PanelTitle right="owed now">Accounts</PanelTitle>

      <div className="flex items-baseline gap-1.5 pt-2">
        {net.value === null ? (
          <Unavailable reason={net.reason} className="text-[22px]" />
        ) : (
          <span className="text-[22px] font-bold leading-[1.1] tabular-nums tracking-[-0.6px] text-status-red">
            {formatPenceGbp(-Math.abs(net.value))}
          </span>
        )}
        <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
      </div>
      <span className="block text-[11px] font-medium text-muted">
        {panel.patientsInDebt.value === null ? (
          "balance across all accounts"
        ) : (
          <>
            across {num(panel.patientsInDebt.value)} account
            {panel.patientsInDebt.value === 1 ? "" : "s"} in debt
          </>
        )}
      </span>

      {panel.top.length === 0 ? (
        <p className="pt-2 text-[11px] font-medium text-muted">
          {net.value === null ? "" : "No account carries a balance."}
        </p>
      ) : (
        <ol className="mt-2 divide-y divide-line border-t border-line">
          {/* No rank numeral. Dentally does not print one, and it earns nothing:
              the list is already sorted by amount, so the position IS the rank,
              and the numeral competed with the money for the eye. */}
          {panel.top.map((account) => (
            <li key={account.patientId} className="flex items-baseline gap-2 py-[3px]">
              <Link
                href={`/c/${clientSlug}/patients?patient=${encodeURIComponent(account.patientId)}`}
                className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-blue-deep underline-offset-2 hover:underline"
              >
                {account.patientName ?? `Patient ${account.patientId}`}
              </Link>
              <span className="shrink-0 text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
                {formatPenceGbp(account.owedPence)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
