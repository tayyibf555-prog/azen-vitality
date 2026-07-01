// AREA 18: public onboarding submit /api/onboarding/submit.
//
// UNAUTHENTICATED write. We assert:
//   - an unknown practice slug is rejected (bound to a real client),
//   - the budget cost guard blocks (429) once the cap is hit,
//   - malformed answers / non-JSON are clean 4xx and never write,
//   - a file reference under ANOTHER client's storage prefix (or with traversal) is
//     rejected — no cross-tenant attachment,
//   - the written submission is bound to the resolved client id,
//   - a formSlug that does not resolve to an active form is rejected (404).
//
// I/O seams mocked; the REAL handler runs.

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createSubmission: vi.fn(async (..._a: unknown[]) => ({ id: "sub-1" })),
  getConfig: vi.fn(async (..._a: unknown[]) => null as unknown),
  getActiveFormBySlug: vi.fn(async (..._a: unknown[]) => null as unknown),
  consumeBudget: vi.fn(async (..._a: unknown[]) => true as boolean),
}));

vi.mock("@/lib/onboarding/repository", () => ({ createSubmission: h.createSubmission }));
vi.mock("@/lib/onboarding/config-repository", () => ({ getConfig: h.getConfig }));
vi.mock("@/lib/onboarding/form-repository", () => ({ getActiveFormBySlug: h.getActiveFormBySlug }));
vi.mock("@/lib/rate-budget", () => ({ consumeBudget: h.consumeBudget }));

import { POST } from "./route";
import { ONBOARDING_STEPS } from "@/lib/onboarding/steps";

// A config the resolver turns into the real steps. getConfig returns null so the
// route falls back to the default resolved steps; ONBOARDING_STEPS mirror those.
let ipCounter = 0;
function req(body: unknown, headers: Record<string, string> = {}): Request {
  ipCounter += 1;
  return new Request("http://localhost/api/onboarding/submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-real-ip": `198.51.100.${ipCounter}`,
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// Build a valid answers object from the real required fields so the happy path passes.
function validAnswers(): Record<string, string> {
  const a: Record<string, string> = {};
  for (const f of ONBOARDING_STEPS.flatMap((s) => s.fields)) {
    if (!f.required) continue;
    if (f.type === "email") a[f.key] = "alex@example.com";
    else if (f.type === "tel") a[f.key] = "07700 900123";
    else if (f.type === "select") a[f.key] = (f.options?.[0]?.value ?? "");
    else if (f.type === "date") a[f.key] = "1990-04-12";
    else if (f.type === "yesno") a[f.key] = "yes";
    else a[f.key] = "value";
  }
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getConfig.mockResolvedValue(null);
  h.getActiveFormBySlug.mockResolvedValue(null);
  h.consumeBudget.mockResolvedValue(true);
});

describe("onboarding/submit — client binding + cost guard", () => {
  it("rejects an unknown practice slug", async () => {
    const res = await POST(req({ clientSlug: "ghost", answers: validAnswers() }));
    expect(res.status).toBe(400);
    expect(h.createSubmission).not.toHaveBeenCalled();
  });

  it("returns 429 when the shared budget is exhausted", async () => {
    h.consumeBudget.mockResolvedValueOnce(false);
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers() }));
    expect(res.status).toBe(429);
    expect(h.createSubmission).not.toHaveBeenCalled();
  });

  it("writes a submission bound to the resolved client id on a valid payload", async () => {
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers() }));
    expect(res.status).toBe(200);
    expect(h.createSubmission).toHaveBeenCalledTimes(1);
    const arg = h.createSubmission.mock.calls[0]![0] as { clientId: string };
    expect(arg.clientId).toBe("vitality");
  });

  it("does not leak the row id to the public caller", async () => {
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers() }));
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).not.toHaveProperty("id");
    expect(j.ok).toBe(true);
  });
});

describe("onboarding/submit — input validation", () => {
  it("rejects a non-JSON body", async () => {
    const res = await POST(req("nope{", {}));
    expect(res.status).toBe(400);
  });

  it("rejects when a required field is missing", async () => {
    const a = validAnswers();
    delete a.first_name;
    const res = await POST(req({ clientSlug: "vitality", answers: a }));
    expect(res.status).toBe(400);
    expect(h.createSubmission).not.toHaveBeenCalled();
  });

  it("rejects an unresolvable / paused formSlug with 404", async () => {
    h.getActiveFormBySlug.mockResolvedValueOnce(null);
    const res = await POST(req({ clientSlug: "vitality", formSlug: "paused-form", answers: validAnswers() }));
    expect(res.status).toBe(404);
    expect(h.createSubmission).not.toHaveBeenCalled();
  });
});

describe("onboarding/submit — cross-tenant file attachment guard", () => {
  it("rejects a file reference under another client's storage prefix", async () => {
    const files = [
      { path: "onboarding/other-practice/tok/x.pdf", name: "x.pdf", size: 10, type: "application/pdf" },
    ];
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(400);
    expect(h.createSubmission).not.toHaveBeenCalled();
  });

  it("rejects a path-traversal file reference", async () => {
    const files = [
      { path: "onboarding/vitality/../../etc/passwd", name: "p", size: 10, type: "application/pdf" },
    ];
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(400);
  });

  it("rejects a disallowed file content-type", async () => {
    const files = [
      { path: "onboarding/vitality/tok/e.exe", name: "e.exe", size: 10, type: "application/x-msdownload" },
    ];
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(400);
  });

  it("rejects an oversized file reference", async () => {
    const files = [
      { path: "onboarding/vitality/tok/big.pdf", name: "big.pdf", size: 50 * 1024 * 1024, type: "application/pdf" },
    ];
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed file under this client's own prefix", async () => {
    const files = [
      { path: "onboarding/vitality/tok/ok.pdf", name: "ok.pdf", size: 1234, type: "application/pdf" },
    ];
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(200);
    const arg = h.createSubmission.mock.calls[0]![0] as { files: unknown[] };
    expect(arg.files).toHaveLength(1);
  });

  it("rejects more files than the cap allows", async () => {
    const files = Array.from({ length: 9 }, (_v, i) => ({
      path: `onboarding/vitality/tok/f${i}.pdf`,
      name: `f${i}.pdf`,
      size: 10,
      type: "application/pdf",
    }));
    const res = await POST(req({ clientSlug: "vitality", answers: validAnswers(), files }));
    expect(res.status).toBe(400);
  });
});
