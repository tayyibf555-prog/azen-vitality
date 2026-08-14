import { describe, it, expect } from "vitest";
import { MAX_IMAGE_SIGNATURE, MAX_TYPED_SIGNATURE } from "@/lib/fp17/validate";
import {
  ESIGN_COPY,
  SIGNATURE_IMAGE_CAP,
  SIGNATURE_TYPED_CAP,
  currentPolicies,
  hashIp,
  isValidPolicySlug,
  nextPolicyVersion,
  outstandingPolicies,
  policySlugFromTitle,
  signatureBindsToVersion,
  signatureIsValid,
  signingProgress,
  toSignatureSummary,
  trimUserAgent,
  validateSignatureInput,
  type StaffPolicy,
  type StaffPolicySignature,
} from "./esign";

const TODAY = "2026-08-14";
const NOW = "2026-08-14T10:30:00.000Z";
const PNG = `data:image/png;base64,${"iVBORw0KGgo".repeat(4)}`;

function policy(over: Partial<StaffPolicy> = {}): StaffPolicy {
  return {
    id: "pol-1",
    clientId: "vitality",
    slug: "infection-control",
    title: "Infection control",
    version: 1,
    storagePath: "staff-docs/vitality/policies/tok/infection-control.pdf",
    mime: "application/pdf",
    sizeBytes: 2048,
    effectiveFrom: "2026-01-01",
    retiredAt: null,
    createdBy: null,
    createdAt: "2026-01-01T09:00:00.000Z",
    ...over,
  };
}

function signature(over: Partial<StaffPolicySignature> = {}): StaffPolicySignature {
  return {
    id: "sig-1",
    clientId: "vitality",
    staffId: "staff-1",
    policyId: "pol-1",
    policyVersion: 1,
    signature: { method: "typed", value: "Blerta", signedAt: NOW },
    signedAt: NOW,
    ipHash: null,
    userAgent: null,
    ...over,
  };
}

// ===========================================================================
// THE CAPS ARE FP17's. Not a copy of fp17's numbers — fp17's numbers.
// ===========================================================================
describe("the signature size caps are imported, not retyped", () => {
  it("is the same constant, so the two capture surfaces cannot drift", () => {
    expect(SIGNATURE_TYPED_CAP).toBe(MAX_TYPED_SIGNATURE);
    expect(SIGNATURE_IMAGE_CAP).toBe(MAX_IMAGE_SIGNATURE);
  });

  it("still holds the values the schema comment promises", () => {
    expect(SIGNATURE_TYPED_CAP).toBe(120);
    expect(SIGNATURE_IMAGE_CAP).toBe(250_000);
  });
});

