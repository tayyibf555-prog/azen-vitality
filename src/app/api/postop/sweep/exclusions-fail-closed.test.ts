// ===========================================================================
// THE POST-OP CHECK-IN SWEEP, WITH THE EXCLUSION LIST UNREADABLE (W1-B/2).
//
// "Exclusions unknown means nobody may be drafted." The refusal was written in
// wave 1 and NOTHING observed it: site-fairness.test.ts hands the route
// `isExclusionsUnavailable: () => false` next to an empty
// `loadExcludedTargetKeys`, which makes the branch structurally unreachable.
//
// THIS SWEEP IS THE AWKWARD ONE, and that is exactly why it needs its own pin:
// the exclusion read sits between PASS 1 (the Dentally mirroring, which has
// already written flags by then) and PASS 2 (the drafting). So the refusal must
// stop the DRAFTING without pretending the run did nothing — this file asserts
// the shape the route actually returns, which is the bare skip, and that no
// draft was written after it.
//
// THE REAL PREDICATE AND THE REAL ERROR CLASS run here (a partial mock keeps
// them; only the read itself is replaced).
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  unavailable: false,
  otherFailure: false,
  drafts: [] as unknown[],
  sites: [{ id: "site-cc", clientId: "vitality", name: "N15 Vitality Dental", dentallyId: "d-cc" }],
}));

vi.mock("@/lib/cron", () => ({ cronUnauthorized: () => null }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: vi.fn(async () => true),
  releaseCronLock: vi.fn(async () => {}),
}));
vi.mock("@/lib/systems/repository", () => ({
  isSystemEnabled: vi.fn(async () => true),
  isSystemEnabledForSend: vi.fn(async () => true),
}));

// PARTIAL: the real ExclusionsUnavailableError and the real isExclusionsUnavailable.
vi.mock("@/lib/patient-status/repository", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/patient-status/repository")>();
  return {
    ...actual,
    loadExcludedTargetKeys: vi.fn(async () => {
      if (h.otherFailure) throw new Error("something else entirely");
      if (h.unavailable) throw new actual.ExclusionsUnavailableError(new Error("PGRST301"));
      return new Set<string>();
    }),
  };
});

// NO NETWORK. Pass 1 reads nothing: an empty appointment page is a legitimate
// tick, and this file is about pass 2's gate.
vi.mock("@/lib/dentally/read", () => ({ dentallyReadKey: () => "key" }));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    listAppointments = vi.fn(async () => ({ appointments: [] }));
    getPatient = vi.fn(async () => ({ patient: { first_name: "Sarah", last_name: "L", use_sms: true } }));
  },
  DentallyError: class extends Error {},
}));
vi.mock("@/lib/dentally/budget", () => ({
  dentallyScopeRefused: () => false,
  runWithDentallyPriority: async (_p: string, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: h.sites,
  getSite: (id: string) => h.sites.find((s) => s.id === id),
  dentallySiteId: (id: string) => h.sites.find((s) => s.id === id)?.dentallyId ?? id,
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: vi.fn(async () => false) }));
vi.mock("@/lib/postop/repository", () => ({
  upsertTargetIfNew: vi.fn(async () => null),
  listTargets: vi.fn(async () => [
    {
      id: "site-cc:appt-1",
      siteId: "site-cc",
      dentallyPatientId: "p1",
      appointmentId: "appt-1",
      patientName: "Sarah Lindqvist",
      procedureAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      flag: "extraction",
      status: "pending",
      consentSms: true,
    },
  ]),
  insertDraft: vi.fn(async (d: unknown) => {
    h.drafts.push(d);
    return { id: "t-1" };
  }),
  stopTarget: vi.fn(async () => {}),
  getTarget: vi.fn(async () => null),
  postopTargetId: (siteId: string, appointmentId: string) => `${siteId}:${appointmentId}`,
}));

import { POST } from "./route";

async function run(): Promise<Response> {
  return POST(new Request("http://localhost/api/postop/sweep", { method: "POST" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.unavailable = false;
  h.otherFailure = false;
  h.drafts = [];
});

describe("post-op sweep: an unreadable exclusion list stops the drafting pass", () => {
  it("postop-sweep-skips-the-tick-when-the-exclusion-list-refuses", async () => {
    h.unavailable = true;
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: "exclusions unavailable" });
    expect(h.drafts, "a check-in was drafted against an unknown exclusion list").toEqual([]);
  });

  it("and runs normally again as soon as the list can be read", async () => {
    h.unavailable = false;
    const body = (await (await run()).json()) as Record<string, unknown>;
    expect(body.examined, "the tick refused with a readable exclusion list").toBeDefined();
    expect(body.skipped).toBeUndefined();
  });

  it("does NOT report an unrelated failure as a tidy skip", async () => {
    h.otherFailure = true;
    await expect(run()).rejects.toThrow("something else entirely");
    expect(h.drafts).toEqual([]);
  });
});
