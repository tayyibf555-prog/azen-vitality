import { describe, it, expect } from "vitest";
import {
  invoiceFromEnvelope,
  normaliseInvoiceItem,
  invoicePractitionerIds,
  invoiceSundryLineCount,
} from "./invoice-shape";

/** A live-shaped line: money as a STRING, ids as strings. */
function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ii-1",
    invoice_id: "inv-1",
    item_price: "30.0",
    total_price: "30.0",
    quantity: 1,
    name: "Examination",
    nhs_charge: 0,
    practitioner_id: "prac-1",
    sundry_id: null,
    treatment_plan_id: "tp-1",
    treatment_plan_item_id: "tpi-1",
    user_id: "u-1",
    created_at: "2026-07-01T09:00:00.000Z",
    updated_at: "2026-07-01T09:00:00.000Z",
    ...over,
  };
}

function envelope(over: Record<string, unknown> = {}, items: unknown[] = [item()]) {
  return {
    invoice: {
      id: "inv-1",
      patient_id: "pat-9",
      amount: "30.0",
      amount_outstanding: "0.0",
      dated_on: "2026-07-01",
      nhs_amount: null,
      paid: true,
      site_id: "site-cc",
      invoice_items: items,
      ...over,
    },
  };
}

describe("invoiceFromEnvelope", () => {
  it("reads the measured live shape: `invoice` envelope, string money, items with a practitioner", () => {
    const invoice = invoiceFromEnvelope(envelope());
    expect(invoice).not.toBeNull();
    expect(invoice?.id).toBe("inv-1");
    expect(invoice?.patientId).toBe("pat-9");
    expect(invoice?.amountPence).toBe(3000);
    expect(invoice?.datedOn).toBe("2026-07-01");
    expect(invoice?.items).toHaveLength(1);
    expect(invoice?.items[0].practitionerId).toBe("prac-1");
    expect(invoice?.items[0].totalPricePence).toBe(3000);
    expect(invoice?.items[0].treatmentPlanItemId).toBe("tpi-1");
  });

  it("accepts the singular `invoice_item` key /v1/invoice_items uses for its list", () => {
    const env = { invoice: { id: "inv-1", amount: "30.0", invoice_item: [item()] } };
    const invoice = invoiceFromEnvelope(env);
    expect(invoice?.items).toHaveLength(1);
    expect(invoice?.items[0].id).toBe("ii-1");
  });

  it("tolerates nhs_amount: null — measured null on 256/256, and never read", () => {
    const invoice = invoiceFromEnvelope(envelope({ nhs_amount: null }));
    expect(invoice?.amountPence).toBe(3000);
    expect(Object.keys(invoice ?? {})).not.toContain("nhsAmountPence");
  });

  it("keeps an EMPTY items array as an empty array — Dentally answering 'no lines'", () => {
    const invoice = invoiceFromEnvelope(envelope({}, []));
    expect(invoice).not.toBeNull();
    expect(invoice?.items).toEqual([]);
  });

  it("REFUSES an envelope with no items key rather than degrading to no attribution", () => {
    const env = { invoice: { id: "inv-1", amount: "30.0", patient_id: "pat-9" } };
    expect(invoiceFromEnvelope(env)).toBeNull();
  });

  it("REFUSES when the items key is present but is not an array", () => {
    expect(invoiceFromEnvelope(envelope({ invoice_items: { id: "ii-1" } }))).toBeNull();
  });

  it("REFUSES the WHOLE invoice when a single line is unreadable, never dropping the line", () => {
    // A dropped line would re-weight every other line's share of a part payment.
    const bad = item({ id: "ii-2", total_price: "n/a" });
    expect(invoiceFromEnvelope(envelope({}, [item(), bad]))).toBeNull();
  });

  it("refuses a missing envelope key, a non-object, and an unreadable amount", () => {
    expect(invoiceFromEnvelope({ invoices: [{ id: "inv-1" }] })).toBeNull();
    expect(invoiceFromEnvelope(null)).toBeNull();
    expect(invoiceFromEnvelope("inv-1")).toBeNull();
    expect(invoiceFromEnvelope([envelope()])).toBeNull();
    expect(invoiceFromEnvelope(envelope({ amount: "" }))).toBeNull();
    expect(invoiceFromEnvelope(envelope({ id: null }))).toBeNull();
  });

  it("reads a numeric id and a numeric amount, both of which live has been seen to send", () => {
    const invoice = invoiceFromEnvelope(envelope({ id: 4021, amount: 30 }));
    expect(invoice?.id).toBe("4021");
    expect(invoice?.amountPence).toBe(3000);
  });

  it("nulls dated_on when it is not a bare day key", () => {
    expect(invoiceFromEnvelope(envelope({ dated_on: "2026-07-01T09:00:00Z" }))?.datedOn).toBeNull();
    expect(invoiceFromEnvelope(envelope({ dated_on: null }))?.datedOn).toBeNull();
  });
});

describe("normaliseInvoiceItem", () => {
  it("carries a null practitioner through rather than inventing one", () => {
    expect(normaliseInvoiceItem(item({ practitioner_id: null }))?.practitionerId).toBeNull();
    expect(normaliseInvoiceItem(item({ practitioner_id: "  " }))?.practitionerId).toBeNull();
  });

  it("falls back to quantity 1 when quantity is unreadable, because nothing apportions by it", () => {
    expect(normaliseInvoiceItem(item({ quantity: "two" }))?.quantity).toBe(1);
    expect(normaliseInvoiceItem(item({ quantity: 3 }))?.quantity).toBe(3);
  });

  it("refuses a line with no id or no readable total_price", () => {
    expect(normaliseInvoiceItem(item({ id: null }))).toBeNull();
    expect(normaliseInvoiceItem(item({ total_price: "" }))).toBeNull();
    expect(normaliseInvoiceItem(item({ total_price: "27.999" }))).toBeNull();
    expect(normaliseInvoiceItem(null)).toBeNull();
  });

  it("reads a negative line price, which a credit line genuinely carries", () => {
    expect(normaliseInvoiceItem(item({ total_price: "-30.0" }))?.totalPricePence).toBe(-3000);
  });
});

describe("invoicePractitionerIds / invoiceSundryLineCount", () => {
  it("lists each practitioner once, in line order, ignoring unattributed lines", () => {
    const invoice = invoiceFromEnvelope(
      envelope({ amount: "90.0" }, [
        item({ id: "a", practitioner_id: "prac-2" }),
        item({ id: "b", practitioner_id: "prac-1" }),
        item({ id: "c", practitioner_id: "prac-2" }),
        item({ id: "d", practitioner_id: null }),
      ]),
    );
    expect(invoicePractitionerIds(invoice!)).toEqual(["prac-2", "prac-1"]);
  });

  it("counts sundry lines, which were 0/256 live and are therefore an untested path", () => {
    const invoice = invoiceFromEnvelope(
      envelope({}, [item({ id: "a" }), item({ id: "b", sundry_id: "sun-1" })]),
    );
    expect(invoiceSundryLineCount(invoice!)).toBe(1);
    expect(invoiceSundryLineCount(invoiceFromEnvelope(envelope())!)).toBe(0);
  });
});