describe("signatureIsValid", () => {
  it("accepts a typed name", () => {
    expect(signatureIsValid({ method: "typed", value: "Blerta K", signedAt: NOW })).toBe(true);
  });

  it("accepts a drawn PNG data-URL", () => {
    expect(signatureIsValid({ method: "drawn", value: PNG, signedAt: NOW })).toBe(true);
  });

  it("REFUSES 'ipad', which the patient form allows and staff signing deliberately does not", () => {
    expect(signatureIsValid({ method: "ipad", value: PNG, signedAt: NOW })).toBe(false);
  });

  it("refuses an empty or whitespace-only value", () => {
    expect(signatureIsValid({ method: "typed", value: "", signedAt: NOW })).toBe(false);
    expect(signatureIsValid({ method: "typed", value: "   ", signedAt: NOW })).toBe(false);
  });

  it("refuses a typed name over the cap, and accepts one exactly at it", () => {
    expect(
      signatureIsValid({ method: "typed", value: "a".repeat(SIGNATURE_TYPED_CAP), signedAt: NOW }),
    ).toBe(true);
    expect(
      signatureIsValid({
        method: "typed",
        value: "a".repeat(SIGNATURE_TYPED_CAP + 1),
        signedAt: NOW,
      }),
    ).toBe(false);
  });

  it("refuses a drawn signature over the image cap", () => {
    const huge = `data:image/png;base64,${"A".repeat(SIGNATURE_IMAGE_CAP)}`;
    expect(signatureIsValid({ method: "drawn", value: huge, signedAt: NOW })).toBe(false);
  });

  it("REFUSES a drawn signature that is a LINK rather than an inline image", () => {
    // Storing a reference to evidence is not storing evidence: whoever controls that
    // host can change what the signature "is" after the fact.
    expect(
      signatureIsValid({ method: "drawn", value: "https://example.com/sig.png", signedAt: NOW }),
    ).toBe(false);
  });

  it("refuses a script-capable data-URL dressed as an image", () => {
    expect(
      signatureIsValid({
        method: "drawn",
        value: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        signedAt: NOW,
      }),
    ).toBe(false);
    expect(
      signatureIsValid({ method: "drawn", value: "data:text/html;base64,PGI+", signedAt: NOW }),
    ).toBe(false);
  });

  it("refuses a signature with no signedAt", () => {
    expect(signatureIsValid({ method: "typed", value: "Blerta" })).toBe(false);
    expect(signatureIsValid({ method: "typed", value: "Blerta", signedAt: "" })).toBe(false);
  });

  it("refuses a non-object", () => {
    expect(signatureIsValid(null)).toBe(false);
    expect(signatureIsValid("Blerta")).toBe(false);
    expect(signatureIsValid(undefined)).toBe(false);
  });
});

describe("validateSignatureInput stamps the time from the SERVER", () => {
  it("ignores any signedAt the caller supplies and uses now", () => {
    const result = validateSignatureInput(
      { method: "typed", value: "Blerta", signedAt: "1999-01-01T00:00:00.000Z" } as never,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.signedAt).toBe(NOW);
  });

  it("trims a typed name but never touches a data-URL payload", () => {
    const typed = validateSignatureInput({ method: "typed", value: "  Blerta  " }, NOW);
    expect(typed.ok && typed.value.value).toBe("Blerta");
    const drawn = validateSignatureInput({ method: "drawn", value: PNG }, NOW);
    expect(drawn.ok && drawn.value.value).toBe(PNG);
  });

  it("returns a plain-English error, never throws", () => {
    const blank = validateSignatureInput({ method: "typed", value: "" }, NOW);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toContain("sign the policy");
    const bad = validateSignatureInput({ method: "drawn", value: "http://x/y.png" }, NOW);
    expect(bad.ok).toBe(false);
  });

  it("refuses an unknown method", () => {
    expect(validateSignatureInput({ method: "wet-ink", value: "x" }, NOW).ok).toBe(false);
    expect(validateSignatureInput({ value: "x" }, NOW).ok).toBe(false);
  });
});

// ===========================================================================
// THE BINDING. This is the block that makes the record worth anything.
// ===========================================================================
describe("a signature binds to the VERSION, not to the policy", () => {
  it("binds when both the policy and the version match", () => {
    expect(signatureBindsToVersion(signature(), policy())).toBe(true);
  });

  it("does NOT bind a version 1 signature to version 2", () => {
    expect(signatureBindsToVersion(signature({ policyVersion: 1 }), policy({ version: 2 }))).toBe(
      false,
    );
  });

  it("does NOT bind a signature on a different policy that happens to share a version", () => {
    expect(
      signatureBindsToVersion(signature({ policyId: "fire-policy" }), policy({ id: "pol-1" })),
    ).toBe(false);
  });

  it("publishing a new version puts the policy back on everyone's list", () => {
    const v1 = policy({ id: "pol-1", version: 1 });
    const v2 = policy({ id: "pol-2", version: 2, effectiveFrom: "2026-06-01" });
    const signedV1 = [signature({ policyId: "pol-1", policyVersion: 1 })];
    expect(outstandingPolicies([v1], signedV1, TODAY)).toEqual([]);
    expect(outstandingPolicies([v1, v2], signedV1, TODAY).map((p) => p.id)).toEqual(["pol-2"]);
  });
});

