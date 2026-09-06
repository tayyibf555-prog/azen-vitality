// CROSS-MODULE INTEGRATION: NeverBounce pre-send email validation in the drain.
// The email mirror of lookup-validation.test.ts.
//
// With the email lookup on, the drain validates a resolved EMAIL address BEFORE
// the paid send. An invalid / disposable address must be:
//   - marked BLOCKED (like a consent block), NOT failed,
//   - never dispatched (sendMessage untouched),
//   - never counted against the recipient's daily cap (recordContacted untouched).
// A deliverable address sends as normal (control), proving the block is what stops it.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FakeRow {
  id: string;
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
  status: string;
}

const fakes = vi.hoisted(() => {
  const makeModule = () => {
    const rows: FakeRow[] = [];
    return {
      rows,
      list: vi.fn(async (...a: unknown[]) => {
        const siteIds = a[0] as string[];
        return rows
          .filter((r) => r.status === "queued" && siteIds.includes(r.siteId))
          .map(({ id, touchId, siteId, channel, toRef, body }) => ({ id, touchId, siteId, channel, toRef, body }));
      }),
      claim: vi.fn(async (...a: unknown[]) => {
        const r = rows.find((x) => x.id === (a[0] as string));
        if (!r || r.status !== "queued") return false;
        r.status = "sending";
        return true;
      }),
      recordSent: vi.fn(async (...a: unknown[]) => {
        const r = rows.find((x) => x.id === (a[0] as string));
        if (r) r.status = "sent";
      }),
      markFailed: vi.fn(async (...a: unknown[]) => {
        const r = rows.find((x) => x.id === (a[0] as string));
        if (r) r.status = "failed";
      }),
      markBlocked: vi.fn(async (...a: unknown[]) => {
        const r = rows.find((x) => x.id === (a[0] as string));
        if (r) r.status = "blocked";
      }),
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
    sendMessage: vi.fn(),
    validateMobile: vi.fn(),
    validateEmail: vi.fn(),
    recordContacted: vi.fn(),
    acquireCronLock: vi.fn(),
    releaseCronLock: vi.fn(),
  };
});

function repoMock(name: keyof typeof fakes.modules) {
  return {
    listQueuedOutbox: (...a: unknown[]) => fakes.modules[name].list(...a),
    claimOutbox: (...a: unknown[]) => fakes.modules[name].claim(...a),
    recordOutboxSent: (...a: unknown[]) => fakes.modules[name].recordSent(...a),
    markOutboxFailed: (...a: unknown[]) => fakes.modules[name].markFailed(...a),
    markOutboxBlocked: (...a: unknown[]) => fakes.modules[name].markBlocked(...a),
  };
}

vi.mock("@/lib/reactivation/repository", () => repoMock("reactivation"));
vi.mock("@/lib/recall/repository", () => repoMock("recall"));
vi.mock("@/lib/noshow/repository", () => repoMock("noshow"));
vi.mock("@/lib/coordinator/repository", () => repoMock("coordinator"));
vi.mock("@/lib/reviews/repository", () => repoMock("reviews"));
vi.mock("@/lib/outreach/repository", () => repoMock("outreach"));
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class {
    constructor(_o: unknown) {}
  },
  DentallyError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/messaging/resolve", () => ({ resolveRecipient: (...a: unknown[]) => fakes.resolveRecipient(...a) }));
vi.mock("@/lib/messaging/send", () => ({ sendMessage: (...a: unknown[]) => fakes.sendMessage(...a) }));
vi.mock("@/lib/messaging/suppression", () => ({ isSuppressed: async () => false }));
vi.mock("@/lib/messaging/lookup", () => ({ validateMobile: (...a: unknown[]) => fakes.validateMobile(...a) }));
vi.mock("@/lib/messaging/email-lookup", () => ({ validateEmail: (...a: unknown[]) => fakes.validateEmail(...a) }));
// Channel preference is exercised in its own tests; here keep it a no-op passthrough.
vi.mock("@/lib/messaging/channel-pref", () => ({
  getChannelPref: async () => null,
  resolvePreferredChannel: (requested: string) => requested,
}));
vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async () => false,
  recordContacted: (...a: unknown[]) => fakes.recordContacted(...a),
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (...a: unknown[]) => fakes.acquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => fakes.releaseCronLock(...a),
}));
vi.mock("@/lib/systems/repository", () => ({
  getDisabledSlugsForSend: async () => new Set<string>(),
  isSystemEnabledForSend: async () => true,
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-cc", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));

import { POST } from "./route";

const SITE = "site-cc";

function seedRecallEmail(): FakeRow {
  const row: FakeRow = {
    id: "recall-ob-1",
    touchId: "recall-t-1",
    siteId: SITE,
    channel: "email",
    toRef: "patient:p1",
    body: "Hello from the practice",
    status: "queued",
  };
  fakes.modules.recall.rows.push(row);
  return row;
}

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer email-lookup-test-secret" },
  });
}

