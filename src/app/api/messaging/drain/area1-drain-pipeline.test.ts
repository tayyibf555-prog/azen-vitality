// AREA 1 (outbox/drain review): end-to-end behaviour of the shared messaging
// drain with in-memory fakes for every module outbox. The REAL sendMessage +
// provider code runs (global fetch is stubbed so nothing can leave the process),
// proving the MESSAGING_DRY_RUN posture end to end.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// In-memory per-module outboxes reproducing the repository semantics:
// listQueuedOutbox returns only status='queued'; recordOutboxSent marks the
// outbox row AND its touch 'sent'; markFailed/markBlocked are terminal.
// ---------------------------------------------------------------------------
interface FakeRow {
  id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string;
  status: string; provider?: string; toAddress?: string; touchStatus: string;
}
interface FakeModule {
  rows: FakeRow[];
  list: ReturnType<typeof vi.fn>;
  recordSent: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
  markBlocked: ReturnType<typeof vi.fn>;
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
      // Real conditional claim: queued -> sending, true only if it transitioned.
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
      diary: makeModule(),
      reactivation: makeModule(),
      recall: makeModule(),
      noshow: makeModule(),
      coordinator: makeModule(),
      closer: makeModule(),
      reviews: makeModule(),
      outreach: makeModule(),
    },
    resolveRecipient: vi.fn(),
    isSuppressed: vi.fn(),
    acquireCronLock: vi.fn(),
    releaseCronLock: vi.fn(async (_name: string) => {}),
    // Owner kill switch: disabled SYSTEM SLUGS (not drain-source names). The drain
    // remaps source names to slugs, so "noshow" -> "no-show-defence" etc.
    disabledSlugs: new Set<string>(),
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

vi.mock("@/lib/calendar/repository", () => repoMock("diary"));
vi.mock("@/lib/reactivation/repository", () => repoMock("reactivation"));
vi.mock("@/lib/recall/repository", () => repoMock("recall"));
vi.mock("@/lib/noshow/repository", () => repoMock("noshow"));
vi.mock("@/lib/coordinator/repository", () => repoMock("coordinator"));
vi.mock("@/lib/closer/repository", () => repoMock("closer"));
vi.mock("@/lib/reviews/repository", () => repoMock("reviews"));
vi.mock("@/lib/outreach/repository", () => repoMock("outreach"));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient { constructor(_opts: unknown) {} },
  // Mirror the real error class so the drain's permanent-vs-transient check
  // (err instanceof DentallyError) works under the mock.
  DentallyError: class DentallyError extends Error {
    constructor(public status: number, message: string) { super(`Dentally ${status}: ${message}`); }
  },
}));
vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: (toRef: string, channel: string, client: unknown) => fakes.resolveRecipient(toRef, channel, client),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: (siteId: string, channel: string, ref: string) => fakes.isSuppressed(siteId, channel, ref),
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (name: string, ttl: number) => fakes.acquireCronLock(name, ttl),
  releaseCronLock: (name: string) => fakes.releaseCronLock(name),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));
// Owner kill switch: the drain reads the disabled set once per run.
vi.mock("@/lib/systems/repository", () => ({
  getDisabledSlugs: async () => new Set(fakes.disabledSlugs),
  getDisabledSlugsForSend: async () => new Set(fakes.disabledSlugs),
}));

// The cross-module daily frequency cap is exercised in its own test; here it must
// no-op (default: nobody contacted yet) so it never touches the DB or the network.
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async () => false,
  recordContacted: async () => {},
}));
// NOTE: "@/lib/messaging/send" is deliberately NOT mocked — the real provider
// pipeline runs, gated by MESSAGING_DRY_RUN and the stubbed global fetch.
import { POST } from "./route";

// "diary" is the reschedule notice raised when an appointment is moved.
const ALL_SOURCES = ["diary", "reactivation", "recall", "noshow", "coordinator", "closer", "reviews", "outreach"] as const;
const fetchSpy = vi.fn(async () => { throw new Error("network egress attempted in test"); });

