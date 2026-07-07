// CROSS-MODULE INTEGRATION: STOP / suppression propagation.
//
// When a patient texts STOP the inbound webhook records a suppression via the
// REAL suppression path (addSuppression -> message_suppression). Every module's
// send path funnels through the shared drain, and the drain must then skip that
// recipient for EVERY module that owns an outbox.
//
// This test is deliberately integration-style: it does NOT mock isSuppressed.
// It records a STOP through the real addSuppression() into an in-memory
// message_suppression store, then drives the real drain route with a queued
// outbox row in EACH module source (reactivation, recall, noshow, coordinator,
// reviews) for that suppressed recipient, and asserts NONE is sent — every one
// is markBlocked. The real isSuppressed() reads the same store addSuppression()
// wrote, so we exercise the actual suppression module, not a mock of it.
//
// It also proves the drain's SOURCES list covers every module that has an
// outbox: seeding one queued row per module and asserting the drain examined a
// row for each. A module with an outbox table absent from SOURCES would never
// have its row drained here (and, per the cross-check in migrations, would be a
// real gap: its messages never drain, or drain via a weaker path).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// In-memory message_suppression store shared by the REAL addSuppression /
// isSuppressed (only mock is the supabase serviceClient underneath them).
// ---------------------------------------------------------------------------
interface SuppressionRow {
  site_id: string;
  channel: string;
  to_ref: string;
  reason: string;
}

const store = vi.hoisted(() => ({ rows: [] as SuppressionRow[] }));

// Minimal supabase query-builder fake scoped to the ONE table the suppression
// module touches (message_suppression). select().eq().eq().eq().maybeSingle()
// and upsert(..., { onConflict }) are the only chains real code exercises.
vi.mock("@/lib/supabase/server", () => {
  function from(table: string) {
    if (table !== "message_suppression") {
      throw new Error(`unexpected table in suppression test: ${table}`);
    }
    const eqs: Array<{ col: keyof SuppressionRow; val: string }> = [];
    const builder = {
      select() {
        return builder;
      },
      eq(col: keyof SuppressionRow, val: string) {
        eqs.push({ col, val });
        return builder;
      },
      async maybeSingle() {
        const found = store.rows.find((r) => eqs.every((e) => r[e.col] === e.val));
        return { data: found ? { id: `${found.site_id}:${found.channel}:${found.to_ref}` } : null, error: null };
      },
      async upsert(row: SuppressionRow, _opts: { onConflict: string }) {
        const idx = store.rows.findIndex(
          (r) => r.site_id === row.site_id && r.channel === row.channel && r.to_ref === row.to_ref,
        );
        if (idx >= 0) store.rows[idx] = row;
        else store.rows.push(row);
        return { error: null };
      },
    };
    return builder;
  }
  return { serviceClient: () => ({ from }) };
});

