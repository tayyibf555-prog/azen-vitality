import { SectionCard } from "@/components/primitives";
import type { Channel } from "@/lib/roi/types";
import { count, money } from "./format";

// The channel breakdown table: spend, leads, new patients, cost per acquisition,
// attributed revenue and ROI for each channel, sorted by revenue (the growth
// engine first), with a totals row. The best ROI is picked out in success green so
// the strongest return stands out without colouring the whole table.
export function ChannelBreakdown({
  channels,
  totals,
}: {
  channels: Channel[];
  totals: {
    spendGbp: number;
    leads: number;
    newPatients: number;
    revenueGbp: number;
    costPerAcquisitionGbp: number;
    returnX: number;
  };
}) {
  const sorted = [...channels].sort((a, b) => b.revenueGbp - a.revenueGbp);

  // Highest ROI among channels that actually spend (null-ROI channels excluded).
  const bestRoi = sorted.reduce<number | null>(
    (best, c) => (c.roiX !== null && (best === null || c.roiX > best) ? c.roiX : best),
    null,
  );

  return (
    <SectionCard
      title="Channel breakdown"
      description="Spend, new patients, cost per new patient and return for every acquisition channel."
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left">
              <th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-muted">
                Channel
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                Spend
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                Leads
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                New patients
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                Cost per patient
              </th>
              <th className="px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                Revenue
              </th>
              <th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-muted">
                ROI
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => {
              const isBest = c.roiX !== null && c.roiX === bestRoi;
              return (
                <tr key={c.id} className="border-b border-line/70">
                  <td className="px-5 py-3 font-semibold text-navy">{c.name}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink">
                    {c.spendGbp > 0 ? money(c.spendGbp) : <span className="text-muted">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink">{count(c.leads)}</td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink">
                    {count(c.newPatients)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink">
                    {c.cpaGbp > 0 ? money(c.cpaGbp, true) : <span className="text-muted">-</span>}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-ink">{money(c.revenueGbp)}</td>
                  <td className="px-5 py-3 text-right tabular-nums font-semibold">
                    {c.roiX === null ? (
                      <span className="text-muted" title="No ad spend on this channel">
                        -
                      </span>
                    ) : (
                      <span className={isBest ? "text-success" : "text-ink"}>
                        {c.roiX.toFixed(1)}x
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t border-line-strong bg-card-muted/60 font-semibold text-navy">
              <td className="px-5 py-3">All channels</td>
              <td className="px-3 py-3 text-right tabular-nums">{money(totals.spendGbp)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{count(totals.leads)}</td>
              <td className="px-3 py-3 text-right tabular-nums">{count(totals.newPatients)}</td>
              <td className="px-3 py-3 text-right tabular-nums">
                {money(totals.costPerAcquisitionGbp, true)}
              </td>
              <td className="px-3 py-3 text-right tabular-nums">{money(totals.revenueGbp)}</td>
              <td className="px-5 py-3 text-right tabular-nums text-success">
                {totals.returnX.toFixed(1)}x
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="border-t border-line px-5 py-3 text-xs text-muted">
        ROI shows attributed revenue for every £1 of spend. Channels with no media
        spend (referral, recall, reactivation, organic) show a dash rather than a
        return figure.
      </p>
    </SectionCard>
  );
}
