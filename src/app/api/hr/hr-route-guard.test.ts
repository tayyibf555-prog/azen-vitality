import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { canRoleAccessModule, STAFF_SLUGS } from "@/lib/nav";
import type { Role } from "@/lib/types";

// ===========================================================================
// THE HR LANE'S ROUTES, PINNED STRUCTURALLY.
//
// The two platform-wide sweeps
// (client-api-module-guard-coverage / destructive-route-capability-coverage) prove
// that every route carries SOME authorisation. They cannot prove the things that
// matter most about THESE routes, because those are properties of the specific
// code inside them:
//
//   - the signer of a policy comes from the SESSION and never from the body;
//   - the upload keeps every one of the onboarding template's safety properties;
//   - the signed-URL route uses the TESTED prefix guard rather than an inline one;
//   - publishing a policy, which puts a document in front of every employee, is
//     owner-level and not merely approver-level.
//
// Each of those is one edit away from being silently untrue, and none of them
// would fail a type check. So they are asserted here, from the source text, the way
// this codebase already asserts its guard coverage.
// ===========================================================================

const HR_DIR = fileURLToPath(new URL(".", import.meta.url));

function source(relPath: string): string {
  const full = join(HR_DIR, relPath);
  expect(existsSync(full), `${relPath} should exist`).toBe(true);
  return readFileSync(full, "utf8");
}

const DOCUMENT = "document/route.ts";
const DOCUMENT_URL = "document/url/route.ts";
const POLICY = "policy/route.ts";
const SIGN = "policy/[id]/sign/route.ts";

const ALL = [DOCUMENT, DOCUMENT_URL, POLICY, SIGN];

/**
 * The three MANAGER routes: somebody handling OTHER people's employment records.
 *
 * SIGN is deliberately not among them. It is the self-service half — a member of
 * staff affirming a policy for themselves — and in the integration phase its module
 * gate was removed, because "staff-hr" refuses exactly the two roles the feature
 * exists for and "my-work" would be an inert gate (both new roles hold it). What
 * replaced the gate is asserted at the bottom of this file and, platform-wide, by
 * the `kind: "self-service"` entry in client-api-module-guard-coverage.
 */
const MANAGER_ROUTES = [DOCUMENT, DOCUMENT_URL, POLICY];

describe("every HR route resolves a session and locks the practice", () => {
  it.each(ALL)("%s runs requireUser then requireClientAccess", (route) => {
    const src = source(route);
    expect(src).toContain("await requireUser()");
    expect(src).toContain("requireClientAccess(");
    // The client comes from a slug that is looked up, so an unknown practice is a
    // 404 rather than a read against a client id the caller invented.
    expect(src).toContain("getClient(");
  });

  it.each(MANAGER_ROUTES)("%s carries the staff-hr module gate", (route) => {
    expect(source(route)).toContain('requireModuleApiAccess(auth, "staff-hr")');
  });

  it("the sign route carries NO module gate, and that is the decision, not a gap", () => {
    // Stated as its own assertion rather than as an absence from the list above, so
    // that re-adding the gate — which would lock a nurse out of signing her own
    // policy — fails here with the reason attached.
    expect(source(SIGN)).not.toContain("requireModuleApiAccess(");
  });

  it("the staff-hr gate is a real lock: two roles are denied by it", () => {
    // If "staff-hr" ever became open to everybody, that gate would compile, read as
    // a lock and do nothing, which is the exact failure mode the platform sweep
    // exists for. Derived from the predicate, not restated.
    const denied = (["client_clinician", "client_staff"] as Role[]).filter(
      (role) => !canRoleAccessModule(role, "staff-hr"),
    );
    expect(denied).toEqual(["client_clinician", "client_staff"]);
  });
});

