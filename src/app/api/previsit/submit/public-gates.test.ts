import { describe, it, expect, vi, beforeEach } from "vitest";
import { INTEREST_TREATMENTS, TRIAGE_BANK, defaultConfigFor } from "@/lib/triage/bank";
import type { TriageTarget } from "@/lib/triage/types";

// ===========================================================================
// PUBLIC GATES on the pre-visit questionnaire submit.
//
// Unauthenticated: a patient holding a link is the caller. So the only thing
// between this route and a stranger is the guard chain inside route.ts, and THE
// POINT OF THIS FILE IS THAT DELETING ANY OF THEM TURNS A NAMED TEST BELOW RED.
//
// The exposure here is unusual and worth naming, because it is not the ordinary
// one. Writing junk rows against an appointment that must already exist is the
// SMALL half. The large half is the CONTRACTUAL guard: if a caller could choose
// their own question bank, an NHS-plan patient could be asked — and could answer
// — the symptom questions the practice must not ask them. So the fork-comes-from-
// the-row rule is tested here as hard as the IDOR rule, because it IS one.
//
// Every I/O seam is mocked; the REAL route handler, the REAL projection
// (projectBank) and the REAL banks run.
// ===========================================================================

const SITE = { id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental" };

function target(over: Partial<TriageTarget> = {}): TriageTarget {
  return {
    id: "site-cc:appt-1",
    siteId: "site-cc",
    dentallyPatientId: "p-1",
    appointmentId: "appt-1",
    patientName: "Alex Berry",
    fork: "full",
    appointmentAt: "2026-09-11T12:00:00.000Z",
    dueAt: "2026-09-10T12:00:00.000Z",
    status: "sent",
    stopReason: null,
    consentSms: true,
    linkToken: "AbCdEfGhIjKlMnOpQrStUv",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    ...over,
  };
}

const h = vi.hoisted(() => {
  const state = {
    exhausted: new Set<string>(),
    systemOn: true,
    /** The target the token resolves to, or null for an unknown link. */
    target: null as unknown,
    /** null = the practice has never edited the bank (the shipped defaults). */
    savedConfig: null as unknown,
    /** Make the single-use claim report a duplicate. */
    duplicate: false,
    /** The last recordResponse input, for the accrual assertions. */
    recorded: null as null | { answers: unknown[]; interest: unknown[]; targetFork: string },
  };
  return {
    state,
    consumeBudget: vi.fn(async (key: string) => !state.exhausted.has(key)),
    getSite: vi.fn((id: string) => (id === "site-cc" ? SITE : undefined)),
    /** STRICT: fails closed. This is the one the route must consult. */
    isSystemEnabledStrict: vi.fn(async () => state.systemOn),
    /**
     * The lax reader, mocked PERMISSIVE on purpose — the decoy. If the route drops
     * to this one, the kill-switch test below goes green when it must not, so it is
     * written to fail on the swap.
     */
    isSystemEnabled: vi.fn(async () => true),
    getTargetByLinkToken: vi.fn(async () => state.target),
    getBank: vi.fn(async () => (state.savedConfig ? { config: state.savedConfig } : null)),
    recordResponse: vi.fn(
      async (input: { target: TriageTarget; answers: unknown[]; interest: unknown[] }) => {
        if (state.duplicate) return { ok: false as const, reason: "duplicate" as const };
        state.recorded = {
          answers: input.answers,
          interest: input.interest,
          targetFork: input.target.fork,
        };
        return { ok: true as const, response: { id: "resp-1" } };
      },
    ),
  };
});

vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));
vi.mock("@/lib/mock/clients", () => ({ getSite: h.getSite }));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabledStrict: h.isSystemEnabledStrict,
  isSystemEnabled: h.isSystemEnabled,
}));
vi.mock("@/lib/triage/repository", () => ({
  getTargetByLinkToken: h.getTargetByLinkToken,
  getBank: h.getBank,
  recordResponse: h.recordResponse,
}));

import { POST } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

/** A complete grid, every row answered. Declining is answering. */
function grid(answer: "yes" | "not_now" = "yes") {
  return INTEREST_TREATMENTS.map((t) => ({ treatment: t.key, answer }));
}

