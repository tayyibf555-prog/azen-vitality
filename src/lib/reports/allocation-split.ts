// ---------------------------------------------------------------------------
// THE MONEY RULE. One payment-explanation leg, against the invoice it settled,
// split into what each clinician earned.
//
// A Dentally explanation says WHICH INVOICE the money settled. It never says
// WHICH LINE. That single fact decides everything below.
//
// The four bases, and why each is what it is:
//
//   sole_practitioner            One clinician on the invoice's lines. There is
//                                no ambiguity about WHO, so the leg is theirs.
//                                98.0% of measured legs.
//
//   pro_rata_full_settlement     Several clinicians, and the leg settles the
//                                invoice in full. Every line is being paid, so
//                                each clinician's share is their share of the
//                                invoice's line value — arithmetic, not a guess.
//                                Whole pence, largest-remainder, so the parts sum
//                                EXACTLY to the leg and no penny is created or
//                                destroyed by rounding.
//
//   shared_invoice_part_payment  Several clinicians, and the leg is a PART
//                                payment. THIS ATTRIBUTES TO NOBODY. Pro-rating
//                                here would invent an allocation the practice
//                                never made: when a patient pays £200 off a £600
//                                invoice covering two clinicians, Dentally
//                                records no fact about whose work that £200 paid
//                                for. In the one report where the number becomes a
//                                person's wages, a fabricated split is the worst
//                                available answer. So the money is bucketed into
//                                its own VISIBLE row and named. Worst case that
//                                withholds 11.2% of money (the measured share
//                                sitting on multi-practitioner invoices) into a
//                                row Blerta can see and chase — acceptable. An
//                                invented split is not.
//
//   no_attributable_lines        The invoice was read, but its lines carry no
//                                clinician (or carry no apportionable value at
//                                all). Bucketed, never handed to the person who
//                                took the payment.
//
// REFUNDS (negative amounts, 12 in the measured 60 days) flow through the same
// rules unchanged and correctly REDUCE a clinician's line. The largest-remainder
// distribution is sign-safe: see apportionLargestRemainder.
//
// ONE DELIBERATE STRENGTHENING of the brief's rule. Where an invoice's lines are
// only PARTLY attributed — some lines carry a clinician, some do not — the leg is
// apportioned across ALL lines by value and only the clinician-bearing shares are
// attributed; the rest lands in the same visible bucket as `no_attributable_lines`.
// Handing the un-clinician'd lines' money to the one clinician who happens to be
// on the invoice would be the identical fabrication the part-payment refusal
// exists to prevent. This changes NOTHING on measured data — practitioner_id was
// present on every line of every sampled invoice (256/256), so apportioning gives
// the sole clinician the whole leg — and it refuses to guess on the shape nobody
// has yet seen.
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import { invoicePractitionerIds, type InvoiceWithItems } from "@/lib/dentally/invoice-shape";

export type AllocationBasis =
  | "sole_practitioner"
  | "pro_rata_full_settlement"
  | "shared_invoice_part_payment"
  | "no_attributable_lines";

/** Human wording for the basis chip. Rendered verbatim; N is the clinician count. */
export const ALLOCATION_BASIS_CHIP: Record<AllocationBasis, string> = {
  sole_practitioner: "sole clinician on invoice",
  pro_rata_full_settlement: "split pro-rata across N clinicians on one invoice",
  shared_invoice_part_payment: "shared invoice, part payment — not attributed",
  no_attributable_lines: "no clinician on the invoice lines",
};

/** Whole pence of one leg credited to one clinician. */
export interface Attribution {
  practitionerId: string;
  pence: number;
}

export interface LegSplit {
  /** Non-zero credits, in the order the clinicians appear on the invoice. */
  attributions: Attribution[];
  basis: AllocationBasis;
  /**
   * Whole pence of the leg attributed to NOBODY. Always
   * `leg − Σ attributions.pence`; the report buckets it by basis.
   */
  residual: number;
}

function floorDiv(numerator: number, denominator: number): number {
  // Integer floor division that cannot be knocked off by one by float division
  // of two large integers. Denominator is always > 0 here.
  let q = Math.floor(numerator / denominator);
  if (q * denominator > numerator) q -= 1;
  else if ((q + 1) * denominator <= numerator) q += 1;
  return q;
}

