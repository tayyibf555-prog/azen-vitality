// The per-patient record read, and the three defects this rebuild fixed in it:
//
//   1. It excluded CANCELLED and DID-NOT-ATTEND appointments, because the client
//      defaults Dentally's `cancelled` filter to false and this call never overrode
//      it. A clinical record that hides a patient's did-not-attends is worse than no
//      record at all.
//   2. It was the only per-patient read here that was a SINGLE UNPAGED 100-row call,
//      so a long-standing patient's history stopped at 100 rows with no marker.
//   3. Every one of its four reads catches to an empty array, which on a clinical
//      screen turns an outage into "this patient has none of that". The reads now
//      report whether they actually succeeded.
//
// The DentallyClient is mocked so no network is touched.
import { describe, it, expect, vi, beforeEach } from "vitest";

const PER_PAGE = 100;

interface ClientStubs {
  getPatientAppointments: (
    patientId: string,
    page?: number,
    perPage?: number,
    includeCancelled?: boolean,
  ) => Promise<unknown>;
  listTreatmentPlans: (arg: unknown) => Promise<unknown>;
  getPatientNotes: (patientId: string, page?: number, perPage?: number) => Promise<unknown>;
  getPatientInvoices: (patientId: string, page?: number, perPage?: number) => Promise<unknown>;
  getPatient: (patientId: string) => Promise<unknown>;
}

const state = vi.hoisted<ClientStubs>(() => ({
  getPatientAppointments: () => Promise.resolve({ appointments: [] }),
  listTreatmentPlans: () => Promise.resolve({ treatment_plans: [] }),
  getPatientNotes: () => Promise.resolve({ notes: [] }),
  getPatientInvoices: () => Promise.resolve({ invoices: [] }),
  getPatient: () => Promise.resolve({ patient: null }),
}));

vi.mock("./client", () => ({
  DentallyClient: class {
    constructor() {}
    getPatientAppointments(p: string, page?: number, perPage?: number, inc?: boolean) {
      return state.getPatientAppointments(p, page, perPage, inc);
    }
    listTreatmentPlans(a: unknown) { return state.listTreatmentPlans(a); }
    getPatientNotes(p: string, page?: number, perPage?: number) { return state.getPatientNotes(p, page, perPage); }
    getPatientInvoices(p: string, page?: number, perPage?: number) { return state.getPatientInvoices(p, page, perPage); }
    getPatient(p: string) { return state.getPatient(p); }
  },
}));

import { getPatientDetail, getPatientById } from "./read";

beforeEach(() => {
  vi.stubEnv("DENTALLY_API_KEY", "k");
  state.getPatientAppointments = () => Promise.resolve({ appointments: [] });
  state.listTreatmentPlans = () => Promise.resolve({ treatment_plans: [] });
  state.getPatientNotes = () => Promise.resolve({ notes: [] });
  state.getPatientInvoices = () => Promise.resolve({ invoices: [] });
  state.getPatient = () => Promise.resolve({ patient: null });
});

function appt(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `a-${i}`,
    patient_id: "p1",
    site_id: "site-cc",
    start_time: `2026-0${(i % 9) + 1}-10T09:00:00Z`,
    state: "Completed",
    ...over,
  };
}

describe("getPatientDetail: appointment history", () => {
  it("asks Dentally to INCLUDE cancelled and did-not-attend rows", async () => {
    const calls: Array<{ page?: number; perPage?: number; includeCancelled?: boolean }> = [];
    state.getPatientAppointments = (_p, page, perPage, includeCancelled) => {
      calls.push({ page, perPage, includeCancelled });
      return Promise.resolve({ appointments: [] });
    };
    await getPatientDetail("p1", "site-cc");
    expect(calls[0].includeCancelled).toBe(true);
  });

  it("PAGES the read: a patient with 150 appointments returns 150, not 100", async () => {
    state.getPatientAppointments = (_p, page) => {
      const start = ((page ?? 1) - 1) * PER_PAGE;
      const end = Math.min(start + PER_PAGE, 150);
      const rows = [];
      for (let i = start; i < end; i += 1) rows.push(appt(i));
      return Promise.resolve({ appointments: rows });
    };
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.appointments).toHaveLength(150);
  });

  it("surfaces a did-not-attend in the returned history", async () => {
    state.getPatientAppointments = () =>
      Promise.resolve({
        appointments: [appt(1, { state: "Completed" }), appt(2, { state: "Did not attend" })],
      });
    const detail = await getPatientDetail("p1", "site-cc");
    // States are canonicalised on the way in, so "Did not attend" becomes did_not_attend.
    expect(detail.appointments.map((a) => a.state)).toContain("did_not_attend");
  });
});