describe("currentPolicies: what is in force today", () => {
  it("keeps only the highest version of each policy", () => {
    const rows = [policy({ id: "a", version: 1 }), policy({ id: "b", version: 3 })];
    expect(currentPolicies(rows, TODAY).map((p) => p.id)).toEqual(["b"]);
  });

  it("EXCLUDES a future-dated version, so nobody signs a policy before it exists", () => {
    const rows = [
      policy({ id: "now", version: 1, effectiveFrom: "2026-01-01" }),
      policy({ id: "later", version: 2, effectiveFrom: "2026-09-01" }),
    ];
    expect(currentPolicies(rows, TODAY).map((p) => p.id)).toEqual(["now"]);
  });

  it("includes a version effective TODAY", () => {
    const rows = [policy({ id: "today", effectiveFrom: TODAY })];
    expect(currentPolicies(rows, TODAY).map((p) => p.id)).toEqual(["today"]);
  });

  it("excludes a retired version and falls back to nothing rather than an older one", () => {
    const rows = [policy({ id: "gone", retiredAt: "2026-07-01T00:00:00.000Z" })];
    expect(currentPolicies(rows, TODAY)).toEqual([]);
  });

  it("returns one entry per slug, sorted by title so the list is stable", () => {
    const rows = [
      policy({ id: "z", slug: "fire", title: "Fire safety" }),
      policy({ id: "a", slug: "infection-control", title: "Infection control" }),
    ];
    expect(currentPolicies(rows, TODAY).map((p) => p.title)).toEqual([
      "Fire safety",
      "Infection control",
    ]);
  });
});

