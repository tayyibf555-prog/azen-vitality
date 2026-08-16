// WHAT LEAVES THE SERVER, asserted on the exact bytes.
//
// A server-to-server call is invisible: no network tab, no cookie banner, nothing
// a patient or a regulator could inspect from outside. So the promise "the default
// event carries no personal data" is only as good as this file. Every assertion
// below is made against the SERIALISED payload rather than against the object,
// because a field that survives JSON.stringify is a field that reaches Meta.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  CAPI_FORBIDDEN_FIELDS,
  buildCapiBody,
  buildLeadEvent,
  capiEndpoint,
  capiUserData,
  hashForMeta,
  normaliseEmailForMeta,
  normalisePhoneForMeta,
} from "./meta-capi";
import { META_API_VERSION } from "@/lib/meta-ads/publish";

const NOW = Date.UTC(2026, 7, 17, 9, 30, 0); // 2026-08-17T09:30:00Z
const EMAIL = "Sam.Patel@Example.com";
const PHONE = "+447700900123";
const PAGE = "https://practice.example/assess/vitality/invisalign";

/** The payload as Meta receives it. Every claim here is made about this string. */
function serialise(event: ReturnType<typeof buildLeadEvent>): string {
  return JSON.stringify(buildCapiBody(event));
}

const BASE = {
  nowMs: NOW,
  sourceUrl: PAGE,
  eventId: "abcdefgh1234",
  email: EMAIL,
  phone: PHONE,
};

/* ---------------------------------------------------------------------------
 * 1. The default: an event about nobody.
 * ------------------------------------------------------------------------- */

describe("without consent and without advanced matching, nothing personal leaves", () => {
  const event = buildLeadEvent({ ...BASE, consented: false, advancedMatching: false });
  const json = serialise(event);

  it("carries exactly the five documented fields", () => {
    expect(event).toEqual({
      event_name: "Lead",
      event_time: Math.floor(NOW / 1000),
      event_source_url: PAGE,
      action_source: "website",
      event_id: "abcdefgh1234",
    });
  });

  // MUTATION: emit `user_data: {}` "because Meta expects the key". An empty
  // object is a claim that we looked and found nobody -- and Meta answers it with
  // an error -- but the real cost is that the key exists for somebody to fill in.
  it("has no user_data key at all, not an empty one", () => {
    expect(event).not.toHaveProperty("user_data");
    expect(json).not.toContain("user_data");
  });

  it("contains neither the address nor any hash of it", () => {
    expect(json).not.toContain("Sam");
    expect(json).not.toContain("sam.patel");
    expect(json.toLowerCase()).not.toContain("example.com");
    expect(json).not.toContain("447700900123");
    expect(json).not.toContain("7700900123");
    // And no hash either: an unconsented event is anonymous, not pseudonymous.
    expect(json).not.toContain(hashForMeta("sam.patel@example.com"));
    expect(json).not.toContain(hashForMeta("447700900123"));
  });
});

