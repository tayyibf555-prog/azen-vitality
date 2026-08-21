import { parseMoneyPence } from "@/lib/dashboard/money";

// ===========================================================================
// THE MOCK'S MONEY AGGREGATE — parsed with the APP'S grammar, not a copy of it.
//
// /v1/payments publishes `meta.total_amount`: the exact decimal sum of the filtered
// rows, and the single figure that lets a caller total a window in ONE request
// instead of paging 30,000 rows. Whether the takings panel agrees with Dentally to
// the penny depends on this number, so how the mock arrives at it is not a detail.
//
// WHAT THIS REPLACED. The payments route summed the rows with its own inline regex
// and its own Number(...) * 100, a second implementation of the grammar that already
// exists — exported and pure — in src/lib/dashboard/money.ts. Two failure modes, both
// silent:
//
//   1. DRIFT. The copy and the reader agree only by coincidence. Change one and the
//      mock's envelope and the app's row-by-row sum quietly stop describing the same
//      set, and the disagreement surfaces as a takings bug with no obvious cause.
//   2. IT WAS ALREADY WRONG. The copy omitted parseMoneyPence's overflow guard, so
//      an amount whose pence value is not a safe integer was COUNTED here and
//      REFUSED by the app. The mock was scoring a row the reader drops — the exact
//      inversion of what a test double is for, since the app then looks like the
//      thing that is broken.
//
// So there is one grammar now, and it is the app's. A value parseMoneyPence rejects
// contributes nothing, which is what the reader does with it too: the deliberately
// malformed fixture row ("") falls out of the aggregate exactly as it falls out of a
// row-by-row total. That preserves the agreement live actually exhibits — Σ rows ==
// meta.total_amount held on all five live windows probed on 2026-08-21.
//
// SUB-PENNY ROWS, and why this is parseMoneyPence and not parseAggregateAmountPence.
// Live payments CAN carry more than two decimals (payment 28647 on N15 is "0.0015"),
// and live's total_amount is their exact sum, tail included — which is precisely why
// parseAggregateAmountPence exists for READING that envelope. parseMoneyPence rejects
// >2dp, correctly, because rounding one payment to the penny would be inventing a
// figure. NO FIXTURE ROW CARRIES A SUB-PENNY AMOUNT: every generated amount is built
// from whole pence by penceToDentallyString, so the set is 1dp and 2dp values plus
// the single malformed "". That is a fact about the fixtures, not a hope about them,
// and payments-money-grammar.test.ts fails the moment it stops being true — at which
// point this must render the exact decimal sum the way live does rather than quietly
// drop the row. Inventing sub-penny handling that no fixture exercises would be the
// same mistake in the other direction.
// ===========================================================================

/**
 * Sum Dentally money strings in whole PENCE, using the app's own grammar.
 *
 * Never floats: a mock that answered 2724089.9999999995 would let a caller's own
 * rounding bug pass locally and fail on the practice's real takings. Values
 * parseMoneyPence cannot read exactly contribute nothing.
 */
export function sumAmountsPence(amounts: Iterable<unknown>): number {
  let pence = 0;
  for (const raw of amounts) {
    const parsed = parseMoneyPence(raw);
    if (parsed === null) continue;
    pence += parsed;
  }
  return pence;
}

/**
 * Render whole pence the way Dentally renders `meta.total_amount`: a decimal STRING
 * with the trailing zero of a round penny trimmed ("27240.9", not "27240.90").
 *
 * The division happens ONCE, at presentation, on a total that was accumulated as an
 * integer — so no intermediate float exists to lose a penny in.
 */
export function penceToDentallyAmount(pence: number): string {
  const fixed = (pence / 100).toFixed(2);
  return fixed.endsWith("0") ? fixed.slice(0, -1) : fixed;
}
