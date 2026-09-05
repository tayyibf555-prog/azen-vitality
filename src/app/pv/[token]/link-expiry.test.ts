import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// A SENT PRE-VISIT LINK STOPS WORKING WHEN THE APPOINTMENT STARTS.
//
// Ruling W3/5: "a queued pre-visit link is NEVER dispatched after its
// appointment start ... fail closed." That was implemented on the DRAIN
// (src/lib/triage/repository.ts, dropRowsPastTheirAppointment), which can only
// retire a link that has not gone out yet. The link this file is about HAS gone
// out: `sent` has no terminal transition anywhere in the module — the sweep's
// second pass lists only 'pending', stopTarget is reached from the sweep and
// from recordNonDelivery, and 0097 adds no trigger — so before this test existed
// a delivered link stayed live in a phone's message list for ever, and both
// public doors admitted it on status alone.
//
// The harm is the one the drain's own comment names: "a live token whose form
// still opened and whose answers landed dated after the appointment they were
// asked about". A form answering "are you still able to come to your
// appointment?" about a visit that happened last month is stored with
// submitted_at = now, and the record tab and the co-pilot's previsit_summary
// both read the NEWEST response — so it is presented to the clinician as the
// summary standing in front of the NEXT appointment.
//
// THIS FILE IS THE FIRST TEST OF /pv/[token] AT ALL. It drives the real page
// function; every I/O seam is mocked, and the clock is pinned with fake timers
// so nothing here can rot into a time bomb the way the submit route's
// hard-coded "2026-09-11" fixture instant can.
// ===========================================================================

vi.mock("server-only", () => ({}));

class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
  }
}

const SITE = { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", publicPhone: "020 8808 8484" };

const h = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    // The real notFound() throws, and every guard on the page depends on that: a
    // mock that returned normally would let the page carry on and render the form
    // anyway, and this file would pass while the door stood open.
    throw new NotFoundSignal();
  }),
  getTargetByLinkToken: vi.fn(),
  getBank: vi.fn(async () => null),
  isSystemEnabledStrict: vi.fn(async () => true),
  isSystemEnabled: vi.fn(async () => true),
}));

// The factory body above is only EVALUATED when the page calls notFound(), long
// after this module finished initialising, so referencing the class from inside
// a hoisted factory is safe.

vi.mock("next/navigation", () => ({ notFound: h.notFound }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => (id === SITE.id ? SITE : undefined),
  getClient: (slug: string) => (slug === "vitality" ? { id: "vitality", slug: "vitality" } : undefined),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  // The lax reader, mocked permissive on purpose: the decoy that keeps the
  // STRICT assertion in gating.test.ts honest if this page ever drops to it.
  isSystemEnabled: h.isSystemEnabled,
}));
vi.mock("@/lib/triage/repository", () => ({
  getTargetByLinkToken: h.getTargetByLinkToken,
  getBank: h.getBank,
}));
// The gate is `import "server-only"` and the link mints a signed token from an
// env key; neither is what this file is about.
vi.mock("@/lib/patient-medical/gate", () => ({ isMedicalHistoryEnabled: () => false }));
vi.mock("@/lib/patient-medical/link", () => ({ buildMedicalHistoryLink: () => null }));
vi.mock("@/components/previsit/previsit-form", () => ({ PreVisitForm: () => null }));

import PreVisitPage from "./page";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

/** A fixed "now". Every appointment instant below is stated relative to it. */
const NOW = Date.parse("2026-09-10T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;

function target(over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: "site-cc:appt-1",
    siteId: SITE.id,
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
    patientName: "Alex Berry",
    fork: "full",
    // Ahead of NOW by default, so the control case is a live link.
    appointmentAt: new Date(NOW + 27 * HOUR).toISOString(),
    dueAt: new Date(NOW - HOUR).toISOString(),
    status: "sent",
    stopReason: null,
    consentSms: true,
    linkToken: TOKEN,
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 24 * HOUR).toISOString(),
    ...over,
  };
}

