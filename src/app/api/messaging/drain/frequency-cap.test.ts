// Cross-module daily frequency cap in the shared drain: at most one OUTREACH message
// per recipient per London day across all modules, with transactional confirmations
// (no-show) exempt from being blocked. The frequency module is replaced with an
// in-memory daily log so the drain's real cap + priority-order logic is exercised.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeRow {
  id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string;
  status: string; touchStatus: string; provider?: string; toAddress?: string;
}

const fakes = vi.hoisted(() => {
  const makeModule = () => {
    const rows: FakeRow[] = [];
    return {
      rows,
      list: vi.fn(async (siteIds: string[]) =>
        rows
          .filter((r) => r.status === "queued" && siteIds.includes(r.siteId))
          .map(({ id, touchId, siteId, channel, toRef, body }) => ({ id, touchId, siteId, channel, toRef, body })),
      ),
      claim: vi.fn(async (id: string) => {
        const r = rows.find((x) => x.id === id);
        if (!r || r.status !== "queued") return false;
        r.status = "sending";
        return true;
      }),
      recordSent: vi.fn(async (id: string, touchId: string, fields: { provider: string; providerMessageId: string; toAddress: string }) => {
        const r = rows.find((x) => x.id === id)!;
        r.status = "sent"; r.provider = fields.provider; r.toAddress = fields.toAddress;
        const t = rows.find((x) => x.touchId === touchId); if (t) t.touchStatus = "sent";
      }),
      markFailed: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "failed"; }),
      markBlocked: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "blocked"; }),
    };
  };
  return {
    makeModule,
    modules: {
      reactivation: makeModule(), recall: makeModule(), noshow: makeModule(),
      coordinator: makeModule(), reviews: makeModule(), outreach: makeModule(),
    },
    resolveRecipient: vi.fn(),
    // In-memory stand-in for message_daily_log: the drain's real cap logic runs against it.
    contacted: new Set<string>(),
    recordCalls: [] as string[],
  };
});

function repoMock(name: keyof typeof fakes.modules) {
  return {
    listQueuedOutbox: (siteIds: string[]) => fakes.modules[name].list(siteIds),
    claimOutbox: (id: string) => fakes.modules[name].claim(id),
    recordOutboxSent: (id: string, touchId: string, fields: { provider: string; providerMessageId: string; toAddress: string }) =>
      fakes.modules[name].recordSent(id, touchId, fields),
    markOutboxFailed: (id: string) => fakes.modules[name].markFailed(id),
    markOutboxBlocked: (id: string) => fakes.modules[name].markBlocked(id),
  };
}

vi.mock("@/lib/reactivation/repository", () => repoMock("reactivation"));
vi.mock("@/lib/recall/repository", () => repoMock("recall"));
vi.mock("@/lib/noshow/repository", () => repoMock("noshow"));
vi.mock("@/lib/coordinator/repository", () => repoMock("coordinator"));
vi.mock("@/lib/reviews/repository", () => repoMock("reviews"));
vi.mock("@/lib/outreach/repository", () => repoMock("outreach"));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient { constructor(_o: unknown) {} },
  DentallyError: class DentallyError extends Error { constructor(public status: number, m: string) { super(m); } },
}));
vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: (toRef: string, channel: string, client: unknown) => fakes.resolveRecipient(toRef, channel, client),
}));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
vi.mock("@/lib/cron-lock", () => ({ acquireCronLock: async () => true, releaseCronLock: async () => {} }));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));
vi.mock("@/lib/systems/repository", () => ({
  getDisabledSlugs: async () => new Set<string>(),
  getDisabledSlugsForSend: async () => new Set<string>(),
  isSystemEnabledForSend: async () => true,
}));
// The daily log, in memory: the drain calls these; the cap + priority logic is real.
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async (siteId: string, address: string, day: string) =>
    fakes.contacted.has(`${siteId}|${address}|${day}`),
  recordContacted: async (siteId: string, address: string, day: string, source: string) => {
    fakes.contacted.add(`${siteId}|${address}|${day}`);
    fakes.recordCalls.push(`${source}:${address}`);
  },
}));

import { POST } from "./route";

const ALL = ["reactivation", "recall", "noshow", "coordinator", "reviews", "outreach"] as const;
const fetchSpy = vi.fn(async () => { throw new Error("no network in test"); });

function seed(module: (typeof ALL)[number], overrides: Partial<FakeRow> = {}): FakeRow {
  const n = fakes.modules[module].rows.length + 1;
  const row: FakeRow = {
    id: `${module}-ob-${n}`, touchId: `${module}-t-${n}`, siteId: "site-1",
    channel: "sms", toRef: `patient:${module}-${n}`, body: "Hello from the practice",
    status: "queued", touchStatus: "queued", ...overrides,
  };
  fakes.modules[module].rows.push(row);
  return row;
}

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST", headers: { authorization: "Bearer cap-test-secret" },
  });
}

beforeEach(() => {
  for (const m of ALL) {
    fakes.modules[m].rows.length = 0;
    for (const fn of ["list", "claim", "recordSent", "markFailed", "markBlocked"] as const) fakes.modules[m][fn].mockClear();
  }
  fakes.contacted.clear();
  fakes.recordCalls.length = 0;
  fakes.resolveRecipient.mockReset();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("CRON_SECRET", "cap-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("cross-module daily frequency cap", () => {
  it("sends only the FIRST outreach to a recipient that day; a second module's row to the same number is blocked", async () => {
    // Two outreach rows (recall + reactivation) to the SAME resolved number.
    const rec = seed("recall");
    const react = seed("reactivation");
    fakes.resolveRecipient.mockResolvedValue("+447700900123");

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 1, blocked: 1 });
    // Recall drains before reactivation, so recall wins the day and reactivation yields.
    expect(rec.status).toBe("sent");
    expect(react.status).toBe("blocked");
    expect(fakes.recordCalls).toEqual(["recall:+447700900123"]);
  });

  it("a transactional no-show confirmation is NEVER blocked, even if outreach already went to that number today", async () => {
    // Simulate an earlier outreach send to this number today.
    fakes.contacted.add("site-1|+447700900123|" + londonToday());
    const ns = seed("noshow");
    const rec = seed("recall");
    fakes.resolveRecipient.mockResolvedValue("+447700900123");

    const json = await (await POST(drainRequest())).json();

    // The confirmation still goes out; the outreach row yields to the cap.
    expect(ns.status).toBe("sent");
    expect(rec.status).toBe("blocked");
    expect(json).toMatchObject({ sent: 1, blocked: 1 });
  });

  it("no-show drains first and claims the day, so same-day outreach to that number yields to the confirmation", async () => {
    const ns = seed("noshow");
    const rec = seed("recall");
    const react = seed("reactivation");
    fakes.resolveRecipient.mockResolvedValue("+447700900123");

    const json = await (await POST(drainRequest())).json();

    expect(ns.status).toBe("sent"); // confirmation sends first and stamps the day
    expect(rec.status).toBe("blocked");
    expect(react.status).toBe("blocked");
    expect(json).toMatchObject({ sent: 1, blocked: 2 });
  });

  it("does NOT over-block: outreach to DIFFERENT numbers all send", async () => {
    const a = seed("recall");
    const b = seed("reactivation");
    fakes.resolveRecipient.mockImplementation(async (ref: string) =>
      ref === a.toRef ? "+447700900001" : "+447700900002");

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 2, blocked: 0 });
    expect(a.status).toBe("sent");
    expect(b.status).toBe("sent");
  });
});

/** The Europe/London day key for now, matching the drain's own londonDayKey(new Date()). */
function londonToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