/** Every REQUIRED non-grid answer for a fork, so a submit is otherwise complete. */
function requiredAnswers(fork: "full" | "brief") {
  const config = defaultConfigFor(fork);
  return Object.keys(config.required)
    .filter((k) => k !== "interest-grid")
    .map((key) => {
      const q = TRIAGE_BANK.find((x) => x.key === key)!;
      return { key, value: q.type === "choice" ? (q.options?.[0].value as string) : "yes" };
    });
}

function req(body: unknown, headers: Record<string, string> = {}): Request {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Request("http://localhost/api/previsit/submit", {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.7", ...headers },
    body: text,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.state.exhausted = new Set();
  h.state.systemOn = true;
  h.state.target = target();
  h.state.savedConfig = null;
  h.state.duplicate = false;
  h.state.recorded = null;
});

function expectNothingStored(): void {
  expect(h.recordResponse).not.toHaveBeenCalled();
}

describe("the link is the identity", () => {
  it("refuses a malformed token BEFORE any database query", async () => {
    const res = await POST(req({ token: "nope", answers: [], interest: [] }));
    expect(res.status).toBe(403);
    expect(h.getTargetByLinkToken).not.toHaveBeenCalled();
    expectNothingStored();
  });

  it("refuses an unknown token", async () => {
    h.state.target = null;
    const res = await POST(req({ token: TOKEN, answers: [], interest: grid() }));
    expect(res.status).toBe(403);
    expectNothingStored();
  });

  it.each(["answered", "stopped", "pending"] as const)("refuses a %s target: a spent link opens nothing", async (status) => {
    h.state.target = target({ status });
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(403);
    expectNothingStored();
  });

  it("answers the SAME refusal for every dead-link cause, so a token cannot be probed", async () => {
    const bodies: string[] = [];
    for (const setup of [
      () => { h.state.target = null; },
      () => { h.state.target = target({ status: "answered" }); },
      () => { h.state.systemOn = false; },
      () => { h.state.target = target({ siteId: "site-unknown" }); },
    ]) {
      beforeEachState();
      setup();
      const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size, "the refusals differ, so a caller can tell them apart").toBe(1);
  });

  function beforeEachState() {
    h.state.exhausted = new Set();
    h.state.systemOn = true;
    h.state.target = target();
    h.state.duplicate = false;
  }
});

describe("the kill switch", () => {
  it("STRICT: an off system stores nothing", async () => {
    h.state.systemOn = false;
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(403);
    expectNothingStored();
    // The decoy: if the route dropped to the lax reader this would still store,
    // because isSystemEnabled is mocked permissive.
    expect(h.isSystemEnabledStrict).toHaveBeenCalled();
    expect(h.isSystemEnabled).not.toHaveBeenCalled();
  });
});

describe("the budgets", () => {
  it("has a PER-IP ceiling", async () => {
    h.state.exhausted.add("previsit-ip:203.0.113.7");
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(429);
    expectNothingStored();
  });

  it("has a PER-TOKEN ceiling, so a leaked link cannot be replayed thousands of times", async () => {
    // The one that matters: an attacker can vary their IP and cannot vary the
    // token, because the token is the only thing that addresses a row.
    h.state.exhausted.add(`previsit-token:${TOKEN}`);
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(429);
    expectNothingStored();
  });

  it("refuses an oversized body before spending a budget key", async () => {
    const res = await POST(req({ token: TOKEN, answers: [], interest: [] }, { "content-length": "99999" }));
    expect(res.status).toBe(413);
    expect(h.consumeBudget).not.toHaveBeenCalled();
  });

  it("refuses an oversized body with NO Content-Length at all", async () => {
    // Only the post-read check can catch this. Both halves of the cap are proved.
    const huge = JSON.stringify({ token: TOKEN, answers: [{ key: "x", value: "y".repeat(20000) }] });
    const res = await POST(
      new Request("http://localhost/api/previsit/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: huge,
      }),
    );
    expect(res.status).toBe(413);
    expectNothingStored();
  });
});

