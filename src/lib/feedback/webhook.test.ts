// notifyFeedbackWebhook's contract: a silent no-op when unset, a plain-text POST
// when set, and NEVER throws back to the caller (route.ts calls it fire-and-
// forget, not awaited) regardless of how the fetch fails.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { notifyFeedbackWebhook } from "./webhook";

const item = {
  severity: "bug",
  pagePath: "/c/vitality/patients",
  note: "The patient search spinner never stops.",
  userEmail: "manager@vitalitydental.example",
  role: "client_coordinator",
};

describe("notifyFeedbackWebhook", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does nothing when FEEDBACK_WEBHOOK_URL is unset", () => {
    vi.stubEnv("FEEDBACK_WEBHOOK_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    notifyFeedbackWebhook(item, "Vitality Dental");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts a plain-text summary carrying the note and client name when the URL is set", () => {
    vi.stubEnv("FEEDBACK_WEBHOOK_URL", "https://hooks.example.com/feedback");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    notifyFeedbackWebhook(item, "Vitality Dental");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://hooks.example.com/feedback");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("Vitality Dental");
    expect(String(init.body)).toContain(item.note);
    expect(String(init.body)).toContain(item.userEmail);
  });

  it("never throws when the webhook request rejects (network error)", () => {
    vi.stubEnv("FEEDBACK_WEBHOOK_URL", "https://hooks.example.com/feedback");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(() => notifyFeedbackWebhook(item, "Vitality Dental")).not.toThrow();
  });

  it("never throws when fetch itself throws synchronously (e.g. a malformed URL)", () => {
    vi.stubEnv("FEEDBACK_WEBHOOK_URL", "not a valid url");
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new TypeError("Failed to parse URL");
    });
    expect(() => notifyFeedbackWebhook(item, "Vitality Dental")).not.toThrow();
  });
});
