import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * ONBOARDING -> SPEED-TO-LEAD, end to end.
 *
 * The hole: /api/onboarding/submit recorded a registration and contacted NOBODY.
 * The person had just asked to join the practice and no automation and no worklist
 * entry followed them.
 *
 * These tests run the REAL submit handler and the REAL SLA sweep handler against
 * one shared in-memory speed_to_lead_lead table, with the REAL speed-to-lead
 * repository in between. Nothing about the lead's shape is asserted from a literal:
 * the claim under test is that a submission produces a row the sweep's own query
 * selects and its own atomic claim wins, which is what "somebody chases it" means.
 *
 * NO SEND HAPPENS ANYWHERE HERE: contactLead is a spy. The submit path deliberately
 * does not contact at all (that is the sweep's job, behind cron auth, the kill
 * switch and the atomic claim), so this whole file is send-free by construction.
 */

// ---------------------------------------------------------------------------
// A filter-aware in-memory stand-in for PostgREST. Filter-BLIND stubs would make
// the dedupe and the sweep-selection assertions below vacuous: every query would
// return everything, so "the sweep picks it" and "the dedupe skips it" would both
// pass no matter what the route did.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Filter = (r: Row) => boolean;

const db = vi.hoisted(() => {
  const tables = new Map<string, Row[]>();
  let seq = 0;
  // Fired the instant an insert lands, so a test can seed a COMPETING row in the
  // window between the pre-insert dedup and the post-insert re-check. That window
  // is the only way the double-submit race is reachable, and it is the reason the
  // race guard exists at all.
  let onInsert: (() => void) | null = null;

  function table(name: string): Row[] {
    let t = tables.get(name);
    if (!t) {
      t = [];
      tables.set(name, t);
    }
    return t;
  }

  function builder(name: string) {
    const filters: Filter[] = [];
    let mode: "select" | "insert" | "update" = "select";
    let payload: Row = {};
    let orderBy: { col: string; asc: boolean } | null = null;
    let max: number | null = null;

    const rows = (): Row[] => {
      const t = table(name);
      if (mode === "insert") {
        const hook = onInsert;
        onInsert = null;
        hook?.();
        seq += 1;
        const now = new Date().toISOString();
        const row: Row = {
          id: `row-${seq}`,
          created_at: now,
          updated_at: now,
          stage: "new",
          first_response_at: null,
          conversation_id: null,
          dentally_patient_id: null,
          score: null,
          nurture_step: 0,
          nurture_next_at: null,
          ...payload,
        };
        t.push(row);
        return [row];
      }
      let out = t.filter((r) => filters.every((f) => f(r)));
      if (mode === "update") {
        for (const r of out) Object.assign(r, payload);
      }
      if (orderBy) {
        const { col, asc } = orderBy;
        out = [...out].sort((a, b) =>
          String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1),
        );
      }
      if (max !== null) out = out.slice(0, max);
      return out;
    };

    const b: Record<string, unknown> = {};
    b.insert = (v: Row) => {
      mode = "insert";
      payload = v;
      return b;
    };
    b.update = (v: Row) => {
      mode = "update";
      payload = v;
      return b;
    };
    b.select = () => b;
    b.eq = (col: string, v: unknown) => {
      filters.push((r) => r[col] === v);
      return b;
    };
    b.neq = (col: string, v: unknown) => {
      filters.push((r) => r[col] !== v);
      return b;
    };
    b.is = (col: string, v: unknown) => {
      filters.push((r) => r[col] === v);
      return b;
    };
    b.in = (col: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[col]));
      return b;
    };
    b.lt = (col: string, v: string) => {
      filters.push((r) => String(r[col]) < v);
      return b;
    };
    b.gte = (col: string, v: string) => {
      filters.push((r) => String(r[col]) >= v);
      return b;
    };
    b.order = (col: string, o?: { ascending?: boolean }) => {
      orderBy = { col, asc: o?.ascending !== false };
      return b;
    };
    b.limit = (n: number) => {
      max = n;
      return b;
    };
    b.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    b.maybeSingle = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(res, rej);
    return b;
  }

  return {
    leads: () => table("speed_to_lead_lead"),
    /** Run `fn` once, at the moment of the next insert. */
    raceOnNextInsert: (fn: () => void) => {
      onInsert = fn;
    },
    reset: () => {
      tables.clear();
      onInsert = null;
    },
    serviceClient: vi.fn(() => ({ from: (name: string) => builder(name) })),
  };
});