beforeEach(() => {
  for (const m of Object.values(fakes.modules)) {
    m.rows.length = 0;
    m.list.mockClear();
    m.claim.mockClear();
    m.recordSent.mockClear();
    m.markFailed.mockClear();
    m.markBlocked.mockClear();
  }
  fakes.resolveRecipient.mockReset();
  fakes.resolveRecipient.mockResolvedValue("patient@example.com");
  fakes.sendMessage.mockReset();
  fakes.sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
  fakes.validateMobile.mockReset();
  // Phone validator should never be consulted on an email row; give it a safe default.
  fakes.validateMobile.mockResolvedValue({ valid: true, lineType: "mobile", source: "disabled" });
  fakes.validateEmail.mockReset();
  fakes.recordContacted.mockReset();
  fakes.recordContacted.mockResolvedValue(undefined);
  fakes.acquireCronLock.mockReset();
  fakes.acquireCronLock.mockResolvedValue(true);
  fakes.releaseCronLock.mockReset();
  fakes.releaseCronLock.mockResolvedValue(undefined);
  vi.stubEnv("CRON_SECRET", "email-lookup-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("NEVERBOUNCE_API_KEY", "secret_test");
  vi.stubEnv("EMAIL_LOOKUP_ENABLED", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drain NeverBounce pre-send email validation", () => {
  it("BLOCKS (not fails) an invalid address and never consumes the daily cap", async () => {
    fakes.validateEmail.mockResolvedValue({ valid: false, verdict: "invalid", source: "api" });
    seedRecallEmail();

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 0, blocked: 1, failed: 0 });
    // Blocked, never failed, never sent.
    expect(fakes.modules.recall.markBlocked).toHaveBeenCalledTimes(1);
    expect(fakes.modules.recall.markFailed).not.toHaveBeenCalled();
    expect(fakes.sendMessage).not.toHaveBeenCalled();
    // The email validator was consulted; the phone one was not.
    expect(fakes.validateEmail).toHaveBeenCalledTimes(1);
    expect(fakes.validateMobile).not.toHaveBeenCalled();
    // The row was never even claimed for sending.
    expect(fakes.modules.recall.claim).not.toHaveBeenCalled();
    // Crucially: the daily cap was NOT consumed for this recipient.
    expect(fakes.recordContacted).not.toHaveBeenCalled();
    expect(fakes.modules.recall.rows[0].status).toBe("blocked");
  });

  it("BLOCKS a disposable address", async () => {
    fakes.validateEmail.mockResolvedValue({ valid: false, verdict: "disposable", source: "api" });
    seedRecallEmail();

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 0, blocked: 1, failed: 0 });
    expect(fakes.sendMessage).not.toHaveBeenCalled();
    expect(fakes.modules.recall.rows[0].status).toBe("blocked");
  });

  it("control: a deliverable address sends as normal", async () => {
    fakes.validateEmail.mockResolvedValue({ valid: true, verdict: "valid", source: "api" });
    seedRecallEmail();

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 1, blocked: 0 });
    expect(fakes.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakes.recordContacted).toHaveBeenCalledTimes(1); // cap stamped on a real send
    expect(fakes.modules.recall.rows[0].status).toBe("sent");
  });

  it("fail-open verdict (API error) still sends", async () => {
    // validateEmail itself fails open, so from the drain's view this is just valid.
    fakes.validateEmail.mockResolvedValue({ valid: true, verdict: null, source: "api-error" });
    seedRecallEmail();

    const json = await (await POST(drainRequest())).json();
    expect(json).toMatchObject({ sent: 1, blocked: 0 });
    expect(fakes.sendMessage).toHaveBeenCalledTimes(1);
  });
});
