// AREA 13 (Reviews sweep): the scheduled -> drain-ready path is cron-locked,
// suppression-aware at send time, and idempotent (a second tick never re-enqueues
// a request already marked 'sent'). In-memory fakes reproduce the repository
// semantics; the real draft template runs so the enqueued body is asserted for
// compliance (no NHS/private/funding wording, no clinical claim, no incentive).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface FakeRequest {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  channel: string;
  status: string;
}
interface FakeOutbox {
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
}

const fakes = vi.hoisted(() => ({
  requests: [] as FakeRequest[],
  touches: [] as Array<{ id: string; requestId: string | null; status: string; approvedBy: string | null; body: string }>,
  outbox: [] as FakeOutbox[],
  isSuppressed: vi.fn((..._a: unknown[]) => Promise.resolve(false)),
  acquireCronLock: vi.fn((..._a: unknown[]) => Promise.resolve(true)),
  releaseCronLock: vi.fn((..._a: unknown[]) => Promise.resolve()),
  touchSeq: 0,
}));

vi.mock("@/lib/reviews/repository", () => ({
  listDue: (nowIso: string) =>
    Promise.resolve(
      fakes.requests
        .filter((r) => r.status === "scheduled")
        .map((r) => ({
          id: r.id,
          siteId: r.siteId,
          dentallyAppointmentId: `appt-${r.id}`,
          dentallyPatientId: r.dentallyPatientId,
          patientName: r.patientName,
          channel: r.channel,
          attendedAt: nowIso,
          sendAt: nowIso,
          status: r.status,
          createdAt: nowIso,
        })),
    ),
  markStatus: (id: string, status: string) => {
    const r = fakes.requests.find((x) => x.id === id);
    if (r) r.status = status;
    return Promise.resolve();
  },
  insertTouch: (input: { requestId: string | null; siteId: string; body: string }) => {
    fakes.touchSeq += 1;
    const t = { id: `t-${fakes.touchSeq}`, requestId: input.requestId, status: "draft", approvedBy: null, body: input.body };
    fakes.touches.push(t);
    return Promise.resolve({ id: t.id });
  },
  approveTouch: (touchId: string, approvedBy: string) => {
    const t = fakes.touches.find((x) => x.id === touchId);
    if (t) { t.status = "approved"; t.approvedBy = approvedBy; }
    return Promise.resolve({ id: touchId });
  },
  enqueueOutbox: (input: FakeOutbox) => {
    fakes.outbox.push(input);
    return Promise.resolve({ id: `ob-${fakes.outbox.length}` });
  },
}));
vi.mock("@/lib/messaging/suppression", () => ({
  isSuppressed: (siteId: string, channel: string, ref: string) => fakes.isSuppressed(siteId, channel, ref),
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (name: string, ttl: number) => fakes.acquireCronLock(name, ttl),
  releaseCronLock: (name: string) => fakes.releaseCronLock(name),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (_id: string) => ({ clientId: "vitality" }),
  getClient: (_id: string) => ({ name: "Vitality Dental" }),
}));

import { POST } from "./route";

function seed(overrides: Partial<FakeRequest> = {}): FakeRequest {
  const n = fakes.requests.length + 1;
  const r: FakeRequest = {
    id: `req-${n}`, siteId: "site-1", dentallyPatientId: `pat-${n}`,
    patientName: "Sam Lee", channel: "sms", status: "scheduled",
    ...overrides,
  };
  fakes.requests.push(r);
  return r;
}

function sweepRequest(): Request {
  return new Request("http://localhost/api/reviews/sweep", {
    method: "POST",
    headers: { authorization: "Bearer area13-secret" },
  });
}