describe("the document upload keeps every safety property of the template it clones", () => {
  const src = source(DOCUMENT);

  it("caps a single IP before the body is read", () => {
    expect(src).toContain("tooManyForIp(");
    // The per-IP cap must be taken BEFORE the multipart body is parsed, or the
    // flood it exists to blunt has already been read into memory.
    expect(src.indexOf("tooManyForIp(clientIp(request)")).toBeLessThan(
      src.indexOf("await request.formData()"),
    );
  });

  it("consumes the shared cross-instance budget, which IP spoofing cannot bypass", () => {
    expect(src).toContain('consumeBudget("hr-document-upload"');
  });

  it("pre-guards on Content-Length AND checks the real size after parsing", () => {
    expect(src).toContain('request.headers.get("content-length")');
    expect(src).toContain("CONTENT_LENGTH_CEILING");
    // The authoritative check. Content-Length can be absent or a lie, so the
    // pre-guard alone would be no cap at all.
    expect(src).toContain("file.size > MAX_DOCUMENT_BYTES");
  });

  it("validates the content-type against the allow-list", () => {
    expect(src).toContain("extensionForMime(type, ALLOWED_DOCUMENT_MIME)");
  });

  it("never trusts the supplied filename: the path comes from safeDocPath", () => {
    expect(src).toContain("safeDocPath(");
    expect(src).toContain("newPathToken()");
  });

  it("proves the staff member belongs to THIS practice before writing bytes", () => {
    expect(src).toContain("getStaff(staffId, client.id)");
    expect(src.indexOf("getStaff(staffId, client.id)")).toBeLessThan(
      src.indexOf("putStaffDocObject("),
    );
  });

  it("removes the object when the metadata write fails, leaving no orphan", () => {
    expect(src).toContain("removeStaffDocObject(path)");
  });

  it("answers an honest failure on a read error, never an empty vault", () => {
    expect(src).toContain('error: "read-failed"');
    expect(src).toContain("ready: false");
  });
});