// ---------------------------------------------------------------------------
// In-memory per-module outboxes reproducing the repository semantics.
// ---------------------------------------------------------------------------
interface FakeRow {
  id: string;
  touchId: string;
  siteId: string;
  channel: string;
  toRef: string;
  body: string;
  status: string;
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
    const rows: Array<{
      id: string;
      touchId: string;
      siteId: string;
      channel: string;
      toRef: string;
      body: string;
      status: string;
    }> = [];
    return {
      rows,
      list: vi.fn(async (...a: unknown[]) => {
        const siteIds = a[0] as string[];
        return rows
          .filter((r) => r.status === "queued" && siteIds.includes(r.siteId))
          .map(({ id, touchId, siteId, channel, toRef, body }) => ({ id, touchId, siteId, channel, toRef, body }));
      }),
      claim: vi.fn(async (...a: unknown[]) => {
        const id = a[0] as string;
        const r = rows.find((x) => x.id === id);
        if (!r || r.status !== "queued") return false;
        r.status = "sending";
        return true;
      }),
      recordSent: vi.fn(async (...a: unknown[]) => {
        const id = a[0] as string;
        const r = rows.find((x) => x.id === id);
        if (r) r.status = "sent";
      }),
      markFailed: vi.fn(async (...a: unknown[]) => {
        const id = a[0] as string;
        const r = rows.find((x) => x.id === id);
        if (r) r.status = "failed";
      }),
      markBlocked: vi.fn(async (...a: unknown[]) => {
        const id = a[0] as string;
        const r = rows.find((x) => x.id === id);
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
    },
    resolveRecipient: vi.fn(),
    sendMessage: vi.fn(),
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
vi.mock("@/lib/dentally/client", () => ({
  DentallyClient: class DentallyClient {
    constructor(_opts: unknown) {}
  },
  DentallyError: class DentallyError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(`Dentally ${status}: ${message}`);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/messaging/resolve", () => ({
  resolveRecipient: (...a: unknown[]) => fakes.resolveRecipient(...a),
}));
// sendMessage is mocked so a leaked send is observable AND to guarantee nothing
// leaves the process. A blocked row must never reach it.
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (...a: unknown[]) => fakes.sendMessage(...a),
}));
vi.mock("@/lib/cron-lock", () => ({
  acquireCronLock: (...a: unknown[]) => fakes.acquireCronLock(...a),
  releaseCronLock: (...a: unknown[]) => fakes.releaseCronLock(...a),
}));
vi.mock("@/lib/mock/clients", () => ({
  SITES: [{ id: "site-stop", clientId: "vitality", name: "Test", timezone: "Europe/London" }],
}));

vi.mock("@/lib/messaging/frequency", () => ({
  wasContactedToday: async () => false,
  recordContacted: async () => {},
}));
// REAL suppression module (its serviceClient is the only mocked dependency).
import { addSuppression } from "@/lib/messaging/suppression";
import { POST } from "./route";

const ALL_SOURCES = ["reactivation", "recall", "noshow", "coordinator", "reviews"] as const;
type Source = (typeof ALL_SOURCES)[number];

const SITE = "site-stop";
// The suppressed recipient: the patient ref used by the queued rows, and the
// phone number resolveRecipient returns for them.
const SUPPRESSED_REF = "patient:stopper";
const SUPPRESSED_ADDRESS = "+447700900555";

function seed(module: Source, overrides: Partial<FakeRow> = {}): FakeRow {
  const mod = fakes.modules[module] as unknown as FakeModule;
  const n = mod.rows.length + 1;
  const row: FakeRow = {
    id: `${module}-ob-${n}`,
    touchId: `${module}-t-${n}`,
    siteId: SITE,
    channel: "sms",
    toRef: SUPPRESSED_REF,
    body: "Hello from the practice",
    status: "queued",
    ...overrides,
  };
  mod.rows.push(row);
  return row;
}

function drainRequest(): Request {
  return new Request("http://localhost/api/messaging/drain", {
    method: "POST",
    headers: { authorization: "Bearer stop-test-secret" },
  });
}