beforeEach(() => {
  fakes.requests.length = 0;
  fakes.touches.length = 0;
  fakes.outbox.length = 0;
  fakes.touchSeq = 0;
  fakes.isSuppressed.mockReset();
  fakes.isSuppressed.mockResolvedValue(false);
  fakes.acquireCronLock.mockReset();
  fakes.acquireCronLock.mockResolvedValue(true);
  fakes.releaseCronLock.mockReset();
  fakes.releaseCronLock.mockResolvedValue(undefined);
  vi.stubEnv("CRON_SECRET", "area13-secret");
  vi.stubEnv("REVIEW_LINK_URL", "https://g.page/r/vitality/review");
  vi.stubEnv("REVIEW_PRACTICE_NAME", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reviews sweep", () => {
  it("rejects an unauthorized (no CRON secret) caller", async () => {
    const res = await POST(new Request("http://localhost/api/reviews/sweep", { method: "POST" }));
    expect(res.status).toBe(401);
    // Nothing was even attempted: lock never acquired.
    expect(fakes.acquireCronLock).not.toHaveBeenCalled();
  });

  it("skips (does not touch requests) when the review link is unset", async () => {
    vi.stubEnv("REVIEW_LINK_URL", "");
    seed();
    const json = await (await POST(sweepRequest())).json();
    expect(json.skipped).toBeTruthy();
    expect(fakes.acquireCronLock).not.toHaveBeenCalled();
    expect(fakes.requests[0].status).toBe("scheduled");
    expect(fakes.outbox.length).toBe(0);
  });

  it("skips the whole run when another sweep holds the cron lock (no double-enqueue)", async () => {
    seed();
    fakes.acquireCronLock.mockResolvedValue(false);
    const json = await (await POST(sweepRequest())).json();
    expect(json.skipped).toBeTruthy();
    expect(fakes.outbox.length).toBe(0);
    expect(fakes.requests[0].status).toBe("scheduled");
    // The loser must not release the winner's lease.
    expect(fakes.releaseCronLock).not.toHaveBeenCalled();
  });

  it("drafts + approves + enqueues one outbox row per due request and marks it sent", async () => {
    seed();
    const json = await (await POST(sweepRequest())).json();
    expect(json).toMatchObject({ ok: true, due: 1, sent: 1, suppressed: 0 });
    expect(fakes.requests[0].status).toBe("sent");
    expect(fakes.outbox.length).toBe(1);
    // The outbox row is enqueued (drain dispatches it), addressed by patient ref.
    expect(fakes.outbox[0].toRef).toBe("patient:pat-1");
    // The touch was auto-approved so it is drain-eligible.
    expect(fakes.touches[0].status).toBe("approved");
    expect(fakes.touches[0].approvedBy).toBe("auto");
    expect(fakes.releaseCronLock).toHaveBeenCalledWith("sweep-reviews");
  });

  it("an opted-out patient gets NOTHING: suppressed, no outbox row", async () => {
    seed({ dentallyPatientId: "opted-out" });
    fakes.isSuppressed.mockImplementation((_s: unknown, _c: unknown, ref: unknown) =>
      Promise.resolve(ref === "patient:opted-out"));
    const json = await (await POST(sweepRequest())).json();
    expect(json).toMatchObject({ due: 1, sent: 0, suppressed: 1 });
    expect(fakes.requests[0].status).toBe("suppressed");
    // The critical compliance guarantee: no message was ever enqueued.
    expect(fakes.outbox.length).toBe(0);
    expect(fakes.touches.length).toBe(0);
  });

  it("IDEMPOTENT: a second sweep re-run does not re-enqueue an already-sent request", async () => {
    seed();
    await POST(sweepRequest());
    expect(fakes.outbox.length).toBe(1);
    // Second tick: the request is now 'sent', so listDue (status='scheduled') skips it.
    const json2 = await (await POST(sweepRequest())).json();
    expect(json2).toMatchObject({ due: 0, sent: 0 });
    expect(fakes.outbox.length).toBe(1); // still exactly one, not two
  });

  it("the enqueued review body is compliant: no NHS/private/funding, no incentive, no clinical claim, no em-dash", async () => {
    seed();
    await POST(sweepRequest());
    expect(fakes.outbox.length).toBe(1);
    const body = fakes.outbox[0].body.toLowerCase();
    for (const banned of [
      "nhs", "private", "funding", "funded", "insurance",
      "discount", "voucher", "free", "reward", "prize", "£",
      // clinical claims / advice that a review request must never contain
      "diagnos", "treatment", "cure", "pain", "prescri", "medical advice",
      "—",
    ]) {
      expect(body, `body must not contain "${banned}"`).not.toContain(banned);
    }
    // Positive: it invites honest feedback and offers opt-out.
    expect(body).toContain("honest feedback");
    expect(body).toContain("stop");
  });

  it("REGRESSION GUARD: the sweep lock lease outlives maxDuration", () => {
    const code = readFileSync(join(process.cwd(), "src/app/api/reviews/sweep/route.ts"), "utf8");
    const lease = /acquireCronLock\("sweep-reviews",\s*(\d+)\)/.exec(code);
    const max = /maxDuration\s*=\s*(\d+)/.exec(code);
    expect(lease && max).toBeTruthy();
    expect(Number(lease![1])).toBeGreaterThan(Number(max![1]));
  });
});