/**
 * Split `total` whole pence across `weights` in proportion, in whole pence, so
 * that the parts sum EXACTLY to `total` (largest remainder).
 *
 * Sign-safe. With a negative total (a refund) `Math.floor` rounds toward −∞, so
 * the floors under-sum and the leftover units are still a non-negative count
 * below `weights.length` — the same distribution loop works unchanged.
 *
 * Returns null when the split cannot be computed honestly:
 *   - the weights sum to zero or less and there is money to split (nothing tells
 *     us how to divide it);
 *   - the intermediate products would leave exact integer range.
 * A null is a refusal, never a zeroed answer.
 */
export function apportionLargestRemainder(
  total: number,
  weights: readonly number[],
): number[] | null {
  if (weights.length === 0) return null;
  if (!Number.isSafeInteger(total)) return null;
  for (const w of weights) if (!Number.isSafeInteger(w)) return null;

  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return total === 0 ? weights.map(() => 0) : null;
  if (!Number.isSafeInteger(total * sum)) return null;

  const base: number[] = [];
  const remainder: number[] = [];
  for (const w of weights) {
    const numerator = total * w;
    if (!Number.isSafeInteger(numerator)) return null;
    const q = floorDiv(numerator, sum);
    base.push(q);
    remainder.push(numerator - q * sum);
  }

  // Σbase ≤ total and Σbase > total − weights.length, so `units` is in [0, n).
  const units = total - base.reduce((a, b) => a + b, 0);
  const order = base
    .map((_, i) => i)
    .sort((a, b) => (remainder[b] !== remainder[a] ? remainder[b] - remainder[a] : a - b));
  for (let k = 0; k < units; k += 1) base[order[k]] += 1;
  return base;
}

/** Sum the per-line shares into per-clinician credits, keeping the rest as residual. */
function groupShares(invoice: InvoiceWithItems, shares: readonly number[]): {
  attributions: Attribution[];
  residual: number;
} {
  const byPractitioner = new Map<string, number>();
  let residual = 0;
  invoice.items.forEach((item, i) => {
    const pence = shares[i];
    if (item.practitionerId === null) {
      residual += pence;
      return;
    }
    byPractitioner.set(item.practitionerId, (byPractitioner.get(item.practitionerId) ?? 0) + pence);
  });
  const attributions = [...byPractitioner.entries()]
    .map(([practitionerId, pence]) => ({ practitionerId, pence }))
    .filter((a) => a.pence !== 0);
  return { attributions, residual };
}

/**
 * Split one explanation leg across the clinicians on the invoice it settled.
 *
 * `legAmountPence` is what the payment allocated to this invoice; `invoice` is the
 * invoice as read from `GET /v1/invoices/{id}`. The returned split always
 * satisfies `Σ attributions.pence + residual === legAmountPence`, which is the
 * per-leg half of the report's no-money-vanishes identity.
 */
export function splitAllocationLeg(args: {
  legAmountPence: number;
  invoice: InvoiceWithItems;
}): LegSplit {
  const { legAmountPence: leg, invoice } = args;
  const practitioners = invoicePractitionerIds(invoice);

  if (practitioners.length === 0) {
    return { attributions: [], basis: "no_attributable_lines", residual: leg };
  }

  const weights = invoice.items.map((i) => i.totalPricePence);

  if (practitioners.length === 1) {
    const shares = apportionLargestRemainder(leg, weights);
    if (shares === null) {
      // The lines carry no apportionable value, but WHO is not in doubt: one
      // clinician is on this invoice, so the leg is theirs.
      return {
        attributions: leg === 0 ? [] : [{ practitionerId: practitioners[0], pence: leg }],
        basis: "sole_practitioner",
        residual: 0,
      };
    }
    const { attributions, residual } = groupShares(invoice, shares);
    return { attributions, basis: "sole_practitioner", residual };
  }

  // Several clinicians. Only a FULL settlement can be split without inventing an
  // allocation Dentally never recorded — see the header.
  if (leg !== invoice.amountPence) {
    return { attributions: [], basis: "shared_invoice_part_payment", residual: leg };
  }

  const shares = apportionLargestRemainder(leg, weights);
  if (shares === null) {
    // Several clinicians and no line value to apportion by: no line can attribute
    // this money. Bucketed and shown, never guessed at.
    return { attributions: [], basis: "no_attributable_lines", residual: leg };
  }
  const { attributions, residual } = groupShares(invoice, shares);
  return { attributions, basis: "pro_rata_full_settlement", residual };
}
