import { describe, it, expect } from "vitest";
import { POST, GET } from "./route";
import { dentallySiteId } from "@/lib/mock/clients";

// ===========================================================================
// MOCK/LIVE PARITY FOR REGISTRATION — the mock must refuse what live refuses.
//
// THE DEFECT THIS FILE EXISTS TO MAKE IMPOSSIBLE. Every path that registers a
// patient was validated only against this mock, which accepted anything and
// defaulted the rest. On 2026-07-25 the first genuine end-to-end booking against
// real Dentally returned 422 on all four of them (DENTALLY.md; memory
// dentally-createpatient-422):
//
//     date_of_birth: seems to be missing
//     title:         seems to be missing
//     payment_plan:  seems to be missing
//     gender:        must be male or female
//
// A green suite had proven nothing, because the double was more forgiving than the
// thing it doubled. So these tests are written from BOTH directions:
//
//   1. a payload live rejected must now 422 here, field by field, and
//   2. the payload the REAL booking route derives must be ACCEPTED here —
//      pinning the two halves against each other so neither can drift alone.
//
// (2) is the half that matters most. A validator that merely rejects things is
// easy and useless; what earns confidence is that the exact bytes our production
// code sends pass a gate calibrated to production's own rules.
// ===========================================================================

const SITE_UUID = dentallySiteId("site-cc");

function post(patient: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mock-dentally/v1/patients", {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: JSON.stringify({ patient }),
    }),
  );
}

/**
 * The payload src/app/api/booking/create/route.ts builds for a first-time patient.
 * Kept byte-identical to the object literal in that route's createPatient call;
 * create-route.test.ts asserts the route really produces this shape, and this file
 * asserts the mock accepts it. Together they close the loop.
 */
function routeDerivedPayload(overrides: Record<string, unknown> = {}) {
  return {
    first_name: "Alex",
    last_name: "Patient",
    title: "Mr",
    date_of_birth: "1990-03-14",
    payment_plan_id: 1,
    gender: true,
    email_address: "alex@example.com",
    mobile_phone: "+447700900123",
    site_id: SITE_UUID,
    use_sms: true,
    use_email: true,
    ...overrides,
  };
}

interface ErrorBody {
  error: { type: string; message: string; errors: Record<string, string[]> };
}

