"use client";

import { formatPenceGbp } from "@/lib/dashboard/money";
import type { InvoicedPanel as Panel } from "@/lib/dashboard/view";
import { num } from "@/lib/utils";
import { CaveatMark } from "./caveat";
import type { Caveat } from "./caveats";
import { Money, PanelTitle, Unavailable } from "./parts";

// ---------------------------------------------------------------------------
// The INVOICED panel: what was billed in the selected period, split paid and
// unpaid.
//
// Invoiced is not takings. Takings is what came through the till; invoiced is
// what went out on paper. The two panels sit next to each other and are read
// together, so the unpaid bar is labelled as the gap between them rather than
// left to be inferred.
//
// Two bars, drawn to scale against the gross, with the figures beside them: at a
// glance the ratio, on a second look the money.
// ---------------------------------------------------------------------------

function Bar({
  label,
  pence,
  ofPence,
  tone,
}: {
  label: string;
  pence: number;
  ofPence: number;
  tone: string;
}) {
  const share = ofPence > 0 ? Math.max(0, Math.min(1, pence / ofPence)) : 0;
  return (
    <div className="py-[3px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-muted">{label}</span>
        <span className="text-[12.5px] font-bold tabular-nums tracking-[-0.2px] text-navy">
          {formatPenceGbp(pence)}
        </span>
      </div>
      <div className="mt-1 h-[6px] w-full overflow-hidden rounded-full bg-card-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.round(share * 100)}%`, background: tone }}
        />
      </div>
    </div>
  );
}

export function InvoicedPanelView({
  panel,
  caveats,
  onOpenCaveat,
}: {
  panel: Panel;
  caveats: Caveat[];
  onOpenCaveat: (id: string) => void;
}) {
  const total = panel.totalPence.value;
  const paid = panel.paidPence.value;
  const unpaid = panel.unpaidPence.value;

  return (
    <section aria-label="Invoiced" className="flex h-full min-w-0 flex-col">
      <PanelTitle>Invoiced</PanelTitle>

      <div className="flex items-baseline gap-1.5 pt-2">
        <Money metric={panel.totalPence} size="figure" className="leading-[1.1]" />
        <CaveatMark caveats={caveats} onOpen={onOpenCaveat} />
      </div>
      <span className="block text-[11px] font-medium text-muted">
        {panel.invoiceCount.value === null ? (
          "billed in this period"
        ) : (
          <>
            on {num(panel.invoiceCount.value)} invoice
            {panel.invoiceCount.value === 1 ? "" : "s"} in this period
          </>
        )}
      </span>

      {/* The split sits against the foot of the band rather than trailing off
          under the headline, so the column ends where its neighbours do. */}
      {total === null || paid === null || unpaid === null ? (
        <div className="pt-2">
          <Unavailable reason={panel.totalPence.reason} />
        </div>
      ) : (
        <div className="mt-auto pt-2">
          <Bar label="Paid" pence={paid} ofPence={total} tone="var(--status-green)" />
          <Bar label="Unpaid" pence={unpaid} ofPence={total} tone="var(--status-amber)" />
        </div>
      )}
    </section>
  );
}
