// ---------------------------------------------------------------------------
// The ACCOUNTS panel: one large balance, then the ten patients who owe most.
//
// Two figures, and they are not the same figure:
//
//   netBalancePence   every balance summed, credits included. This is the
//                     headline, and Dentally prints it as a negative (money the
//                     practice is owed shows as minus). Callers render the sign.
//   totalOwedPence    only the positive balances. This is what the ranked list
//                     adds up to, and it is larger than the net whenever any
//                     patient is in credit.
//
// A patient can appear on several invoices, so balances are summed per patient
// before ranking. Ties break on name then id, so the list does not reshuffle
// between two loads of the same data.
// ---------------------------------------------------------------------------

import type { DashboardAccountBalance } from "@/lib/dashboard/normalise";

export interface RankedAccount {
  patientId: string;
  /** Null when the source row carried no name; the panel links by id and says so. */
  patientName: string | null;
  owedPence: number;
}

export interface OutstandingAccounts {
  /** Every balance summed, credits included. Displayed as a negative. */
  netBalancePence: number;
  /** Positive balances only: what patients actually owe between them. */
  totalOwedPence: number;
  /** The worst offenders, largest first. */
  top: RankedAccount[];
  /** How many patients carry a positive balance in total, not just the listed ones. */
  patientsInDebt: number;
  /** Rows the normaliser could not read, carried through for the panel to disclose. */
  dropped: number;
}

export interface OutstandingAccountsInput {
  balances: readonly DashboardAccountBalance[];
  /** How many to rank. Dentally shows ten. */
  limit?: number;
  /** Rows dropped upstream by the normaliser. */
  dropped?: number;
  /**
   * Optional patient id to site id map, for the per-site view. Balances live on
   * invoices, which do not carry a site, so attribution comes from the patient.
   * Patients missing from the map are excluded when a site filter is applied,
   * never assigned to the selected site.
   */
  siteByPatientId?: ReadonlyMap<string, string> | null;
  siteId?: string | null;
}

export function computeOutstandingAccounts(
  input: OutstandingAccountsInput,
): OutstandingAccounts {
  const limit = input.limit ?? 10;
  const siteId = input.siteId ?? null;

  const owedByPatient = new Map<string, number>();
  const nameByPatient = new Map<string, string | null>();

  for (const b of input.balances) {
    if (siteId !== null) {
      const patientSite = input.siteByPatientId?.get(b.patientId) ?? null;
      if (patientSite !== siteId) continue;
    }
    owedByPatient.set(b.patientId, (owedByPatient.get(b.patientId) ?? 0) + b.owedPence);
    // Keep the first non-null name seen for a patient.
    if (b.patientName !== null && !nameByPatient.get(b.patientId)) {
      nameByPatient.set(b.patientId, b.patientName);
    } else if (!nameByPatient.has(b.patientId)) {
      nameByPatient.set(b.patientId, null);
    }
  }

  let netBalancePence = 0;
  let totalOwedPence = 0;
  const inDebt: RankedAccount[] = [];

  for (const [patientId, owedPence] of owedByPatient) {
    netBalancePence += owedPence;
    if (owedPence > 0) {
      totalOwedPence += owedPence;
      inDebt.push({ patientId, patientName: nameByPatient.get(patientId) ?? null, owedPence });
    }
  }

  inDebt.sort((a, b) => {
    if (b.owedPence !== a.owedPence) return b.owedPence - a.owedPence;
    const nameA = a.patientName ?? "";
    const nameB = b.patientName ?? "";
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return a.patientId < b.patientId ? -1 : a.patientId > b.patientId ? 1 : 0;
  });

  return {
    netBalancePence,
    totalOwedPence,
    top: inDebt.slice(0, Math.max(0, limit)),
    patientsInDebt: inDebt.length,
    dropped: input.dropped ?? 0,
  };
}

// --- The INVOICED panel ----------------------------------------------------

/**
 * The INVOICED panel: one money total, and a two-bar chart of paid vs unpaid.
 *
 * Invoiced totals are gross (what was billed), which is a different question
 * from takings (what was collected), so this reads invoice rows rather than
 * payments. `paidPence` is derived as gross minus outstanding, so a partly paid
 * invoice contributes to both bars, which is what the chart is showing.
 */
export interface InvoicedTotals {
  /** Gross invoiced in the window. */
  totalPence: number;
  paidPence: number;
  unpaidPence: number;
  invoiceCount: number;
  dropped: number;
}

export interface InvoicedInput {
  /** Rows of { grossPence, outstandingPence } already normalised by the caller. */
  invoices: readonly { grossPence: number; outstandingPence: number }[];
  dropped?: number;
}

export function computeInvoicedTotals(input: InvoicedInput): InvoicedTotals {
  let totalPence = 0;
  let unpaidPence = 0;
  for (const inv of input.invoices) {
    totalPence += inv.grossPence;
    unpaidPence += inv.outstandingPence;
  }
  return {
    totalPence,
    paidPence: totalPence - unpaidPence,
    unpaidPence,
    invoiceCount: input.invoices.length,
    dropped: input.dropped ?? 0,
  };
}