async function open(over: Partial<TriageTarget> = {}): Promise<"rendered" | "dead"> {
  h.getTargetByLinkToken.mockResolvedValue(target(over));
  try {
    await PreVisitPage({ params: Promise.resolve({ token: TOKEN }) });
    return "rendered";
  } catch (err) {
    if (err instanceof NotFoundSignal) return "dead";
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getBank.mockResolvedValue(null);
  h.isSystemEnabledStrict.mockResolvedValue(true);
  h.isSystemEnabled.mockResolvedValue(true);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the link is alive while the appointment is still ahead", () => {
  it("a SENT link for tomorrow's appointment opens the form", async () => {
    // The control. Without it every assertion below would pass on a page that
    // 404s unconditionally.
    expect(await open()).toBe("rendered");
  });

  it("a QUEUED link for tomorrow's appointment opens the form", async () => {
    expect(await open({ status: "queued" })).toBe("rendered");
  });
});

describe("a link whose appointment has started opens nothing (W3/5)", () => {
  it("a SENT link is dead an hour after the visit began", async () => {
    // The live case: the link was delivered, the patient did not open it, they
    // attended, and weeks later they scroll back through their texts.
    expect(await open({ appointmentAt: new Date(NOW - HOUR).toISOString() })).toBe("dead");
  });

  it("a SENT link is dead a MONTH after the visit", async () => {
    expect(await open({ appointmentAt: new Date(NOW - 30 * 24 * HOUR).toISOString() })).toBe("dead");
  });

  it("a QUEUED link is dead too, so a drain outage cannot leave a live door", async () => {
    expect(await open({ status: "queued", appointmentAt: new Date(NOW - HOUR).toISOString() })).toBe("dead");
  });

  it("the boundary is EXCLUSIVE: at the appointment instant itself the link is already dead", async () => {
    // `now < start`, byte-for-byte the drain's comparison in
    // dropRowsPastTheirAppointment and decideSend's `past` drop. All three agree
    // about which side of the appointment we are on.
    expect(await open({ appointmentAt: new Date(NOW).toISOString() })).toBe("dead");
    // ...and one millisecond earlier it is still alive, so the bound is a bound
    // and not an unconditional refusal.
    expect(await open({ appointmentAt: new Date(NOW + 1).toISOString() })).toBe("rendered");
  });

  it("FAILS CLOSED on an appointment instant that cannot be parsed", async () => {
    // An appointment we cannot date is not an appointment we may assume is still
    // ahead of us — the direction decideSend takes for `undatable`.
    for (const bad of ["", "not a date", "2026-13-45T99:99:00Z"]) {
      expect(await open({ appointmentAt: bad }), `"${bad}" opened the form`).toBe("dead");
    }
  });

  it("refuses BEFORE reading the bank, so an expired token costs a query and tells a prober nothing", async () => {
    await open({ appointmentAt: new Date(NOW - HOUR).toISOString() });
    expect(h.getBank).not.toHaveBeenCalled();
    // The same notFound() as a malformed token, an unknown token or a spent link:
    // one refusal for every cause, so a caller holding a guessed token cannot
    // learn whether it named a real appointment.
    expect(h.notFound).toHaveBeenCalled();
  });
});

describe("the other dead-link causes still hold", () => {
  it.each(["answered", "stopped", "pending"] as const)("a %s target opens nothing", async (status) => {
    expect(await open({ status })).toBe("dead");
  });

  it("an unknown token opens nothing", async () => {
    h.getTargetByLinkToken.mockResolvedValue(null);
    let outcome = "rendered";
    try {
      await PreVisitPage({ params: Promise.resolve({ token: TOKEN }) });
    } catch (err) {
      if (err instanceof NotFoundSignal) outcome = "dead";
      else throw err;
    }
    expect(outcome).toBe("dead");
  });

  it("a malformed token never reaches the database", async () => {
    let outcome = "rendered";
    try {
      await PreVisitPage({ params: Promise.resolve({ token: "nope" }) });
    } catch (err) {
      if (err instanceof NotFoundSignal) outcome = "dead";
      else throw err;
    }
    expect(outcome).toBe("dead");
    expect(h.getTargetByLinkToken).not.toHaveBeenCalled();
  });

  it("a switched-off system closes the form, STRICTLY", async () => {
    h.isSystemEnabledStrict.mockResolvedValue(false);
    expect(await open()).toBe("dead");
    expect(h.isSystemEnabledStrict).toHaveBeenCalled();
    // The decoy: if the page dropped to the lax reader this would still render,
    // because isSystemEnabled is mocked permissive.
    expect(h.isSystemEnabled).not.toHaveBeenCalled();
  });
});