describe("getPatientDetail: read health", () => {
  it("reports a FAILED read rather than letting it masquerade as empty", async () => {
    state.getPatientNotes = () => Promise.reject(new Error("dentally down"));
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.notes).toBe("failed");
    expect(detail.notes).toEqual([]);
    // The distinction is the whole point: an empty array on its own says nothing
    // about whether the patient has notes.
    expect(detail.reads.appointments).toBe("ok");
  });

  it("leaves the money figures untouched when only the notes read fails", async () => {
    state.getPatientInvoices = () =>
      Promise.resolve({ invoices: [{ id: "i1", amount: 300, paid: 100 }] });
    state.getPatientNotes = () => Promise.reject(new Error("dentally down"));
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.invoices).toBe("ok");
    expect(detail.lifetimeSpend).toBe(100);
    expect(detail.outstanding).toBe(200);
    expect(detail.totalInvoiced).toBe(300);
  });

  it("reports every read as ok on a clean pass", async () => {
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads).toEqual({ appointments: "ok", plans: "ok", notes: "ok", invoices: "ok" });
  });
});

// Both of these were SINGLE UNPAGED CALLS. Dentally caps a page at ~100 rows, so a
// long-standing patient's invoice history stopped at the first page and every money
// figure on the record - Balance, Lifetime spend, Total invoiced, Total paid - was a
// reduction over the truncated array, printed in red at the top of the record as
// confident fact while the dashboard debtors panel (which pages properly) disagreed.
// The notes read had the same shape, and it is the one stream where a dropped row can
// be an allergy or a medication warning.
describe("getPatientDetail: paging", () => {
  it("pages the invoice read until a short page and totals every row", async () => {
    const page1 = Array.from({ length: PER_PAGE }, (_, i) => ({ id: `i${i}`, amount: 10, paid: 10 }));
    const page2 = [{ id: "late", amount: 300, amount_outstanding: 300 }];
    const asked: number[] = [];
    state.getPatientInvoices = (_p, page) => {
      asked.push(page ?? 0);
      return Promise.resolve({ invoices: page === 1 ? page1 : page === 2 ? page2 : [] });
    };
    const detail = await getPatientDetail("p1", "site-cc");
    expect(asked).toEqual([1, 2]);
    // The unpaid invoice on page 2 is the whole point: unpaged it was invisible and
    // the header printed "Balance £0.00".
    expect(detail.outstanding).toBe(300);
    expect(detail.invoices).toHaveLength(PER_PAGE + 1);
    expect(detail.totalInvoiced).toBe(PER_PAGE * 10 + 300);
  });

  it("pages the clinical-notes read, so an old patient's history is not cut at 100", async () => {
    const page1 = Array.from({ length: PER_PAGE }, (_, i) => ({ id: `n${i}`, body: "x" }));
    state.getPatientNotes = (_p, page) =>
      Promise.resolve({ notes: page === 1 ? page1 : page === 2 ? [{ id: "oldest", body: "latex allergy" }] : [] });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.notes).toHaveLength(PER_PAGE + 1);
    expect(detail.notes.at(-1)?.body).toBe("latex allergy");
  });
});