describe("outstandingPolicies", () => {
  it("lists everything in force that this person has not signed", () => {
    const rows = [
      policy({ id: "a", slug: "fire", title: "Fire safety" }),
      policy({ id: "b", slug: "infection-control", title: "Infection control" }),
    ];
    expect(outstandingPolicies(rows, [], TODAY).map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("drops the ones already signed at the current version", () => {
    const rows = [policy({ id: "a", slug: "fire" }), policy({ id: "b", slug: "ic" })];
    const sigs = [signature({ policyId: "a", policyVersion: 1 })];
    expect(outstandingPolicies(rows, sigs, TODAY).map((p) => p.id)).toEqual(["b"]);
  });

  it("never asks for a future-dated or retired policy", () => {
    const rows = [
      policy({ id: "future", slug: "f", effectiveFrom: "2027-01-01" }),
      policy({ id: "retired", slug: "r", retiredAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(outstandingPolicies(rows, [], TODAY)).toEqual([]);
  });
});

describe("signingProgress: the compliance mirror", () => {
  it("splits the team into signed and outstanding for one version", () => {
    const staff = [{ id: "s1" }, { id: "s2" }, { id: "s3" }];
    const sigs = [
      signature({ staffId: "s1", policyId: "pol-1", policyVersion: 1 }),
      signature({ staffId: "s2", policyId: "pol-1", policyVersion: 0 }), // stale version
    ];
    const { signed, outstanding } = signingProgress(policy(), staff, sigs);
    expect(signed.map((s) => s.id)).toEqual(["s1"]);
    expect(outstanding.map((s) => s.id)).toEqual(["s2", "s3"]);
  });
});

describe("nextPolicyVersion", () => {
  it("starts at 1 when nothing has been published", () => {
    expect(nextPolicyVersion([], "fire")).toBe(1);
  });

  it("increments past the highest existing version for that slug only", () => {
    const rows = [
      { slug: "fire", version: 1 },
      { slug: "fire", version: 4 },
      { slug: "infection-control", version: 9 },
    ];
    expect(nextPolicyVersion(rows, "fire")).toBe(5);
    expect(nextPolicyVersion(rows, "infection-control")).toBe(10);
    expect(nextPolicyVersion(rows, "fire-doors")).toBe(1);
  });
});

describe("policy slugs are deterministic and bounded", () => {
  it("derives a slug from a title", () => {
    expect(policySlugFromTitle("Infection Control (2026)")).toBe("infection-control-2026");
    expect(policySlugFromTitle("  Fire safety  ")).toBe("fire-safety");
  });

  it("never emits a leading or trailing dash", () => {
    expect(policySlugFromTitle("!!! Fire !!!")).toBe("fire");
  });

  it("rejects an invalid slug rather than storing it", () => {
    expect(isValidPolicySlug("infection-control")).toBe(true);
    expect(isValidPolicySlug("")).toBe(false);
    expect(isValidPolicySlug("Infection Control")).toBe(false);
    expect(isValidPolicySlug("-leading")).toBe(false);
    expect(isValidPolicySlug("a".repeat(61))).toBe(false);
  });
});

describe("corroboration is stored hashed, and is honestly weak", () => {
  it("hashes the IP, so the raw address is never stored", () => {
    const hashed = hashIp("81.2.3.4", "vitality");
    expect(hashed).not.toBeNull();
    expect(hashed).not.toContain("81.2.3.4");
    expect(hashed).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it("is deterministic for the same client, so 'same place?' stays answerable", () => {
    expect(hashIp("81.2.3.4", "vitality")).toBe(hashIp("81.2.3.4", "vitality"));
  });

  it("is salted per client, so one practice's hashes cannot be matched to another's", () => {
    expect(hashIp("81.2.3.4", "vitality")).not.toBe(hashIp("81.2.3.4", "other"));
  });

  it("returns null rather than a hash of nothing", () => {
    expect(hashIp("", "vitality")).toBeNull();
    expect(hashIp("unknown", "vitality")).toBeNull();
    expect(hashIp(undefined, "vitality")).toBeNull();
  });

  it("bounds the user agent so a hostile header cannot write a novel", () => {
    expect(trimUserAgent("x".repeat(1000))?.length).toBe(300);
    expect(trimUserAgent("  ")).toBeNull();
    expect(trimUserAgent(undefined)).toBeNull();
  });
});

describe("a list view never re-serves the signature image", () => {
  it("keeps method and signedAt and drops the value", () => {
    const summary = toSignatureSummary(signature({ signature: { method: "drawn", value: PNG, signedAt: NOW } }));
    expect(summary.signature).toEqual({ method: "drawn", signedAt: NOW });
    expect(JSON.stringify(summary)).not.toContain("base64");
  });
});

// ===========================================================================
// THE COPY IS PART OF THE FEATURE. If it drifts, the platform starts claiming
// something the schema does not support.
// ===========================================================================
describe("the legal framing says what this is, and what it is not", () => {
  it("claims exactly the attestation: this login, this version, this time", () => {
    expect(ESIGN_COPY.whatThisIs).toContain("signed in as yourself");
    expect(ESIGN_COPY.whatThisIs).toContain("this version");
    expect(ESIGN_COPY.whatThisIs).toContain("at this time");
  });

  it("disclaims a witnessed and a qualified signature, in plain words", () => {
    expect(ESIGN_COPY.whatThisIsNot).toContain("not a witnessed signature");
    expect(ESIGN_COPY.whatThisIsNot).toContain("not a qualified electronic signature");
  });

  it("calls the IP and device detail supporting detail, never proof of identity", () => {
    expect(ESIGN_COPY.corroborationNote).toContain("not proof of identity");
  });

  it("tells the manager this is record keeping, not legal advice", () => {
    expect(ESIGN_COPY.managerNote).toContain("not legal advice");
  });

  it("explains that a new version means signing again", () => {
    expect(ESIGN_COPY.versionBinding).toContain("sign again");
  });

  it("uses no dash characters, per the house copy rule", () => {
    for (const [key, line] of Object.entries(ESIGN_COPY)) {
      expect(line.includes("—"), `${key} contains an em dash`).toBe(false);
      expect(line.includes("–"), `${key} contains an en dash`).toBe(false);
    }
  });

  it("never frames anything as NHS or private", () => {
    for (const [key, line] of Object.entries(ESIGN_COPY)) {
      expect(/\bNHS\b/.test(line), `${key} mentions NHS`).toBe(false);
    }
  });
});
