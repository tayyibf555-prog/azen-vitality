// ---------------------------------------------------------------------------
// The shape of ONE `GET /v1/invoices/{id}` envelope, as its own pure module.
//
// WHY THIS EXISTS. The payment-allocation report answers "which clinician earned
// this money". The only place Dentally records that is the INVOICE LINE:
// `invoice_items[].practitioner_id`. The invoice HEADER carries no practitioner,
// and the index (`GET /v1/invoices`) carries no items at all.
//
// PROVENANCE — read-only GETs against api.dentally.co, 2026-08-03, 235 invoices
// fetched from 258 payment-explanation legs:
//
//   - envelope key is `invoice` (singular), items under `invoice_items`;
//   - `GET /v1/invoice_items` is a separate practice-wide list whose envelope key
//     is `invoice_item` — SINGULAR EVEN FOR THE LIST — so both key spellings are
//     tolerated here rather than one being assumed;
//   - `include=invoice_items` on the INDEX is ignored: items exist on the detail
//     route only;
//   - every item carried `practitioner_id`: 256/256 legs, and within them every
//     line;
//   - Σ`invoice_items.total_price` == `invoice.amount` on 256/256;
//   - money arrives as STRINGS ("27.9");
//   - `nhs_amount` was null on 256/256 and `nhs_charge` 0 on 728/728 items, so
//     NEITHER IS READ HERE. An NHS/private split cannot be sourced this way and
//     no caller may claim one.
//   - 0/256 invoices carried a sundry line, so `sundry_id` is carried through
//     unread: a sundry is an untested path and callers COUNT them rather than
//     assume they behave like a treatment line.
//
// THE REFUSAL. A shape this module does not recognise returns null; it never
// degrades to `items: []`. An empty item list is indistinguishable from "this
// invoice attributes to nobody", and downstream that silently moves a clinician's
// money into a bucket — in the one report where the number becomes a person's
// wages. Same for a single unreadable line: dropping one line of four would shift
// the pro-rata denominator and MISATTRIBUTE the rest, so one bad line refuses the
// whole invoice. `?? []` may never appear in this file.
//
// An items array that is PRESENT and EMPTY is not that case: it is Dentally
// answering "no lines", and it is returned as `items: []` so the caller can bucket
// it visibly.
//
// Pure functions only: no I/O, no clock reads.
// ---------------------------------------------------------------------------

import { parseMoneyPence } from "@/lib/dashboard/money";
import { isDayKey } from "@/lib/dashboard/period";

/** One priced line on an invoice. `practitionerId` is the ONLY attribution. */
export interface InvoiceItem {
  id: string;
  practitionerId: string | null;
  /** Whole pence for the whole line (price × quantity, as Dentally sends it). */
  totalPricePence: number;
  quantity: number;
  name: string;
  treatmentPlanItemId: string | null;
  /** Non-null marks a SUNDRY line. Unobserved live; callers count, never assume. */
  sundryId: string | null;
}

/** One invoice with its lines, the only shape that can attribute money. */
export interface InvoiceWithItems {
  id: string;
  patientId: string | null;
  /** Whole pence. Measured equal to Σ items' totalPricePence on 256/256. */
  amountPence: number;
  /** Bare YYYY-MM-DD from `dated_on`, or null when unreadable. */
  datedOn: string | null;
  items: InvoiceItem[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  // Dentally ids are sometimes numeric; a number id is still a usable id.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** The two spellings of the line array, detail route first. */
const ITEM_KEYS = ["invoice_items", "invoice_item"] as const;

/**
 * Pull the line array out of an invoice object, tolerating both key spellings.
 * Returns null when NEITHER key holds an array — a shape we do not understand,
 * which must refuse rather than read as "no lines".
 */
function itemsArray(invoice: Record<string, unknown>): unknown[] | null {
  for (const key of ITEM_KEYS) {
    const value = invoice[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

/**
 * Normalise one invoice line. Returns null when the line cannot be read exactly:
 * the caller then refuses the WHOLE invoice, because a dropped line silently
 * re-weights every other line's share of a part payment.
 */
export function normaliseInvoiceItem(raw: unknown): InvoiceItem | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const id = asId(r["id"]);
  if (id === null) return null;
  const totalPricePence = parseMoneyPence(r["total_price"]);
  if (totalPricePence === null) return null;
  const rawQuantity = r["quantity"];
  return {
    id,
    practitionerId: asId(r["practitioner_id"]),
    totalPricePence,
    // Quantity is NOT money and nothing apportions by it — `total_price` is
    // already the line total. An unreadable one falls back to 1 rather than
    // refusing an otherwise perfectly readable priced line.
    quantity: typeof rawQuantity === "number" && Number.isFinite(rawQuantity) ? rawQuantity : 1,
    name: typeof r["name"] === "string" ? r["name"] : "",
    treatmentPlanItemId: asId(r["treatment_plan_item_id"]),
    sundryId: asId(r["sundry_id"]),
  };
}

/**
 * Normalise one `GET /v1/invoices/{id}` envelope, or null when the shape is not
 * the one measured on 2026-08-03. Null means "we could not read this invoice",
 * which the report renders as its own visible row and counts against the run —
 * never as an invoice that attributes to nobody.
 */
export function invoiceFromEnvelope(env: unknown): InvoiceWithItems | null {
  const outer = asRecord(env);
  if (outer === null) return null;
  const invoice = asRecord(outer["invoice"]);
  if (invoice === null) return null;

  const id = asId(invoice["id"]);
  if (id === null) return null;
  const amountPence = parseMoneyPence(invoice["amount"]);
  if (amountPence === null) return null;

  const rawItems = itemsArray(invoice);
  if (rawItems === null) return null;

  const items: InvoiceItem[] = [];
  for (const raw of rawItems) {
    const item = normaliseInvoiceItem(raw);
    if (item === null) return null;
    items.push(item);
  }

  const datedOn = invoice["dated_on"];
  return {
    id,
    patientId: asId(invoice["patient_id"]),
    amountPence,
    datedOn: isDayKey(datedOn) ? datedOn : null,
    items,
  };
}

/** Distinct non-null practitioner ids across an invoice's lines, in line order. */
export function invoicePractitionerIds(invoice: InvoiceWithItems): string[] {
  const seen: string[] = [];
  for (const item of invoice.items) {
    if (item.practitionerId === null) continue;
    if (!seen.includes(item.practitionerId)) seen.push(item.practitionerId);
  }
  return seen;
}

/** How many lines on this invoice are sundries. Counted, never assumed about. */
export function invoiceSundryLineCount(invoice: InvoiceWithItems): number {
  return invoice.items.filter((i) => i.sundryId !== null).length;
}
