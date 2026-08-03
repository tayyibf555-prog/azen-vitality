import { unauthorizedIfMissingBearer } from "@/app/api/mock-dentally/_auth";
import { findAllocationInvoice } from "@/app/api/mock-dentally/_finance-fixtures";
import { allInvoices } from "@/app/api/mock-dentally/_fixtures";
import { generatedInvoices } from "@/app/api/mock-dentally/_dashboard-fixtures";

export const dynamic = "force-dynamic";

// GET /api/mock-dentally/v1/invoices/[id]
//
// ONE invoice WITH ITS LINES — the only shape that can attribute money to a
// clinician. Mirrors real Dentally as probed read-only on 2026-08-03:
//
//   - envelope key is `invoice` (singular), lines under `invoice_items`;
//   - the INDEX route (../route.ts) returns NO lines, and ignores
//     `include=invoice_items`. That asymmetry is deliberate here: a mock that
//     served lines on the index would hide the reason the report costs one
//     request per invoice;
//   - `amount` and every line price are STRINGS;
//   - `nhs_amount` is null and every line's `nhs_charge` is 0, exactly as live —
//     so nothing downstream can accidentally claim an NHS/private split;
//   - an unknown id 404s.
//
// The hand-written and dashboard-generated invoices (which exist to give patients
// a balance, not to attribute work) are served with an EMPTY line array. That is
// Dentally answering "no lines", which the reader buckets visibly as "no clinician
// on the invoice lines" — never as an invoice it failed to read.
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const unauthorized = unauthorizedIfMissingBearer(request);
  if (unauthorized) return unauthorized;

  const { id } = await ctx.params;

  const allocation = findAllocationInvoice(id);
  if (allocation) return Response.json({ invoice: allocation });

  const indexed = [...allInvoices(), ...generatedInvoices()].find((i) => i.id === id);
  if (indexed) {
    return Response.json({
      invoice: {
        id: indexed.id,
        patient_id: indexed.patient_id,
        amount: indexed.amount.toFixed(2),
        amount_outstanding: indexed.amount_outstanding.toFixed(2),
        dated_on: indexed.date ?? null,
        nhs_amount: null,
        paid: indexed.paid,
        reference: `INV-${indexed.id.toUpperCase()}`,
        invoice_items: [],
      },
    });
  }

  return Response.json(
    { error: { type: "invalid_request_error", message: `No invoice with id '${id}'.` } },
    { status: 404 },
  );
}
