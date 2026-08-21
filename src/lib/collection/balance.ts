// Outstanding-balance collection agent: what counts as money a patient OWES.
//
// PURE. No I/O, no clock of its own, no environment reads. Every rule below is
// directly unit-testable and mutation-checkable, because every one of them is a
// rule about whether the practice may tell a patient they owe money.
//
// ===========================================================================
// THE DATA-HONESTY POSITION, IN FULL, BECAUSE EVERYTHING HERE DEPENDS ON IT.
//
// There are two "outstanding" figures in this platform and they mean opposite
// things:
//
//   treatment_opportunity.amount_outstanding — derived from a treatment plan's
//     `private_treatment_value`. Live Dentally publishes NO balance on a plan at
//     all (see the calibration block in src/app/api/sync/coordinator/route.ts), so
//     for an incomplete plan this is the whole cost of treatment STILL TO BE DONE.
//     It is not a bill. The treatment-plan closer refuses any wording that calls
//     it one, and this module never reads it.
//
//   invoice.amount_outstanding — the balance still owed on a raised invoice,
//     already net of partial payments. THIS is money owed, and it is the only
//     thing in Dentally that is.
//
// So the collection agent is built on invoices, and on nothing else.
//
// WHY THIS FILE IS STRICTER THAN src/lib/dentally/read.ts's OWN INVOICE READER.
//
// `invoiceOutstanding` in read.ts is deliberately PERMISSIVE: an unknown status
// still counts as owed, and when the balance field is absent it falls back to
// `gross - paid`. That is right for the Payments page, where the reader is a staff
// member and an over-inclusive debtors list is safer than an under-inclusive one.
//
// It is wrong here. The output of this module is a sentence sent to a patient
// saying they owe the practice money, and a guess is not a thing anybody may say
// to somebody about their own finances. So:
//
//   - `amount_outstanding` must be PRESENT and parse. No `gross - paid` fallback,
//     ever: an invoice whose balance Dentally did not state is an invoice whose
//     balance we do not know.
//   - the gross must also be present and parse, and the balance may not exceed it.
//     Both come off the same payload, so a balance larger than the invoice is a
//     shape we do not understand, not a very large debt.
//   - a single unreadable invoice on the account refuses the WHOLE patient. Summing
//     the readable ones would understate the balance, and understating it is just
//     as false as overstating it. (invoice-shape.ts takes the identical line for
//     the payment-allocation report, and for the same reason.)
//   - any credit balance anywhere on the account stops the conversation and calls
//     a human. The practice may owe THEM.
//
// UNITS. Money arrives from live Dentally as strings ("27.9"); parseMoneyPence
// turns both that and the mock's numbers into whole pence, so nothing downstream
// ever does floating-point arithmetic on money. What is NOT settled anywhere in
// this repo is whether live `amount_outstanding` is denominated in pounds
// (matching `amount`, which the invoice probe confirmed sums from item prices) or
// in some other unit. That is why the drafter quotes no figure at all until
// COLLECTION_QUOTE_AMOUNT is deliberately switched on after a reconciliation, and
// why the ceiling below is load-bearing rather than cosmetic: a units error shows
// up as the whole book failing `above_ceiling`, which is visible in the sweep's
// own counters.
// ===========================================================================

import { parseMoneyPence } from "@/lib/dashboard/money";

const DAY = 86_400_000;

/**
 * Invoice statuses that are NOT a live debt. Same vocabulary as the debtors scan
 * in src/lib/dentally/read.ts, deliberately: the two must agree about which rows
 * are real, or the practice-wide snapshot and this verification read would differ
 * for a reason that has nothing to do with a payment.
 */
export const NON_DEBT_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  "cancelled",
  "written_off",
  "void",
  "credited",
  "draft",
]);

/** How one raw invoice row reads to this module. */
export type InvoiceReading =
  | { kind: "debt"; id: string; pence: number; datedOn: string | null; reference: string | null }
  | { kind: "settled" }
  | { kind: "not_debt" }
  | { kind: "credit"; pence: number }
  | { kind: "unreadable"; why: InvoiceUnreadableReason };

export type InvoiceUnreadableReason =
  | "no_balance_field"
  | "unparseable_balance"
  | "no_gross"
  | "balance_exceeds_gross";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * The invoice's own date, as a bare day string, or null.
 *
 * `dated_on` FIRST. It is the field the live invoice probe recorded (see
 * src/lib/dentally/invoice-shape.ts) and it is the one the debtors scan in
 * read.ts does NOT read — that scan reads created_at ?? date ?? issued_at, which
 * is why its "Last invoice" column is blank on live rows. This module needs the
 * date to be right, because it is what stops a bill raised this morning being
 * chased this afternoon, so it reads the confirmed field first and the others as
 * fallbacks rather than inheriting the gap.
 */