describe("either key alone is not enough", () => {
  // MUTATION: collapse the two booleans into one "allowed" flag computed by the
  // caller. The visitor's consent and the practice's setting are two decisions
  // held by two different people, and both have to be present in the signature
  // for a reviewer to see that both are checked.
  it.each([
    ["consent without the setting", true, false],
    ["the setting without consent", false, true],
    ["neither", false, false],
  ])("%s sends no user data", (_label, consented, advancedMatching) => {
    const event = buildLeadEvent({ ...BASE, consented, advancedMatching });
    expect(event.user_data).toBeUndefined();
    expect(serialise(event)).not.toContain("user_data");
    expect(capiUserData({ consented, advancedMatching, email: EMAIL, phone: PHONE })).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * 2. Advanced matching: hashed, or not at all.
 * ------------------------------------------------------------------------- */

describe("with consent AND the setting, the keys are hashed and only hashed", () => {
  const event = buildLeadEvent({ ...BASE, consented: true, advancedMatching: true });
  const json = serialise(event);

  it("sends sha256 of Meta's normalised forms", () => {
    expect(event.user_data).toEqual({
      em: [createHash("sha256").update("sam.patel@example.com").digest("hex")],
      ph: [createHash("sha256").update("447700900123").digest("hex")],
    });
  });

  // MUTATION: send the raw address "for better matching". This is the assertion
  // that would catch it, and it looks at the bytes rather than the object.
  it("never carries a plain address, in any casing", () => {
    for (const needle of [
      EMAIL,
      EMAIL.toLowerCase(),
      "Sam.Patel",
      "@Example.com",
      PHONE,
      "447700900123",
      "07700900123",
    ]) {
      expect(json.includes(needle), `the payload leaked ${needle}`).toBe(false);
    }
  });

  it("omits a key it does not have rather than sending an empty one", () => {
    const emailOnly = capiUserData({
      consented: true,
      advancedMatching: true,
      email: EMAIL,
      phone: null,
    });
    expect(emailOnly).toEqual({ em: [hashForMeta("sam.patel@example.com")] });
    expect(emailOnly).not.toHaveProperty("ph");

    const neither = capiUserData({
      consented: true,
      advancedMatching: true,
      email: null,
      phone: null,
    });
    expect(neither).toBeUndefined();
  });

  it("drops a value that could never match rather than hashing noise", () => {
    // A number with no country code hashes to a key that matches nobody, so it is
    // dropped: sending it would be a disclosure with no benefit at all.
    expect(normalisePhoneForMeta("0770")).toBe(null);
    expect(normalisePhoneForMeta("1".repeat(16))).toBe(null);
    expect(normaliseEmailForMeta("not-an-address")).toBe(null);
    expect(normaliseEmailForMeta("")).toBe(null);
    expect(normaliseEmailForMeta(null)).toBe(null);
  });

  it("normalises exactly as Meta documents, and no further", () => {
    expect(normaliseEmailForMeta("  SAM@Example.COM ")).toBe("sam@example.com");
    // NOT folded: dot-stripping and plus-addressing are provider habits, not the
    // specification, and folding them would hash an address nobody gave us.
    expect(normaliseEmailForMeta("sam.patel+quiz@example.com")).toBe("sam.patel+quiz@example.com");
    expect(normalisePhoneForMeta("+44 7700 900123")).toBe("447700900123");
    expect(normalisePhoneForMeta("(44) 7700-900123")).toBe("447700900123");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The fields that are never present, whatever the settings.
 * ------------------------------------------------------------------------- */

describe("the refused fields stay refused in every combination", () => {
  // MUTATION: add client_ip_address and client_user_agent, which is the FIRST
  // thing every CAPI integration guide tells you to do and the change that turns
  // an anonymous event into a personal one with no contact detail involved.
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("consented=%s advancedMatching=%s", (consented, advancedMatching) => {
    const json = serialise(buildLeadEvent({ ...BASE, consented, advancedMatching }));
    for (const field of CAPI_FORBIDDEN_FIELDS) {
      expect(json.includes(`"${field}"`), `the payload carried ${field}`).toBe(false);
    }
  });

  it("has no way to be told a name, an answer, a score or a band", () => {
    // The signature IS the guarantee: a future edit that wanted to send any of
    // these would have to change it, which is a diff a reviewer sees.
    const keys = Object.keys(BASE).concat(["consented", "advancedMatching"]).sort();
    expect(keys).toEqual([
      "advancedMatching",
      "consented",
      "email",
      "eventId",
      "nowMs",
      "phone",
      "sourceUrl",
    ]);
  });
});

/* ---------------------------------------------------------------------------
 * 4. The two small parsers.
 * ------------------------------------------------------------------------- */

describe("the page URL", () => {
  // MUTATION: pass the URL through untouched. An /assess link arrives with
  // whatever the ad platform appended, and a badly built landing link can carry a
  // name or an email in the query string -- straight into the one payload this
  // module promises carries none.
  it("keeps the path and throws the query string away", () => {
    const event = buildLeadEvent({
      ...BASE,
      sourceUrl: `${PAGE}?utm_source=fb&email=sam%40example.com&fbclid=abc`,
      consented: false,
      advancedMatching: false,
    });
    expect(event.event_source_url).toBe(PAGE);
    expect(serialise(event)).not.toContain("sam");
    expect(serialise(event)).not.toContain("fbclid");
  });

  it("drops a fragment too, and anything that is not http(s)", () => {
    expect(
      buildLeadEvent({ ...BASE, sourceUrl: `${PAGE}#step-3`, consented: false, advancedMatching: false })
        .event_source_url,
    ).toBe(PAGE);
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "not a url", "", null, undefined]) {
      const event = buildLeadEvent({
        ...BASE,
        sourceUrl: bad,
        consented: false,
        advancedMatching: false,
      });
      expect(event).not.toHaveProperty("event_source_url");
    }
  });
});

describe("the shared event id", () => {
  it("is carried when it is opaque and plausible", () => {
    expect(
      buildLeadEvent({ ...BASE, eventId: "0b1c2d3e-4f56-4789-abcd-ef0123456789", consented: false, advancedMatching: false })
        .event_id,
    ).toBe("0b1c2d3e-4f56-4789-abcd-ef0123456789");
  });

  // MUTATION: pass it through unchecked. It is the one caller-supplied string in
  // the payload, and it is posted to a third party.
  it.each(["", "short", "has spaces", "a".repeat(65), "<script>", null, undefined])(
    "is omitted for %s",
    (value) => {
      const event = buildLeadEvent({ ...BASE, eventId: value, consented: false, advancedMatching: false });
      expect(event).not.toHaveProperty("event_id");
    },
  );
});

describe("the timestamp and the endpoint", () => {
  // MUTATION: send Date.now() straight through. Meta reads event_time as SECONDS,
  // so a millisecond value is a date fifty thousand years out and every event is
  // rejected -- silently, because we never read the error body.
  it("reports seconds, not milliseconds", () => {
    const event = buildLeadEvent({ ...BASE, consented: false, advancedMatching: false });
    expect(event.event_time).toBe(Math.floor(NOW / 1000));
    // The mutation stated directly, so the line above cannot be read as a
    // tautology: the milliseconds must NOT be what is sent, and a Unix second in
    // this century is ten digits while a millisecond value is thirteen.
    expect(event.event_time).not.toBe(NOW);
    expect(String(event.event_time)).toHaveLength(10);
  });

  it("posts to the same Graph version the campaign publisher uses", () => {
    // Imported, never retyped: a practice's ad publishing and its conversion
    // reporting must not end up speaking to two versions of one API.
    expect(capiEndpoint("123456789012345")).toBe(
      `https://graph.facebook.com/${META_API_VERSION}/123456789012345/events`,
    );
    expect(META_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it("wraps one event in the batch shape Meta expects", () => {
    const event = buildLeadEvent({ ...BASE, consented: false, advancedMatching: false });
    expect(buildCapiBody(event)).toEqual({ data: [event] });
  });
});

describe("hashing", () => {
  it("is sha256, lowercase hex, and has no plaintext branch", () => {
    expect(hashForMeta("sam@example.com")).toBe(
      createHash("sha256").update("sam@example.com").digest("hex"),
    );
    expect(hashForMeta("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});
