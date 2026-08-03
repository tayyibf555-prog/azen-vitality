import { describe, it, expect } from "vitest";
import {
  classifyRegisterResponse,
  REGISTER_WRITES_OFF,
  REGISTER_UNREACHABLE,
  REGISTER_UNEXPECTED,
  REGISTER_FAILED,
  type RegisterMatch,
} from "./register-result";

const MATCH: RegisterMatch = {
  id: "pat-existing",
  name: "Jane Doe",
  dateOfBirth: "1990-05-01",
  site: "N15 Vitality Dental",
  matchedOn: "the same mobile number",
};

describe("classifyRegisterResponse", () => {
  it("reads a 503 as BLOCKED, never as an error and never as a success", () => {
    const out = classifyRegisterResponse(503, { ok: false, error: REGISTER_WRITES_OFF });
    expect(out).toEqual({ kind: "blocked", message: REGISTER_WRITES_OFF });
  });

  // The 503 body is also ok:false, so the generic failure branch would swallow it
  // and show a red "something went wrong" box that invites a retry.
  it("recognises the 503 BEFORE the generic ok:false failure branch", () => {
    expect(classifyRegisterResponse(503, { ok: false }).kind).toBe("blocked");
    expect(classifyRegisterResponse(500, { ok: false }).kind).toBe("error");
  });

  it("falls back to the standard refusal when the 503 carried no message", () => {
    expect(classifyRegisterResponse(503, { ok: false })).toEqual({
      kind: "blocked",
      message: REGISTER_WRITES_OFF,
    });
  });

  it("reads a created patient as SUCCESS, carrying the id through", () => {
    expect(classifyRegisterResponse(200, { ok: true, created: true, patientId: "new-pat-1" })).toEqual({
      kind: "success",
      patientId: "new-pat-1",
    });
  });

  it("reads a dedupe hit as DUPLICATE, carrying the match through", () => {
    expect(classifyRegisterResponse(200, { ok: true, created: false, duplicate: true, match: MATCH })).toEqual({
      kind: "duplicate",
      match: MATCH,
    });
  });

  // A duplicate is NOT a create. Reading it as a success would tell staff a patient
  // exists that was never written, and lose the "only continue if this is a
  // different person" step entirely.
  it("prefers DUPLICATE over SUCCESS when a body somehow claims both", () => {
    const out = classifyRegisterResponse(200, {
      ok: true,
      created: true,
      patientId: "new-pat-1",
      duplicate: true,
      match: MATCH,
    });
    expect(out.kind).toBe("duplicate");
  });

  it("reads a non-2xx as an ERROR carrying the server's own words", () => {
    expect(classifyRegisterResponse(422, { ok: false, error: "Dentally rejected the details (422)." })).toEqual({
      kind: "error",
      message: "Dentally rejected the details (422).",
    });
  });

  it("reads ok:false on a 200 as an ERROR", () => {
    expect(classifyRegisterResponse(200, { ok: false, error: "nope" }).kind).toBe("error");
  });

  it("names the failure itself when the server explained nothing", () => {
    expect(classifyRegisterResponse(500, {})).toEqual({ kind: "error", message: REGISTER_FAILED });
  });

  it("reads a missing body as unreachable", () => {
    expect(classifyRegisterResponse(200, null)).toEqual({ kind: "error", message: REGISTER_UNREACHABLE });
  });

  // created:true with no id is not a create anyone can act on: the dialogue must
  // not print "Dentally patient ID: undefined" under a green tick.
  it("refuses to call a 2xx a success when it carries no patient id", () => {
    expect(classifyRegisterResponse(200, { ok: true, created: true })).toEqual({
      kind: "error",
      message: REGISTER_UNEXPECTED,
    });
  });

  it("refuses to call a 2xx a duplicate when it carries no match", () => {
    expect(classifyRegisterResponse(200, { ok: true, duplicate: true }).kind).toBe("error");
  });

  // There is no outcome that both blocks and claims a patient id: this is the
  // property the old dryRun success state broke.
  it("never returns a success for any refused response", () => {
    for (const status of [400, 403, 409, 422, 500, 502, 503]) {
      expect(classifyRegisterResponse(status, { ok: false, created: true, patientId: "x" }).kind).not.toBe(
        "success",
      );
    }
  });
});

describe("the refusal copy", () => {
  it("says plainly that nothing was created", () => {
    expect(REGISTER_WRITES_OFF).toMatch(/nothing has been created/i);
  });

  it("never claims a registration happened, in test mode or otherwise", () => {
    expect(REGISTER_WRITES_OFF).not.toMatch(/registered|recorded|created in|dry ?run|test mode/i);
  });

  it("tells the reader what to do about it", () => {
    expect(REGISTER_WRITES_OFF).toMatch(/administrator/i);
  });

  // Project rule: patient-facing and staff-facing copy alike never names a funding
  // regime. This string is quoted straight back by the API, so it is sweep-checked
  // like every other piece of copy in the app.
  it("names no funding regime", () => {
    for (const s of [REGISTER_WRITES_OFF, REGISTER_UNREACHABLE, REGISTER_UNEXPECTED, REGISTER_FAILED]) {
      expect(s).not.toMatch(/\b(NHS|private|band [123])\b/i);
    }
  });
});