// ===========================================================================
// THE CONTRACTUAL GUARD. The fork comes off the TARGET, never off the body, and
// the accepted keys are exactly the projection the page rendered from.
// ===========================================================================
describe("the question bank comes from the target, never from the caller", () => {
  const SYMPTOM_KEYS = TRIAGE_BANK.filter((q) => q.kind === "symptom").map((q) => q.key);

  it("DROPS every symptom answer posted against a SHORT-bank target", async () => {
    h.state.target = target({ fork: "brief" });
    const res = await POST(
      req({
        token: TOKEN,
        answers: [
          ...requiredAnswers("brief"),
          ...SYMPTOM_KEYS.map((key) => ({ key, value: "8" })),
        ],
        interest: grid(),
      }),
    );
    expect(res.status).toBe(200);
    const stored = (h.state.recorded?.answers ?? []) as Array<{ key: string }>;
    for (const key of SYMPTOM_KEYS) {
      expect(stored.map((a) => a.key), `${key} was stored against a short-bank target`).not.toContain(key);
    }
    // ...and the logistics answers DID land, so this is a filter and not a failure.
    expect(stored.map((a) => a.key)).toContain("attending");
  });

  it("ACCEPTS the same answers against a FULL-bank target, so the fork is real", async () => {
    h.state.target = target({ fork: "full" });
    await POST(
      req({
        token: TOKEN,
        answers: [...requiredAnswers("full"), { key: "pain-now", value: "8" }],
        interest: grid(),
      }),
    );
    const stored = (h.state.recorded?.answers ?? []) as Array<{ key: string }>;
    expect(stored.map((a) => a.key)).toContain("pain-now");
  });

  it("a caller who NAMES the other bank in the body is still held to the target's", async () => {
    // THE CONTRACTUAL BREACH THIS PREVENTS, and the reason the assertion is on the
    // ANSWERS and not only on the stored fork. Asserting `targetFork` alone was
    // too weak: it is read from `input.target.fork`, so it stays "brief" even in a
    // build where the body's `fork` chose the BANK — and mutation testing found
    // exactly that hole. What matters is which questions were accepted, so that is
    // what is asserted, alongside the stored fork.
    h.state.target = target({ fork: "brief" });
    const res = await POST(
      req({
        token: TOKEN,
        fork: "full", // the caller asks to be treated as a full-bank patient
        answers: [
          ...requiredAnswers("brief"),
          { key: "pain-now", value: "9" },
          { key: "gums-bleed", value: "yes" },
          { key: "concern-words", value: "it has been agony for a week" },
        ],
        interest: grid(),
      }),
    );
    expect(res.status).toBe(200);
    const stored = (h.state.recorded?.answers ?? []) as Array<{ key: string }>;
    for (const key of ["pain-now", "gums-bleed", "concern-words"]) {
      expect(stored.map((a) => a.key), `${key} was accepted because the BODY named the other bank`).not.toContain(key);
    }
    expect(h.state.recorded?.targetFork).toBe("brief");
    // The bank was resolved for the TARGET's fork, so the lookup itself cannot have
    // been steered by the body either.
    expect(h.getBank).toHaveBeenCalledWith("vitality", "brief");
  });

  it("drops an unknown key rather than refusing the whole submission", async () => {
    // The honest cause is a stale form (the owner edited the bank between the send
    // and the submit), and refusing everything would throw away real answers.
    await POST(
      req({
        token: TOKEN,
        answers: [...requiredAnswers("full"), { key: "made-up", value: "x" }],
        interest: grid(),
      }),
    );
    const stored = (h.state.recorded?.answers ?? []) as Array<{ key: string }>;
    expect(stored.map((a) => a.key)).not.toContain("made-up");
    expect(stored.length).toBeGreaterThan(0);
  });

  it("refuses a CHOICE value the question never offered", async () => {
    // The bad value REPLACES the good one rather than following it: the parser
    // takes the first occurrence of a key and drops later duplicates, so appending
    // would have tested the dedupe rather than the validation.
    const res = await POST(
      req({
        token: TOKEN,
        answers: [
          ...requiredAnswers("full").filter((a) => a.key !== "visit-reason"),
          { key: "visit-reason", value: "<script>" },
        ],
        interest: grid(),
      }),
    );
    expect(res.status).toBe(400);
    expectNothingStored();
  });

  it("takes the FIRST answer for a key and drops later duplicates", async () => {
    // Stated as its own test because the test above depends on it. A caller who
    // posts a key twice cannot use the second copy to overwrite the first.
    await POST(
      req({
        token: TOKEN,
        answers: [...requiredAnswers("full"), { key: "visit-reason", value: "cosmetic" }],
        interest: grid(),
      }),
    );
    const stored = (h.state.recorded?.answers ?? []) as Array<{ key: string; value: string }>;
    const reason = stored.filter((a) => a.key === "visit-reason");
    expect(reason.length).toBe(1);
    expect(reason[0].value).toBe("checkup"); // the FIRST, from requiredAnswers
  });

  it("refuses a scale value outside 0-10", async () => {
    for (const bad of ["11", "-1", "3.5", "eight"]) {
      vi.clearAllMocks();
      h.state.recorded = null;
      const res = await POST(
        req({ token: TOKEN, answers: [...requiredAnswers("full"), { key: "pain-now", value: bad }], interest: grid() }),
      );
      expect(res.status, `"${bad}" was accepted`).toBe(400);
    }
  });
});