// THE CLINICAL-NOTES ENDPOINT. This read pointed at /v1/patient_notes, which does not
// exist on real Dentally: it 404'd on every live patient open, so the tab said "we
// could not read Dentally's clinical notes just now" on every record, permanently, in
// wording that describes a transient blip. The local mock served the invented path, so
// the whole suite was green throughout. The real resource is /v1/notes, whose envelope
// key was calibrated by a read-only GET on 2026-08-03; the ROW fields were not, because
// that endpoint reports zero notes for this practice and no live row exists to read.
// These tests pin what the record does with each of the four possible answers.
describe("getPatientDetail: clinical notes off /v1/notes", () => {
  it("maps a page of notes onto the record", async () => {
    state.getPatientNotes = () =>
      Promise.resolve({
        notes: [{ id: 77, body: "Latex allergy", author: "Dr Shah", created_at: "2026-07-30T09:15:00Z" }],
        meta: { total: 1, current_page: 1, total_pages: 1 },
      });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.notes).toBe("ok");
    expect(detail.notes).toEqual([
      { id: "77", body: "Latex allergy", author: "Dr Shah", createdAt: "2026-07-30T09:15:00Z" },
    ]);
  });

  it("says 'none' only when Dentally actually said none", async () => {
    // The live answer today: 200, zero rows. The record is entitled to state that.
    state.getPatientNotes = () => Promise.resolve({ notes: [], meta: { total: 0 } });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.notes).toBe("ok");
    expect(detail.notes).toEqual([]);
  });

  it("marks the read FAILED on the old patient_notes envelope, never renders it as none", async () => {
    // The exact regression that hid for weeks: `res.patient_notes ?? []` turned a 404
    // page into zero notes with read health still "ok". Assert the STORED health, not
    // just the empty array — the empty array is what both behaviours produce.
    state.getPatientNotes = () => Promise.resolve({ patient_notes: [{ id: "n1", body: "Latex allergy" }] });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.notes).toBe("failed");
    expect(detail.notes).toEqual([]);
    expect(detail.reads.appointments).toBe("ok");
    expect(detail.reads.invoices).toBe("ok");
  });

  it("marks the read FAILED when rows arrive under field names we cannot read", async () => {
    // Row names are the uncalibrated half. A note we cannot parse must not be rendered
    // as a blank card, and must not be counted as "this patient has no notes".
    state.getPatientNotes = () =>
      Promise.resolve({ notes: [{ id: 1, note_text: "Latex allergy", entered_by: "Dr Shah" }] });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.reads.notes).toBe("failed");
    expect(detail.notes).toEqual([]);
  });
});

// A written-off invoice normally carries amount_outstanding 0, so invoicePaid returned
// the FULL GROSS as money received: "Total paid £900" and "Lifetime spend £900" for a
// £900 course the practice never collected, while Balance correctly read £0 from the
// same row.
describe("getPatientDetail: non-debt invoice statuses", () => {
  it("counts a written-off invoice as neither owed nor paid", async () => {
    state.getPatientInvoices = () =>
      Promise.resolve({ invoices: [{ id: "w", amount: 900, amount_outstanding: 0, status: "written_off" }] });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.outstanding).toBe(0);
    expect(detail.lifetimeSpend).toBe(0);
  });

  it("reports an overpayment as a credit instead of clamping it to zero", async () => {
    state.getPatientInvoices = () =>
      Promise.resolve({ invoices: [{ id: "c", amount: 100, amount_outstanding: -120 }] });
    const detail = await getPatientDetail("p1", "site-cc");
    expect(detail.outstanding).toBe(0);
    expect(detail.credit).toBe(120);
  });
});

describe("toPatient, through getPatientById", () => {
  it("carries the title and BOTH recall dates, and leaves recallDueAt byte-identical", async () => {
    state.getPatient = () =>
      Promise.resolve({
        patient: {
          id: 42,
          title: "Mr",
          first_name: "Alex",
          last_name: "Berry",
          site_id: "site-cc",
          dentist_recall_date: "2026-10-01",
          hygienist_recall_date: "2026-09-01",
        },
      });
    const p = await getPatientById("42");
    expect(p?.title).toBe("Mr");
    expect(p?.dentistRecallAt).toBe("2026-10-01");
    expect(p?.hygienistRecallAt).toBe("2026-09-01");
    // Unchanged for every existing caller: dentist first, hygienist as the fallback.
    expect(p?.recallDueAt).toBe("2026-10-01");
  });

  it("keeps recallDueAt falling back to the hygienist date when there is no dentist one", async () => {
    state.getPatient = () =>
      Promise.resolve({
        patient: {
          id: 43,
          first_name: "Sam",
          last_name: "Reed",
          site_id: "site-cc",
          hygienist_recall_date: "2026-09-01",
        },
      });
    const p = await getPatientById("43");
    expect(p?.recallDueAt).toBe("2026-09-01");
    expect(p?.dentistRecallAt).toBeNull();
    expect(p?.title).toBeNull(); // never invented
  });
});