describe("mock POST /v1/patients rejects exactly what live Dentally rejected", () => {
  it("422s the under-specified payload that failed live, naming all four fields at once", async () => {
    // What the broken paths used to send: names, contact, site — and none of the
    // four fields live demanded.
    const res = await post({
      first_name: "Alex",
      last_name: "Patient",
      mobile_phone: "+447700900123",
      site_id: SITE_UUID,
    });

    expect(res.status, "live answered 422, so the mock must too").toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.type).toBe("invalid_request_error");
    // The four live field/message pairs, verbatim.
    expect(body.error.errors).toEqual({
      date_of_birth: ["seems to be missing"],
      title: ["seems to be missing"],
      payment_plan: ["seems to be missing"],
      gender: ["must be male or female"],
    });
  });

  it.each([
    ["date_of_birth", "seems to be missing"],
    ["title", "seems to be missing"],
    ["payment_plan", "seems to be missing"],
  ])("422s when only %s is missing", async (field, message) => {
    // The payload field is payment_plan_id; live reported it as payment_plan.
    const key = field === "payment_plan" ? "payment_plan_id" : field;
    const payload = routeDerivedPayload();
    delete (payload as Record<string, unknown>)[key];

    const res = await post(payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors[field]).toEqual([message]);
    // ONLY that field: a validator that fails everything would pass the test above
    // while telling a human nothing about which half broke.
    expect(Object.keys(body.error.errors)).toEqual([field]);
  });

  it("422s a STRING gender, which is what the copilot path actually sent", async () => {
    // create_patient sent gender: "Male". Live wanted a boolean and said so with
    // "must be male or female" — a message that reads like it wants that very
    // string, which is presumably how the bug survived review.
    for (const gender of ["Male", "male", "M", 1, null, undefined]) {
      const res = await post(routeDerivedPayload({ gender }));
      expect(res.status, `gender: ${JSON.stringify(gender)} must be refused`).toBe(422);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.errors.gender).toEqual(["must be male or female"]);
    }
  });

  it("422s an empty-string field, not just an absent one", async () => {
    const res = await post(routeDerivedPayload({ title: "   ", date_of_birth: "" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors.title).toEqual(["seems to be missing"]);
    expect(body.error.errors.date_of_birth).toEqual(["seems to be missing"]);
  });

  it("422s a missing name, the other half of Dentally's required set", async () => {
    // DENTALLY.md, "Creating a new patient": first name*, last name*, biological
    // sex*, date of birth* are the asterisked (required) fields.
    const res = await post(routeDerivedPayload({ first_name: undefined, last_name: "" }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.errors.first_name).toEqual(["seems to be missing"]);
    expect(body.error.errors.last_name).toEqual(["seems to be missing"]);
  });

  it("stores NOTHING when it refuses", async () => {
    const before = await patientCount();
    await post({ first_name: "Ghost", last_name: "Record", site_id: SITE_UUID });
    expect(await patientCount(), "a refused registration must not appear in the book").toBe(before);
  });
});

describe("mock POST /v1/patients accepts the payload the booking route derives", () => {
  it("201s the real route's payload and echoes the four fields back", async () => {
    const res = await post(routeDerivedPayload());

    expect(res.status, "the fixed booking route must pass a live-calibrated gate").toBe(201);
    const body = (await res.json()) as { patient: Record<string, unknown> };
    expect(body.patient.first_name).toBe("Alex");
    // Echoed from the payload, not regenerated from a fixture table that has never
    // heard of this id — a just-registered patient reads back complete.
    expect(body.patient.date_of_birth).toBe("1990-03-14");
    expect(body.patient.title).toBe("Mr");
    expect(body.patient.payment_plan_id).toBe(1);
    expect(body.patient.gender).toBe(true);
  });

  it("accepts both funding ids the booking page offers (probe: 1 = NHS, 2 = Private)", async () => {
    for (const payment_plan_id of [1, 2]) {
      const res = await post(routeDerivedPayload({ payment_plan_id }));
      expect(res.status).toBe(201);
    }
  });

  it("accepts gender false as readily as true (Mrs/Miss/Ms derive false)", async () => {
    const res = await post(routeDerivedPayload({ title: "Mrs", gender: false }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { patient: Record<string, unknown> };
    expect(body.patient.gender).toBe(false);
  });
});

describe("mock GET /v1/patients carries LIVE's gender encoding", () => {
  it("returns gender as a BOOLEAN, never the string the fixture table holds", async () => {
    // PROBE 2026-08-17 (GET /v1/patients, 800 real records): gender is a boolean on
    // 100% of them, true = male. The mock used to serve "Male"/"Female", and that
    // string is why normaliseGender never learned to read a boolean — every local
    // run looked correct while live data normalised to "no gender on file" for
    // every patient in the practice.
    const res = await GET(
      new Request(`http://localhost/api/mock-dentally/v1/patients?site_id=${SITE_UUID}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );
    const body = (await res.json()) as { patients: Array<Record<string, unknown>> };
    expect(body.patients.length).toBeGreaterThan(0);

    const withGender = body.patients.filter((p) => p.gender !== null);
    expect(withGender.length, "the fixtures must still carry some gender").toBeGreaterThan(0);
    for (const p of withGender) {
      expect(typeof p.gender, `patient ${String(p.id)} must carry live's encoding`).toBe("boolean");
    }
  });
});

async function patientCount(): Promise<number> {
  const res = await GET(
    new Request(`http://localhost/api/mock-dentally/v1/patients?site_id=${SITE_UUID}`, {
      headers: { authorization: "Bearer test-token" },
    }),
  );
  const body = (await res.json()) as { patients: unknown[] };
  return body.patients.length;
}