const h = vi.hoisted(() => ({
  createSubmission: vi.fn<(a: unknown) => Promise<{ id: string }>>(async () => ({ id: "sub-1" })),
  getConfig: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  getActiveFormBySlug: vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => null),
  consumeBudget: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  isSystemEnabled: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  isSystemEnabledForSend: vi.fn<(...a: unknown[]) => Promise<boolean>>(async () => true),
  contactLead: vi.fn<(lead: unknown) => Promise<void>>(async () => {}),
  nurtureSweep: vi.fn<(...a: unknown[]) => Promise<{ sent: number }>>(async () => ({ sent: 0 })),
  convertAbandonedHolds: vi.fn<(...a: unknown[]) => Promise<{ converted: number }>>(
    async () => ({ converted: 0 }),
  ),
}));

vi.mock("@/lib/supabase/server", () => ({ serviceClient: db.serviceClient }));
vi.mock("@/lib/onboarding/repository", () => ({ createSubmission: h.createSubmission }));
vi.mock("@/lib/onboarding/config-repository", () => ({ getConfig: h.getConfig }));
vi.mock("@/lib/onboarding/form-repository", () => ({ getActiveFormBySlug: h.getActiveFormBySlug }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: h.isSystemEnabled,
  isSystemEnabledForSend: h.isSystemEnabledForSend,
}));
// The sweep's own seams. contactLead is the ONLY thing that would message anybody,
// and it is a spy: this file can observe "the sweep would contact this lead" without
// a single line of message text existing.
vi.mock("@/lib/speed-to-lead/contact", () => ({ contactLead: h.contactLead }));
vi.mock("@/lib/speed-to-lead/nurture", () => ({ nurtureSweep: h.nurtureSweep }));
vi.mock("@/lib/booking/abandoned-holds", () => ({ convertAbandonedHolds: h.convertAbandonedHolds }));
vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => true,
  releaseCronLock: async () => {},
}));

import { POST } from "./route";
import { POST as SWEEP } from "@/app/api/speed-to-lead/sweep/route";
import { ONBOARDING_STEPS } from "@/lib/onboarding/steps";

let ipCounter = 0;
function req(body: unknown): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/onboarding/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `203.0.113.${ipCounter % 250}` },
    body: JSON.stringify(body),
  });
}

/** Every required field of the real default form, so the happy path validates. */
function validAnswers(over: Record<string, string> = {}): Record<string, string> {
  const a: Record<string, string> = {};
  for (const f of ONBOARDING_STEPS.flatMap((s) => s.fields)) {
    if (!f.required) continue;
    if (f.type === "email") a[f.key] = "amira@example.com";
    else if (f.type === "tel") a[f.key] = "07700 900123";
    else if (f.type === "select") a[f.key] = f.options?.[0]?.value ?? "";
    else if (f.type === "date") a[f.key] = "1990-04-12";
    else if (f.type === "yesno") a[f.key] = "yes";
    else a[f.key] = "value";
  }
  a.first_name = "Amira";
  a.last_name = "Khan";
  a.phone = "07700 900123";
  a.email = "amira@example.com";
  return { ...a, ...over };
}

const CONSENTED = { sms: true, email: true, marketing: false, data: true };

