// FIXA (drain bounds): poison-pill guard on recipient resolution. A throw from
// resolveRecipient is treated as transient (row stays 'queued'), and the outbox
// tables carry no attempt count, so a permanently-throwing row would otherwise
// be retried on every tick with nothing bounding the cost when many rows fail
// (e.g. Dentally down and each lookup burning a timeout). The drain therefore
// caps resolve failures at 5 per source per run and defers the remainder to
// the next tick. Mocks mirror the area1 pipeline test; MESSAGING_DRY_RUN stays
// true and global fetch is stubbed so nothing can leave the process.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeRow {
  id: string; touchId: string; siteId: string; channel: string; toRef: string; body: string;
  status: string;
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
      recordSent: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "sent"; }),
      markFailed: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "failed"; }),
      markBlocked: vi.fn(async (id: string) => { rows.find((x) => x.id === id)!.status = "blocked"; }),
    };
  };
  return {
    modules: {
      reactivation: makeModule(),
      recall: makeModule(),
      noshow: makeModule(),
      coordinator: makeModule(),
      reviews: makeModule(),
      outreach: makeModule(),
    },
    resolveRecipient: vi.fn(),
  };
});

function repoMock(name: keyof typeof fakes.modules) {
  return {
    listQueuedOutbox: (siteIds: string[]) => fakes.modules[name].list(siteIds),
    claimOutbox: (id: string) => fakes.modules[name].claim(id),
    recordOutboxSent: (id: string) => fakes.modules[name].recordSent(id),
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
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: async () => true,
  releaseCronLock: async () => {},
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-1", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async () => false,
  recordContacted: async () => {},
}));

import { POST } from "./route";

const ALL_SOURCES = ["reactivation", "recall", "noshow", "coordinator", "reviews", "outreach"] as const;
const fetchSpy = vi.fn(async () => { throw new Error("network egress attempted in test"); });

function seed(module: (typeof ALL_SOURCES)[number]): FakeRow {
  const n = fakes.modules[module].rows.length + 1;
  const row: FakeRow = {
    id: `${module}-ob-${n}`, touchId: `${module}-t-${n}`, siteId: "site-1",
    channel: "sms", toRef: `patient:${module}-${n}`, body: "Hello from the practice",
    status: "queued",
  };
  fakes.modules[module].rows.push(row);
  return row;
}

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer fixa-test-secret" },
  });
}

beforeEach(() => {
  for (const m of ALL_SOURCES) {
    fakes.modules[m].rows.length = 0;
    fakes.modules[m].list.mockClear();
    fakes.modules[m].recordSent.mockClear();
  }
  fakes.resolveRecipient.mockReset();
  fakes.resolveRecipient.mockResolvedValue("+447700900001");
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("CRON_SECRET", "fixa-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("drain poison-pill guard: per-source resolve-failure cap", () => {
  it("stops resolving after 5 throws in a run, leaving every row queued for the next tick", async () => {
    for (let i = 0; i < 8; i += 1) seed("recall");
    fakes.resolveRecipient.mockRejectedValue(new Error("Dentally down"));

    const res = await POST(drainRequest());
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, sent: 0, failed: 0, blocked: 0 });
    // Cap enforced: not one resolve attempt per row (8), exactly 5.
    expect(fakes.resolveRecipient).toHaveBeenCalledTimes(5);
    // No row is marked failed or blocked: all stay queued and re-claimable.
    for (const row of fakes.modules.recall.rows) expect(row.status).toBe("queued");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("failures below the cap only skip the failing rows; later rows still send", async () => {
    for (let i = 0; i < 4; i += 1) seed("noshow");
    fakes.resolveRecipient
      .mockRejectedValueOnce(new Error("blip 1"))
      .mockRejectedValueOnce(new Error("blip 2"));

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 2, failed: 0, blocked: 0 });
    expect(fakes.modules.noshow.rows.map((r) => r.status)).toEqual(["queued", "queued", "sent", "sent"]);
  });

  it("the cap is per source: one broken module cannot starve the others", async () => {
    for (let i = 0; i < 6; i += 1) seed("reactivation"); // all will throw
    seed("reviews"); // healthy
    fakes.resolveRecipient.mockImplementation(async (toRef: string) => {
      if (toRef.startsWith("patient:reactivation")) throw new Error("poison");
      return "+447700900001";
    });

    const json = await (await POST(drainRequest())).json();

    expect(json.perSource.reactivation).toMatchObject({ sent: 0, failed: 0, blocked: 0 });
    expect(json.perSource.reviews).toMatchObject({ sent: 1 });
    expect(fakes.modules.reviews.rows[0].status).toBe("sent");
    for (const row of fakes.modules.reactivation.rows) expect(row.status).toBe("queued");
  });
});