function seed(module: (typeof ALL_SOURCES)[number], overrides: Partial<FakeRow> = {}): FakeRow {
  const n = fakes.modules[module].rows.length + 1;
  const row: FakeRow = {
    id: `${module}-ob-${n}`, touchId: `${module}-t-${n}`, siteId: "site-1",
    channel: "sms", toRef: `patient:${module}-${n}`, body: "Hello from the practice",
    status: "queued", touchStatus: "queued",
    ...overrides,
  };
  fakes.modules[module].rows.push(row);
  return row;
}

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer area1-test-secret" },
  });
}

beforeEach(() => {
  for (const m of ALL_SOURCES) {
    fakes.modules[m].rows.length = 0;
    fakes.modules[m].list.mockClear();
    fakes.modules[m].recordSent.mockClear();
    fakes.modules[m].markFailed.mockClear();
    fakes.modules[m].markBlocked.mockClear();
  }
  fakes.resolveRecipient.mockReset();
  fakes.resolveRecipient.mockImplementation(async (_ref: string, channel: string) =>
    channel === "email" ? "patient@example.test" : "+447700900001");
  fakes.isSuppressed.mockReset();
  fakes.isSuppressed.mockResolvedValue(false);
  fakes.acquireCronLock.mockReset();
  fakes.acquireCronLock.mockResolvedValue(true);
  fakes.releaseCronLock.mockClear();
  fakes.disabledSlugs.clear();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.stubEnv("CRON_SECRET", "area1-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("shared messaging drain", () => {
  it("owner kill switch: a disabled system's outbox is skipped, its rows stay queued, and enabled systems still send", async () => {
    const react = seed("reactivation");
    const rec = seed("recall");
    const ns = seed("noshow");
    // Disable recall (slug === source name) and no-show defence (drain source
    // "noshow" REMAPS to slug "no-show-defence"), leaving reactivation on.
    fakes.disabledSlugs.add("recall");
    fakes.disabledSlugs.add("no-show-defence");

    const res = await POST(drainRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Disabled sources are skipped (reported, nothing sent) and never even listed.
    expect(json.perSource.recall).toMatchObject({ skipped: "system off", sent: 0 });
    expect(json.perSource.noshow).toMatchObject({ skipped: "system off", sent: 0 });
    expect(fakes.modules.recall.list).not.toHaveBeenCalled();
    expect(fakes.modules.noshow.list).not.toHaveBeenCalled();
    expect(rec.status).toBe("queued"); // untouched, drains when switched back on
    expect(ns.status).toBe("queued");
    // The enabled system still delivers.
    expect(react.status).toBe("sent");
    expect(json.perSource.reactivation).toMatchObject({ sent: 1 });
  });

  it("drains EVERY module outbox and records sends with provider 'dry-run' (no network)", async () => {
    for (const m of ALL_SOURCES) seed(m);
    seed("recall", { channel: "email" });

    const res = await POST(drainRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, drained: 9, sent: 9, failed: 0, blocked: 0 });
    // No module outbox forgotten: the drain reports one section per source.
    expect(Object.keys(json.perSource).sort()).toEqual([...ALL_SOURCES].sort());
    for (const m of ALL_SOURCES) {
      for (const row of fakes.modules[m].rows) {
        expect(row.status).toBe("sent");
        expect(row.touchStatus).toBe("sent");
        // Dry-run guarantee: the recorded provider is 'dry-run', so data can
        // always distinguish a simulated send from a real one.
        expect(row.provider).toBe("dry-run");
      }
    }
    // Absolute guarantee: nothing attempted to leave the process.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never sends the same row twice across sequential drains (queued-only listing)", async () => {
    seed("reactivation");
    await POST(drainRequest());
    expect(fakes.modules.reactivation.recordSent).toHaveBeenCalledTimes(1);

    const res2 = await POST(drainRequest());
    const json2 = await res2.json();
    expect(json2.drained).toBe(0);
    expect(fakes.modules.reactivation.recordSent).toHaveBeenCalledTimes(1);
  });

  it("skips the entire run when another drain holds the cron lock (no double-send)", async () => {
    seed("recall");
    fakes.acquireCronLock.mockResolvedValue(false);

    const res = await POST(drainRequest());
    const json = await res.json();

    expect(json.skipped).toBeTruthy();
    expect(fakes.modules.recall.list).not.toHaveBeenCalled();
    expect(fakes.modules.recall.rows[0].status).toBe("queued");
    // The loser must not release the winner's lock either.
    expect(fakes.releaseCronLock).not.toHaveBeenCalledWith("drain");
  });

  it("releases the cron lock after a normal run", async () => {
    fakes.releaseCronLock.mockClear();
    await POST(drainRequest());
    expect(fakes.releaseCronLock).toHaveBeenCalledWith("drain");
  });

  it("a thrown provider send marks the row failed (terminal: it is not re-listed)", async () => {
    // Real Twilio path with fake credentials and a fetch that dies: the send
    // throws, nothing real is configured, and no network exists in the test.
    vi.stubEnv("MESSAGING_DRY_RUN", "false");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "ACarea1fake");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "area1-fake-token");
    vi.stubEnv("TWILIO_SMS_FROM", "+441134960000");
    const row = seed("noshow");

    const res = await POST(drainRequest());
    const json = await res.json();

    expect(json).toMatchObject({ drained: 1, sent: 0, failed: 1 });
    expect(row.status).toBe("failed");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the (stubbed) provider attempt

    // Current design: a delivery throw is terminal. The row is NOT re-claimable.
    const res2 = await POST(drainRequest());
    expect((await res2.json()).drained).toBe(0);
  });

  it("a transient recipient-resolution failure leaves the row queued and re-claimable", async () => {
    const row = seed("coordinator");
    fakes.resolveRecipient.mockRejectedValueOnce(new Error("Dentally briefly down"));

    const res1 = await POST(drainRequest());
    const json1 = await res1.json();
    expect(json1).toMatchObject({ drained: 1, sent: 0, failed: 0, blocked: 0 });
    expect(row.status).toBe("queued"); // untouched, retried next tick

    const res2 = await POST(drainRequest());
    expect((await res2.json()).sent).toBe(1);
    expect(row.status).toBe("sent");
  });

  it("no deliverable contact on file is permanent: marked failed", async () => {
    const row = seed("reviews");
    fakes.resolveRecipient.mockResolvedValue(null);

    const json = await (await POST(drainRequest())).json();
    expect(json.failed).toBe(1);
    expect(row.status).toBe("failed");
  });

  it("suppression by patient ref OR resolved address blocks the send", async () => {
    const byRef = seed("recall", { toRef: "patient:opted-out" });
    const byAddress = seed("recall", { toRef: "patient:other" });
    fakes.resolveRecipient.mockImplementation(async (ref: string) =>
      ref === byAddress.toRef ? "+447700900999" : "+447700900001");
    fakes.isSuppressed.mockImplementation(async (_site: string, _ch: string, ref: string) =>
      ref === "patient:opted-out" || ref === "+447700900999");

    const json = await (await POST(drainRequest())).json();
    expect(json).toMatchObject({ drained: 2, sent: 0, blocked: 2 });
    expect(byRef.status).toBe("blocked");
    expect(byAddress.status).toBe("blocked");
  });

  it("REGRESSION GUARD: the drain's lock lease outlives maxDuration so a slow run can never be overlapped", () => {
    const code = readFileSync(join(process.cwd(), "src/app/api/messaging/drain/route.ts"), "utf8");
    const lease = /acquireCronLock\("drain",\s*(\d+)\)/.exec(code);
    const max = /maxDuration\s*=\s*(\d+)/.exec(code);
    expect(lease && max).toBeTruthy();
    expect(Number(lease![1])).toBeGreaterThan(Number(max![1]));
  });
});