describe("required means required, on the SERVER", () => {
  it("refuses a submission missing a required answer", async () => {
    const res = await POST(req({ token: TOKEN, answers: [], interest: grid() }));
    expect(res.status).toBe(400);
    expectNothingStored();
  });
});

// ===========================================================================
// THE INTEREST GRID: required, refusable, and every row or none.
// ===========================================================================
describe("the interest grid", () => {
  it("ACCRUES a row for every yes", async () => {
    await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid("yes") }));
    const stored = (h.state.recorded?.interest ?? []) as Array<{ treatment: string; answer: string }>;
    expect(stored.length).toBe(INTEREST_TREATMENTS.length);
    expect(stored.every((r) => r.answer === "yes")).toBe(true);
    expect(stored.map((r) => r.treatment).sort()).toEqual(INTEREST_TREATMENTS.map((t) => t.key).sort());
  });

  it("ACCEPTS a grid where the patient declined everything: refusal is always available", async () => {
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid("not_now") }));
    expect(res.status).toBe(200);
    const stored = (h.state.recorded?.interest ?? []) as Array<{ answer: string }>;
    expect(stored.length).toBe(INTEREST_TREATMENTS.length);
    expect(stored.every((r) => r.answer === "not_now")).toBe(true);
  });

  it("REFUSES a partial grid: three of four would record the fourth as never asked", async () => {
    const res = await POST(
      req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid().slice(0, 3) }),
    );
    expect(res.status).toBe(400);
    expectNothingStored();
  });

  it("refuses an invented treatment or an invented answer", async () => {
    for (const bad of [
      [...grid().slice(1), { treatment: "gold-teeth", answer: "yes" }],
      [...grid().slice(1), { treatment: "whitening", answer: "maybe" }],
    ]) {
      vi.clearAllMocks();
      const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: bad }));
      expect(res.status).toBe(400);
      expect(h.recordResponse).not.toHaveBeenCalled();
    }
  });
});

describe("the link is single-use", () => {
  it("answers a duplicate submit with the SAME thank-you, not an error", async () => {
    // The patient tapped twice, or their phone retried. They have done nothing
    // wrong and the practice already has their answers; telling them "this link has
    // been used" would send them to the phone for no reason.
    h.state.duplicate = true;
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, duplicate: true });
  });

  it("never returns the stored row id to a public caller", async () => {
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("failure modes", () => {
  it("never throws to the client, and never claims success on a failed write", async () => {
    h.recordResponse.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(req({ token: TOKEN, answers: requiredAnswers("full"), interest: grid() }));
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("refuses a body that is not JSON at all", async () => {
    const res = await POST(req("not json"));
    expect(res.status).toBe(400);
    expectNothingStored();
  });
});
