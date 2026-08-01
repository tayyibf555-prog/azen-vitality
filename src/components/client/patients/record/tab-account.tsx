import { StatusPill } from "@/components/primitives";
import { NotLoaded, PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY, NOT_HELD_COPY } from "@/lib/patient/tabs";
import { londonDateLabel } from "@/lib/time/london";
import { gbp } from "@/lib/utils";
import { balanceLabel } from "@/lib/patient/record-derive";
import type { PatientDetail, ReadHealth } from "@/lib/dentally/read";
import type { PatientDerived } from "@/lib/patient/record-derive";

/**
 * Account: Dentally's own account card, then Dentally's own invoice table.
 *
 * THE COLUMNS ARE DENTALLY'S, IN DENTALLY'S ORDER, and three of them we cannot fill.
 * They stay anyway. PRODUCT.md forbids dropping a column to improve a composition,
 * and a Dentally user scanning for Location should find it where it lives. They render
 * a dash with ONE footnote under the table, which is the density-correct way to carry
 * a caveat; a chip in every cell is the failure mode the same document names.
 *
 * TWO THINGS ARE ABSENT AND SAY SO:
 *  - PAYMENTS. /v1/payments accepts only siteId, page and perPage, and live Dentally
 *    ignores every date filter and returns 7,784 rows for one site. Listing a
 *    patient's payments would mean reading the whole site's payment history on every
 *    record open, so it is not shown and the reason is printed.
 *  - "SET BAD DEBTOR". Dentally's own action, with no equivalent here. The nearest
 *    thing is the do_not_contact status override, which is a MESSAGING-SUPPRESSION
 *    concept and is never faked upstream. Relabelling it would be a lie about what
 *    the button does, and a dead button is worse than a sentence.
 */
export function TabAccount({
  detail,
  derived,
  reads,
  patientName,
}: {
  detail: PatientDetail;
  derived: PatientDerived;
  reads: ReadHealth;
  patientName: string;
}) {
  const failed = reads.invoices === "failed";
  const paid = derived.lifetimeSpend;
  const balance = balanceLabel(derived.outstanding, derived.credit, gbp);

  return (
    <div className="space-y-5">
      <PanelSection title={`${patientName}'s account`}>
        {failed ? (
          <PanelFailed>{FAILED_COPY.invoices}</PanelFailed>
        ) : (
          <dl className="flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt className="text-[10.5px] font-medium text-muted">Balance</dt>
              <dd
                className={
                  balance.tone === "owed"
                    ? "text-[19px] font-bold tabular-nums tracking-[-0.4px] text-status-red"
                    : "text-[19px] font-bold tabular-nums tracking-[-0.4px] text-navy"
                }
              >
                {balance.text}
              </dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-medium text-muted">Total invoiced</dt>
              <dd className="text-[19px] font-bold tabular-nums tracking-[-0.4px] text-navy">
                {gbp(derived.totalInvoiced)}
              </dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-medium text-muted">Total paid</dt>
              <dd className="text-[19px] font-bold tabular-nums tracking-[-0.4px] text-navy">{gbp(paid)}</dd>
            </div>
          </dl>
        )}
        <PanelNote>{NOT_HELD_COPY.badDebtor}</PanelNote>
      </PanelSection>

      <PanelSection title="Invoices">
        {failed ? (
          <PanelFailed>{FAILED_COPY.invoices}</PanelFailed>
        ) : detail.invoices.length === 0 ? (
          <PanelEmpty>{EMPTY_COPY.invoices}</PanelEmpty>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Invoice</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Status</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Date</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Patient</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Summary</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Practitioners</th>
                    <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Location</th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-faint">Balance</th>
                    <th className="px-2 py-1.5 text-right text-[11px] font-medium text-faint">Total invoiced</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.invoices.map((inv) => (
                    <tr key={inv.id} className="border-b border-line last:border-0">
                      <td className="whitespace-nowrap px-2 py-2 font-medium tabular-nums text-navy">
                        {inv.reference}
                      </td>
                      <td className="px-2 py-2">
                        {inv.status ? (
                          <StatusPill tone={inv.balance > 0 ? "warning" : "success"}>{inv.status}</StatusPill>
                        ) : (
                          <NotLoaded title="Not returned by the invoice read we have" />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-2 py-2 tabular-nums text-muted">
                        {inv.date ? (
                          londonDateLabel(inv.date)
                        ) : (
                          <NotLoaded title="Not returned by the invoice read we have" />
                        )}
                      </td>
                      <td className="px-2 py-2 text-muted">{patientName}</td>
                      <td className="px-2 py-2">
                        <NotLoaded title="Not returned by the invoice read we have" />
                      </td>
                      <td className="px-2 py-2">
                        <NotLoaded title="Not returned by the invoice read we have" />
                      </td>
                      <td className="px-2 py-2">
                        <NotLoaded title="Not returned by the invoice read we have" />
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        <span className={inv.balance > 0 ? "font-semibold text-status-red" : "text-muted"}>
                          {gbp(inv.balance)}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-right font-medium tabular-nums text-navy">{gbp(inv.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <PanelNote>{CANNOT_READ_COPY.invoiceColumns}</PanelNote>
          </>
        )}
      </PanelSection>

      <PanelSection title="Payments">
        <PanelNote>{CANNOT_READ_COPY.payments}</PanelNote>
      </PanelSection>
    </div>
  );
}
