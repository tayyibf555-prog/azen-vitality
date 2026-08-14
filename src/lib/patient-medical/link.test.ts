import { describe, it, expect, afterEach, vi } from "vitest";
import { buildMedicalHistoryLink } from "./link";
import { verifyPatientToken } from "@/lib/public-link/patient-token";

// The link builder is thin, but two properties are load-bearing: it is null in dev
// (no key, nothing to send), and the token it mints round-trips ONLY as an 'mh'
// token — never as an 'fp17' one, which is the cross-purpose replay defence.

const KEY = "test-key-123";

describe("buildMedicalHistoryLink", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns null when no server key is set, so there is nothing to send in dev", () => {
    vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", "");
    expect(buildMedicalHistoryLink("site-cc", "p1", "https://app.test")).toBeNull();
  });

  it("builds an absolute /mh/<token> URL on PUBLIC_BASE_URL when a key is set", () => {
    vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
    const link = buildMedicalHistoryLink("site-cc", "p1", "https://app.test");
    expect(link).not.toBeNull();
    expect(link!.startsWith("https://app.test/mh/")).toBe(true);
  });

  it("mints an 'mh' token that verifies as 'mh' and NOT as 'fp17'", () => {
    vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
    const link = buildMedicalHistoryLink("site-cc", "p1", "https://app.test");
    const token = link!.slice("https://app.test/mh/".length);
    expect(verifyPatientToken(token, "mh", KEY)).toEqual({ siteId: "site-cc", patientRef: "p1" });
    // The cross-purpose gate: an mh link cannot be replayed on the fp17 endpoint.
    expect(verifyPatientToken(token, "fp17", KEY)).toBeNull();
  });

  it("falls back to a root-relative path when PUBLIC_BASE_URL is not an http URL", () => {
    vi.stubEnv("SMILE_ASSESSMENT_SUBMIT_KEY", KEY);
    const link = buildMedicalHistoryLink("site-cc", "p1", "");
    expect(link!.startsWith("/mh/")).toBe(true);
  });
});