beforeEach(() => {
  store.rows.length = 0;
  for (const m of ALL_SOURCES) {
    const mod = fakes.modules[m] as unknown as FakeModule;
    mod.rows.length = 0;
    mod.list.mockClear();
    mod.recordSent.mockClear();
    mod.markFailed.mockClear();
    mod.markBlocked.mockClear();
  }
  fakes.resolveRecipient.mockReset();
  fakes.resolveRecipient.mockImplementation(async (...a: unknown[]) => {
    const ref = a[0] as string;
    // Every queued row here targets the suppressed patient ref, resolving to the
    // one suppressed number. (The control test overrides per-ref.)
    return ref === SUPPRESSED_REF ? SUPPRESSED_ADDRESS : "+447700900001";
  });
  fakes.sendMessage.mockReset();
  fakes.sendMessage.mockResolvedValue({ provider: "dry-run", providerMessageId: "m-1", status: "queued" });
  fakes.acquireCronLock.mockReset();
  fakes.acquireCronLock.mockResolvedValue(true);
  fakes.releaseCronLock.mockReset();
  fakes.releaseCronLock.mockResolvedValue(undefined);
  vi.stubEnv("CRON_SECRET", "stop-test-secret");
  vi.stubEnv("DENTALLY_API_KEY", "test-key");
  vi.stubEnv("MESSAGING_DRY_RUN", "true");
  vi.stubEnv("PUBLIC_BASE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("STOP suppression propagates to EVERY module's drain send path", () => {
  it("blocks a queued row in every module source for a patient who texted STOP (by ref)", async () => {
    // (1) Record the STOP via the REAL suppression path, exactly as the inbound
    // webhook does for a known patient (patient:<id>).
    await addSuppression(SITE, "sms", SUPPRESSED_REF, "stop");
    expect(store.rows).toHaveLength(1);

    // (2) One queued outbox row per module, all targeting the suppressed patient.
    for (const m of ALL_SOURCES) seed(m);

    const res = await POST(drainRequest());
    const json = await res.json();

    // No module let the row through: every source blocked, nothing sent.
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ sent: 0, blocked: ALL_SOURCES.length });
    expect(fakes.sendMessage).not.toHaveBeenCalled();

    for (const m of ALL_SOURCES) {
      const mod = fakes.modules[m] as unknown as FakeModule;
      expect(mod.markBlocked, `${m} must block the suppressed row`).toHaveBeenCalledTimes(1);
      expect(mod.recordSent, `${m} must not send the suppressed row`).not.toHaveBeenCalled();
      expect(mod.rows[0].status).toBe("blocked");
    }
  });

  it("blocks by the resolved ADDRESS too (STOP recorded while the number was unidentified)", async () => {
    // The inbound webhook records STOP by ADDRESS when the sender is not a known
    // patient. Suppress the phone number, not the ref.
    await addSuppression(SITE, "sms", SUPPRESSED_ADDRESS, "stop");

    for (const m of ALL_SOURCES) seed(m);

    const json = await (await POST(drainRequest())).json();

    expect(json).toMatchObject({ sent: 0, blocked: ALL_SOURCES.length });
    expect(fakes.sendMessage).not.toHaveBeenCalled();
    for (const m of ALL_SOURCES) {
      const mod = fakes.modules[m] as unknown as FakeModule;
      expect(mod.markBlocked, `${m} must block by resolved address`).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT suppress a different channel: a STOP on sms does not block whatsapp", async () => {
    // Suppression is per-channel. A patient who opted out of SMS may still be
    // reachable on WhatsApp; the drain must not over-block.
    await addSuppression(SITE, "sms", SUPPRESSED_REF, "stop");
    seed("recall", { channel: "whatsapp" });

    const json = await (await POST(drainRequest())).json();
    expect(json).toMatchObject({ sent: 1, blocked: 0 });
    expect(fakes.sendMessage).toHaveBeenCalledTimes(1);
    expect((fakes.modules.recall as unknown as FakeModule).rows[0].status).toBe("sent");
  });

  it("control: with NO suppression recorded every module sends", async () => {
    for (const m of ALL_SOURCES) seed(m);
    const json = await (await POST(drainRequest())).json();
    expect(json).toMatchObject({ sent: ALL_SOURCES.length, blocked: 0 });
    expect(fakes.sendMessage).toHaveBeenCalledTimes(ALL_SOURCES.length);
    for (const m of ALL_SOURCES) {
      expect((fakes.modules[m] as unknown as FakeModule).rows[0].status).toBe("sent");
    }
  });

  it("SOURCES covers every module outbox: one queued row per module is examined by the drain", async () => {
    for (const m of ALL_SOURCES) seed(m);
    const json = await (await POST(drainRequest())).json();
    // perSource has one entry per module the drain knows about, and each was
    // examined (drained >= 1). A module with an outbox absent from SOURCES would
    // never appear here — a real drain gap.
    expect(Object.keys(json.perSource).sort()).toEqual([...ALL_SOURCES].sort());
    for (const m of ALL_SOURCES) {
      expect(json.perSource[m].drained, `${m} row must be examined`).toBe(1);
      expect(fakes.modules[m as Source].list).toHaveBeenCalled();
    }
  });
});
