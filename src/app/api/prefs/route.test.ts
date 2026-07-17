import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Public /api/prefs endpoint. Proves:
//   - a channel choice is STORED (setChannelPref),
//   - "stop" routes through the EXISTING suppression machinery (addSuppression),
//     recorded across the practice's sites on both phone channels,
//   - a forged/invalid token is rejected with no writes,
//   - it is api_budget-guarded.
// pref-token is used for real (a real signed token is minted with a stubbed key);
// only the side-effecting dependencies are mocked.

const setChannelPref = vi.fn();
const addSuppression = vi.fn();
const consumeBudget = vi.fn();

vi.mock("@/lib/messaging/channel-pref", () => ({
  setChannelPref: (...a: unknown[]) => setChannelPref(...a),
}));
vi.mock("@/lib/messaging/suppression", () => ({
  addSuppression: (...a: unknown[]) => addSuppression(...a),
}));
vi.mock("@/lib/rate-budget", () => ({
  consumeBudget: (...a: unknown[]) => consumeBudget(...a),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => (id === "site-cc" ? { id: "site-cc", clientId: "vitality" } : undefined),
  getSites: (clientId: string) =>
    clientId === "vitality" ? [{ id: "site-cc" }, { id: "site-rv" }] : [],
}));

import { POST } from "./route";
import { mintPrefToken } from "@/lib/messaging/pref-token";

const KEY = "prefs-route-test-key";
const PATIENT_REF = "patient:abc123";

function req(body: unknown): Request {
  return new Request("http://localhost/api/prefs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  consumeBudget.mockResolvedValue(true);
  setChannelPref.mockResolvedValue(undefined);
  addSuppression.mockResolvedValue(undefined);
  vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function validToken(): string {
  return mintPrefToken({ siteId: "site-cc", patientRef: PATIENT_REF }, KEY)!;
}

describe("POST /api/prefs", () => {
  it("stores an SMS preference", async () => {
    const res = await POST(req({ token: validToken(), action: "sms" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, action: "sms" });
    expect(setChannelPref).toHaveBeenCalledWith("site-cc", PATIENT_REF, "sms");
    expect(addSuppression).not.toHaveBeenCalled();
  });

  it("stores a WhatsApp preference", async () => {
    const res = await POST(req({ token: validToken(), action: "whatsapp" }));
    expect(res.status).toBe(200);
    expect(setChannelPref).toHaveBeenCalledWith("site-cc", PATIENT_REF, "whatsapp");
  });

  it("routes 'stop' through suppression across the practice on both phone channels", async () => {
    const res = await POST(req({ token: validToken(), action: "stop" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, action: "stop" });
    // Never writes a channel preference on a stop.
    expect(setChannelPref).not.toHaveBeenCalled();
    // Two sites x two phone channels = four suppression writes, all by patient ref
    // with the 'stop' reason (mirrors the inbound STOP path).
    expect(addSuppression).toHaveBeenCalledTimes(4);
    for (const site of ["site-cc", "site-rv"]) {
      for (const channel of ["sms", "whatsapp"]) {
        expect(addSuppression).toHaveBeenCalledWith(site, channel, PATIENT_REF, "stop");
      }
    }
  });

  it("rejects a forged token with no writes", async () => {
    const res = await POST(req({ token: "forged.token", action: "stop" }));
    expect(res.status).toBe(400);
    expect(addSuppression).not.toHaveBeenCalled();
    expect(setChannelPref).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled(); // rejected before any spend
  });

  it("rejects an unknown action", async () => {
    const res = await POST(req({ token: validToken(), action: "carrier-pigeon" }));
    expect(res.status).toBe(400);
    expect(setChannelPref).not.toHaveBeenCalled();
  });

  it("is api_budget-guarded (429 when the budget is exhausted)", async () => {
    consumeBudget.mockResolvedValue(false);
    const res = await POST(req({ token: validToken(), action: "sms" }));
    expect(res.status).toBe(429);
    expect(setChannelPref).not.toHaveBeenCalled();
  });
});