export function invoiceDatedOn(raw: Record<string, unknown>): string | null {
  const candidate = str(raw.dated_on) ?? str(raw.date) ?? str(raw.created_at) ?? str(raw.issued_at);
  if (!candidate) return null;
  return Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

/**
 * The invoice reference a patient could match against their own paperwork.
 *
 * A SHAPE GATE, NOT A SANITISER, and the difference matters. Dentally's reference
 * is free text a person typed, so it is an injection surface like any other; but
 * unlike a treatment name it is a short structured token, so anything that is not
 * reference-shaped is DROPPED rather than trimmed into something that looks like
 * one. Control characters, whitespace, punctuation runs and sentences all fail the
 * shape and produce null, and a null reference simply means the message mentions
 * no reference at all.
 */
export function sanitiseInvoiceReference(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip C0 controls, DEL and the C1 block FIRST, then trim. The C1 range matters
  // for the same reason it does in the closer's own sanitiser: JS \s does not
  // include NEL (U+0085), so a C1 control jammed into a "reference" would survive
  // a whitespace-only clean and reach the prompt as an invisible separator.
  const s = raw.replace(/[\u0000-\u001f\u007f-\u009f]+/g, "").trim();
  // A reference is ONE unbroken token. Anything carrying a space, a sentence, or
  // any other shape is not a reference and is DROPPED, never repaired into one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,23}$/.test(s)) return null;
  return s;
}

/**
 * Read ONE raw invoice row strictly. See the header for why every branch refuses
 * rather than guesses.
 */
export function readInvoice(raw: Record<string, unknown>): InvoiceReading {
  const status = str(raw.status) ?? str(raw.state);
  if (status && NON_DEBT_INVOICE_STATUSES.has(status.toLowerCase())) return { kind: "not_debt" };

  const balanceRaw = raw.amount_outstanding ?? raw.outstanding;
  // NOT `== null`: a balance Dentally did not state is a balance we do not know,
  // and there is no fallback. This is the single most important line in the file.
  if (balanceRaw === undefined || balanceRaw === null) {
    return { kind: "unreadable", why: "no_balance_field" };
  }
  const pence = parseMoneyPence(balanceRaw);
  if (pence === null) return { kind: "unreadable", why: "unparseable_balance" };

  if (pence < 0) return { kind: "credit", pence: -pence };
  if (pence === 0) return { kind: "settled" };

  const grossPence = parseMoneyPence(raw.amount ?? raw.total ?? raw.gross ?? raw.value);
  if (grossPence === null) return { kind: "unreadable", why: "no_gross" };
  if (pence > grossPence) return { kind: "unreadable", why: "balance_exceeds_gross" };

  return {
    kind: "debt",
    id: String(raw.id ?? ""),
    pence,
    datedOn: invoiceDatedOn(raw),
    reference: sanitiseInvoiceReference(raw.reference ?? raw.number),
  };
}

export interface BalanceSummary {
  /** Provable debt across every readable unpaid invoice, in whole pence. */
  totalPence: number;
  debtCount: number;
  /** NEWEST date across the debt invoices, or null when none carried one. */
  newestDatedOn: string | null;
  /** The reference, only when there is exactly ONE unpaid invoice. With several,
   *  no single reference describes the balance and quoting one would mislead. */
  reference: string | null;
  /** Invoices this module could not read at all. Any at all refuses the patient. */
  unreadableCount: number;
  /** Money the practice owes the patient, in pence. Any at all calls a human. */
  creditPence: number;
}

/** Summarise a patient's whole invoice history into the four facts that decide
 *  whether anything may be said to them. */
export function summariseBalance(rows: Array<Record<string, unknown>>): BalanceSummary {
  let totalPence = 0;
  let debtCount = 0;
  let unreadableCount = 0;
  let creditPence = 0;
  let newestDatedOn: string | null = null;
  let onlyReference: string | null = null;

  for (const raw of rows) {
    const reading = readInvoice(raw);
    switch (reading.kind) {
      case "debt":
        totalPence += reading.pence;
        debtCount += 1;
        onlyReference = debtCount === 1 ? reading.reference : null;
        if (reading.datedOn && (!newestDatedOn || reading.datedOn > newestDatedOn)) {
          newestDatedOn = reading.datedOn;
        }
        break;
      case "credit":
        creditPence += reading.pence;
        break;
      case "unreadable":
        unreadableCount += 1;
        break;
      default:
        break;
    }
  }

  return {
    totalPence,
    debtCount,
    newestDatedOn,
    reference: debtCount === 1 ? onlyReference : null,
    unreadableCount,
    creditPence,
  };
}

/** What a verified balance looks like once it has earned the right to be said. */
export interface VerifiedBalance {
  pence: number;
  invoiceCount: number;
  /** Only set when the whole balance is one invoice. */
  reference: string | null;
  newestDatedOn: string;
}

export type BalanceRefusal =
  | "credit_on_account"
  | "unreadable_invoice"
  | "no_provable_debt"
  | "invoice_date_unknown"
  | "invoice_too_new"
  | "below_floor"
  | "above_ceiling"
  | "snapshot_disagrees";

export type BalanceVerdict =
  | { ok: true; balance: VerifiedBalance }
  | { ok: false; refusal: BalanceRefusal };

export interface VerifyBalanceInput {
  summary: BalanceSummary;
  /**
   * The figure the practice-wide debtors scan held for this patient, in pence, or
   * NULL when there is no second read to compare against.
   *
   * A SECOND, INDEPENDENT READ, and the reason the sweep always supplies one: that
   * scan is cached for up to a minute and is bounded by a page cap, while the
   * summary above is a fresh strict read of this patient's own invoices. If a
   * payment landed between them, if the scan aggregated the wrong rows, or if the
   * two disagree for any reason at all, the honest answer is to say nothing rather
   * than to pick whichever number we happen to prefer.
   *
   * NULL is for the approval route, which re-verifies a draft that has been sitting
   * with a human and has only ONE read to work from. Passing the summary's own total
   * back in would have made the comparison a tautology that reads like a check, so
   * the absence of a second read is stated instead of faked. The approval route's
   * real equivalent guard is a different one: the verified figure must still match
   * the amount stored on the touch.
   */
  snapshotPence: number | null;
  now: Date;
  config: {
    minInvoiceAgeDays: number;
    minBalancePence: number;
    maxBalancePence: number;
    snapshotTolerancePence: number;
  };
}

/**
 * Decide whether this patient's balance may be spoken about at all, and refuse
 * with a specific reason when it may not.
 *
 * ORDER MATTERS. The two refusals that mean "a person must look at this"
 * (`credit_on_account`, `unreadable_invoice`) are evaluated FIRST, before the ones
 * that simply mean "not today", so a patient the practice may owe money to is
 * never quietly filed under "balance too small to chase".
 */
export function verifyBalance(input: VerifyBalanceInput): BalanceVerdict {
  const { summary, snapshotPence, now, config } = input;

  // 1. The practice may owe THEM. Nothing about that is a collection matter.
  if (summary.creditPence > 0) return { ok: false, refusal: "credit_on_account" };

  // 2. One invoice we could not read means we do not know this account. Summing
  //    the rest would understate the balance, which is exactly as false as
  //    overstating it.
  if (summary.unreadableCount > 0) return { ok: false, refusal: "unreadable_invoice" };

  // 3. Nothing provably owed. The ordinary, and by far the most common, exit.
  if (summary.debtCount === 0 || summary.totalPence <= 0) {
    return { ok: false, refusal: "no_provable_debt" };
  }

  // 4. An invoice with no readable date cannot be aged, and an un-ageable invoice
  //    cannot be shown to be anything other than one raised this morning.
  if (!summary.newestDatedOn) return { ok: false, refusal: "invoice_date_unknown" };
  const raised = Date.parse(summary.newestDatedOn);
  if (!Number.isFinite(raised)) return { ok: false, refusal: "invoice_date_unknown" };
  if ((now.getTime() - raised) / DAY < config.minInvoiceAgeDays) {
    return { ok: false, refusal: "invoice_too_new" };
  }

  // 5. Too small to be worth a patient's one contact of the day.
  if (summary.totalPence < config.minBalancePence) return { ok: false, refusal: "below_floor" };

  // 6. Too large for a text message. A person rings them.
  if (summary.totalPence > config.maxBalancePence) return { ok: false, refusal: "above_ceiling" };

  // 7. The two reads must agree. Skipped, explicitly, when there is no second read.
  if (
    snapshotPence !== null &&
    Math.abs(summary.totalPence - snapshotPence) > config.snapshotTolerancePence
  ) {
    return { ok: false, refusal: "snapshot_disagrees" };
  }

  return {
    ok: true,
    balance: {
      pence: summary.totalPence,
      invoiceCount: summary.debtCount,
      reference: summary.reference,
      newestDatedOn: summary.newestDatedOn,
    },
  };
}

/** Refusals that mean a PERSON must pick this patient up, not that the agent
 *  should try again another day. Drives the escalation flag on the state row. */
const ESCALATING_REFUSALS: ReadonlySet<BalanceRefusal> = new Set<BalanceRefusal>([
  "credit_on_account",
  "unreadable_invoice",
  "above_ceiling",
]);

export function refusalNeedsAPerson(refusal: BalanceRefusal): boolean {
  return ESCALATING_REFUSALS.has(refusal);
}

/** Whole pence to pounds, for the one figure a message may carry. Rounded to two
 *  decimals so a message never prints a floating-point tail. */
export function penceToPounds(pence: number): number {
  return Math.round(pence) / 100;
}

/** Pounds (as the shared debtors scan accumulates them) to whole pence, for the
 *  snapshot comparison. The scan sums JS floats, so this rounds rather than
 *  truncates: `Math.trunc(15.0 * 100)` can be 1499 for a value that is really 15. */
export function poundsToPence(pounds: number): number {
  return Math.round(pounds * 100);
}