describe("the signed-URL route is the tenancy template, with a tested guard", () => {
  const src = source(DOCUMENT_URL);

  it("uses the PURE prefix guard rather than an inline startsWith", () => {
    // The onboarding original does this check inline, so it has no test. This one
    // calls a function that does (documents.test.ts), including the case an inline
    // client-slug check would miss: a path in the onboarding bucket.
    expect(src).toContain("isWithinStaffDocPrefix(path, client.slug)");
  });

  it("mints a SHORT-LIVED url: 120 seconds, matching the onboarding precedent", () => {
    expect(src).toContain("const SIGNED_URL_TTL_SECONDS = 120");
    expect(src).toContain("signStaffDocUrl(path, SIGNED_URL_TTL_SECONDS)");
  });

  it("never mints a public url", () => {
    // A public URL is never minted anywhere in this codebase and this route must not
    // be the first place it is. Matched as a CALL, not as a mention, so the route may
    // still name it in a comment explaining why it does not use it.
    expect(src).not.toMatch(/getPublicUrl\s*\(/);
  });
});

describe("publishing a policy is owner-level, and versions are never rewritten", () => {
  const src = source(POLICY);

  it("adds requireOwnerRole on top of the approver-level read", () => {
    expect(src).toContain("requireOwnerRole(auth)");
    // ...and it applies to the write, not the read: the GET must stay reachable by
    // the practice manager, who is the person chasing outstanding signatures.
    expect(src.indexOf("requireOwnerRole(auth)")).toBeGreaterThan(src.indexOf("export async function POST"));
  });

  it("refuses to publish while the kill switch is off", () => {
    expect(src).toContain('isSystemEnabled(client.id, ESIGN_SYSTEM_SLUG)');
    expect(src).toContain('const ESIGN_SYSTEM_SLUG = "staff-esign"');
  });

  it("only accepts a PDF as a policy", () => {
    expect(src).toContain("extensionForMime(type, ALLOWED_POLICY_MIME)");
  });

  it("allocates the version from what is published, and never updates one in place", () => {
    expect(src).toContain("nextPolicyVersion(existing.policies, slug)");
    expect(src).toContain("retireEarlierVersions(");
  });

  it("returns signature SUMMARIES, never the signature value", () => {
    // A drawn signature is a heavy, identifying image; a management list has no
    // business re-serving it. The FP17 discipline.
    expect(src).toContain("toSignatureSummary");
  });
});

// ===========================================================================
// THE ONE THAT MATTERS MOST.
// ===========================================================================
describe("the signer of a policy comes from the SESSION, and nowhere else", () => {
  const src = source(SIGN);

  it("resolves the staff record from the authenticated user", () => {
    expect(src).toContain("findStaffByAppUser(client.id, auth.id)");
  });

  it("NEVER reads a staff id from the request body or the query string", () => {
    // A route that accepted a body-supplied signer would let anybody sign anything
    // in somebody else's name, and the feature would be producing FALSE records
    // rather than no records. There is no such parameter, and there must not be.
    expect(src).not.toMatch(/body\.staffId/);
    expect(src).not.toMatch(/searchParams\.get\(\s*"staffId"/);
    expect(src).not.toMatch(/form\.get\(\s*"staffId"/);
  });

  it("takes the VERSION from the policy row, not from the caller", () => {
    expect(src).toContain("policyVersion: policy.version");
    expect(src).not.toMatch(/body\.policyVersion/);
  });

  it("stamps the time from the SERVER clock", () => {
    expect(src).toContain("const nowIso = new Date().toISOString()");
    expect(src).toContain("signedAt: nowIso");
    expect(src).not.toMatch(/body\.signedAt/);
  });

  it("FAILS CLOSED when sign-in is not configured", () => {
    // Recording an attestation with no identity behind it is worse than recording
    // nothing: it would look like evidence and be none.
    expect(src).toContain("authEnforced()");
    expect(src).toContain("503");
  });

  it("refuses to sign a withdrawn version, using the SAME rule that decides what to offer", () => {
    // Not `if (policy.retiredAt)`: retiredAt can be a FUTURE instant (publishing a
    // version effective next month retires its predecessor next month), and a
    // truthiness check here would refuse a signature on the only version the
    // signatures tab is showing. The behavioural proof is in sign-route.test.ts.
    expect(src).toContain("policyWithdrawn(policy,");
    expect(src).not.toMatch(/if\s*\(\s*policy\.retiredAt\s*\)/);
  });

  it("stores the IP hashed, never raw", () => {
    expect(src).toContain("ipHash: hashIp(");
    expect(src).not.toMatch(/ipAddress|rawIp|ip:\s*clientIp/);
  });

  it("answers with the method and the time, never the signature value back", () => {
    expect(src).toContain("method: stored.signature.method");
    expect(src).not.toContain("stored.signature.value");
  });
});

describe("the self-service seam is CLOSED, and what replaced the module gate holds", () => {
  // The seam used to be documented as a known limitation: the sign route carried a
  // "staff-hr" gate that refused the clinician and the staff role — the two people
  // the feature is for. The integration phase removed it and recorded the route as a
  // `kind: "self-service"` exemption instead. Everything below is what now stands in
  // the gate's place; if any one of them stops being true, the route is open rather
  // than self-service, and it should fail here first.

  it("the signer is resolved from the session, and no staff id is read from the request", () => {
    const src = source(SIGN);
    expect(src).toContain("findStaffByAppUser(client.id, auth.id)");
    // The body is parsed for the client slug and the signature; a staffId in it
    // would be somebody else's record, which is the entire risk of a route with no
    // role guard on it.
    expect(src).not.toMatch(/body\.staffId|searchParams\.get\("staffId"\)/);
  });

  it("it still fails closed when sign-in is not configured", () => {
    // The reason a self-service write may go unguarded by a role at all: with no
    // login it records nothing, rather than an attestation with no identity behind it.
    expect(source(SIGN)).toContain("authEnforced()");
  });

  it("and the mechanical fact that forced the seam is still true", () => {
    // "my-work" is held by BOTH new roles, so a gate naming it would have compiled,
    // read as a lock and done nothing. That is why the answer was no gate plus a
    // proof, and not a different gate.
    // NARROWED to the fact this test actually rests on. It used to snapshot the
    // WHOLE of STAFF_SLUGS, which made it fire on W1-E/2 (the coordinator's ruling
    // of 3 Sep 2026 adding "co-pilot" for every clearance) — a change with nothing
    // to do with HR, on a route this lane never touched. A test that pins more
    // than its own claim reports other people's decisions as its own regressions.
    //
    // What the seam argument needs is the two lines below: "my-work" is held by
    // BOTH new roles, so a gate naming it would have compiled, read as a lock and
    // done nothing. That is still exactly true, and the set membership is pinned
    // where it belongs, in src/lib/nav.staff.test.ts.
    expect(STAFF_SLUGS.has("my-work")).toBe(true);
    expect(canRoleAccessModule("client_clinician", "my-work")).toBe(true);
    expect(canRoleAccessModule("client_staff", "my-work")).toBe(true);
    // ...while "staff-hr" — the gate that was there — refuses them both, which is
    // exactly why it had to come off this one route and stay on the other three.
    expect(canRoleAccessModule("client_clinician", "staff-hr")).toBe(false);
    expect(canRoleAccessModule("client_staff", "staff-hr")).toBe(false);
  });
});