async function submit(over: Record<string, unknown> = {}): Promise<Response> {
  return POST(
    req({ clientSlug: "vitality", answers: validAnswers(), consent: CONSENTED, ...over }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  db.reset();
  h.getConfig.mockResolvedValue(null);
  h.getActiveFormBySlug.mockResolvedValue(null);
  h.consumeBudget.mockResolvedValue(true);
  h.isSystemEnabled.mockResolvedValue(true);
  h.isSystemEnabledForSend.mockResolvedValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("a registration becomes a lead the sweep will chase", () => {
  it("submit -> a lead exists, at the stage the sweep selects, attributed to a real site", async () => {
    const res = await submit();
    expect(res.status).toBe(200);

    const leads = db.leads();
    expect(leads).toHaveLength(1);
    const lead = leads[0]!;
    // Stage 'new' with no first response is EXACTLY what listUncontacted selects.
    expect(lead.stage).toBe("new");
    expect(lead.first_response_at).toBeNull();
    expect(lead.name).toBe("Amira Khan");
    expect(lead.phone).toBe("+447700900123"); // normalised, not the typed form
    expect(lead.site_id).toBe("site-cc"); // the practice's first site
  });

  it("submit -> the REAL sweep picks that lead up and would first-contact it", async () => {
    await submit();
    // The sweep passes `now - SLA` as its cut-off; a tick after the SLA has elapsed
    // sees a cut-off later than this lead's created_at. Advance the clock rather than
    // hand-rolling the predicate, so the sweep's own query decides.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const res = await SWEEP(new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" }));
    vi.useRealTimers();
    expect(res.status).toBe(200);

    expect(h.contactLead).toHaveBeenCalledTimes(1);
    const chased = h.contactLead.mock.calls[0]![0] as { id: string; name: string; source: string };
    expect(chased.id).toBe(db.leads()[0]!.id);
    expect(chased.name).toBe("Amira Khan");
    expect(chased.source).toBe("onboarding");
    // contactLead only runs on a TRUE return from claimLeadForContact, so reaching
    // it at all proves the sweep's atomic 'new' -> 'contacting' claim won. The spy
    // never advances the stage, so the sweep's own finally-block correctly releases
    // the claim and leaves the lead retryable rather than stranded at 'contacting'.
    expect(db.leads()[0]!.stage).toBe("new");
  });

  it("records the source so an onboarding registration is never mistaken for a web enquiry", async () => {
    await submit();
    expect(db.leads()[0]!.source).toBe("onboarding");
  });

  it("attributes a NAMED form to its own slug", async () => {
    h.getActiveFormBySlug.mockResolvedValue({
      id: "form-1",
      clientId: "vitality",
      siteId: "site-rv",
      slug: "implants",
      config: null,
      status: "active",
    });
    // "any" = the patient expressed no preference, so the FORM's site decides.
    await submit({ formSlug: "implants", answers: validAnswers({ site: "any" }) });
    const lead = db.leads()[0]!;
    expect(lead.source).toBe("onboarding:implants");
    // and it lands on the form's OWN site, not the practice default.
    expect(lead.site_id).toBe("site-rv");
  });

  it("honours the site the patient actually chose over the form's own", async () => {
    h.getActiveFormBySlug.mockResolvedValue({
      id: "form-1",
      clientId: "vitality",
      siteId: "site-rv",
      slug: "implants",
      config: null,
      status: "active",
    });
    await submit({ formSlug: "implants", answers: validAnswers({ site: "site-ng" }) });
    expect(db.leads()[0]!.site_id).toBe("site-ng");
  });

  it("'any' on the legacy flow falls back to the practice's first site, so the lead is workable", async () => {
    // The SUBMISSION keeps a null site (honest: they expressed no preference); the
    // LEAD needs one, because a worklist row has to belong to a site to be worked.
    await submit({ answers: validAnswers({ site: "any" }) });
    expect(db.leads()[0]!.site_id).toBe("site-cc");
    const submission = h.createSubmission.mock.calls[0]![0] as { siteId: string | null };
    expect(submission.siteId).toBeNull();
  });

  it("carries the reason they gave, so the chase is about their actual enquiry", async () => {
    await submit({ answers: validAnswers({ reason: "Chipped front tooth" }) });
    expect(db.leads()[0]!.treatment_interest).toBe("Chipped front tooth");
  });
});

describe("it creates exactly one lead per person", () => {
  it("a duplicate submit does NOT create a second lead", async () => {
    await submit();
    await submit();
    expect(db.leads()).toHaveLength(1);
  });

  it("and therefore the sweep chases them once, not twice", async () => {
    await submit();
    await submit();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await SWEEP(new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" }));
    vi.useRealTimers();
    expect(h.contactLead).toHaveBeenCalledTimes(1);
  });

  it("loses a genuine double-submit race rather than chasing them twice", async () => {
    // Two simultaneous submits can BOTH clear the pre-insert dedup. The later row
    // is retired to 'lost', so exactly one lead is ever first-contacted.
    db.raceOnNextInsert(() => {
      db.leads().push({
        id: "lead-winner",
        site_id: "site-cc",
        name: "Amira Khan",
        phone: "+447700900123",
        email: "amira@example.com",
        channel: "sms",
        source: "onboarding",
        stage: "new",
        consent: { sms: true },
        treatment_interest: null,
        score: null,
        dentally_patient_id: null,
        conversation_id: null,
        first_response_at: null,
        nurture_step: 0,
        nurture_next_at: null,
        // A second earlier, so it is STRICTLY earlier and inside the dedup window.
        created_at: new Date(Date.now() - 1000).toISOString(),
        updated_at: new Date(Date.now() - 1000).toISOString(),
      });
    });
    const res = await submit();
    expect(res.status).toBe(200);

    const leads = db.leads();
    expect(leads).toHaveLength(2);
    expect(leads.find((l) => l.id === "lead-winner")!.stage).toBe("new");
    expect(leads.find((l) => l.id !== "lead-winner")!.stage).toBe("lost");

    // And the sweep therefore chases exactly one of them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await SWEEP(new Request("http://localhost/api/speed-to-lead/sweep", { method: "POST" }));
    vi.useRealTimers();
    expect(h.contactLead).toHaveBeenCalledTimes(1);
    expect((h.contactLead.mock.calls[0]![0] as { id: string }).id).toBe("lead-winner");
  });

  it("a different person at the same practice DOES get their own lead", async () => {
    await submit();
    await submit({
      answers: validAnswers({ first_name: "Sam", last_name: "Ali", phone: "07700 900999", email: "sam@example.com" }),
    });
    expect(db.leads()).toHaveLength(2);
  });
});

describe("the gates the bridge respects", () => {
  it("speed-to-lead switched OFF: the submission is still recorded, no lead is created", async () => {
    h.isSystemEnabledForSend.mockResolvedValue(false);
    const res = await submit();
    expect(res.status).toBe(200);
    expect(h.createSubmission).toHaveBeenCalledTimes(1);
    expect(db.leads()).toHaveLength(0);
  });

  it("onboarding switched OFF: nothing is recorded and no lead is created", async () => {
    h.isSystemEnabled.mockResolvedValue(false);
    const res = await submit();
    expect(res.status).toBe(503);
    expect(h.createSubmission).not.toHaveBeenCalled();
    expect(db.leads()).toHaveLength(0);
  });

  it("CONSENT: no channel consented means no lead, so nothing can ever be sent to them", async () => {
    const res = await submit({ consent: { sms: false, email: false, marketing: false, data: true } });
    expect(res.status).toBe(200);
    expect(h.createSubmission).toHaveBeenCalledTimes(1);
    expect(db.leads()).toHaveLength(0);
  });

  it("CONSENT: the recorded lead carries the consent they actually gave", async () => {
    await submit({ consent: { sms: true, email: false, marketing: true, data: true } });
    expect(db.leads()[0]!.consent).toEqual({
      sms: true,
      email: false,
      whatsapp: false,
      marketing: true,
    });
  });

  it("an invalid submission never reaches the bridge", async () => {
    const res = await POST(req({ clientSlug: "vitality", answers: { first_name: "Amira" } }));
    expect(res.status).toBe(400);
    expect(db.leads()).toHaveLength(0);
  });
});

describe("the bridge is best-effort: it can never cost the patient their registration", () => {
  it("a lead-table failure still returns the friendly ack", async () => {
    db.serviceClient.mockImplementationOnce(() => {
      throw new Error("speed_to_lead_lead is unreachable");
    });
    const res = await submit();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    expect(h.createSubmission).toHaveBeenCalledTimes(1);
  });
});

describe("the submit path itself sends nothing", () => {
  it("no first contact is fired in-request; the sweep owns every send", async () => {
    await submit();
    expect(h.contactLead).not.toHaveBeenCalled();
  });
});
