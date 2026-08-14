import { describe, it, expect } from "vitest";
import type { Role } from "@/lib/types";
import { CAPABILITY_KEYS, LOCKED_CAPABILITIES, type Capability } from "./keys";
import { ALL_ROLES, ROLE_DEFAULTS } from "./defaults";
import {
  CAPABILITY_ADMIN_ROLES,
  REFUSAL_MESSAGE,
  canAdministerCapabilities,
  canEditCapability,
  canResetCapability,
  isProtectedSubject,
  type AdminActor,
  type AdminSubject,
} from "./admin-rules";

// ===========================================================================
// THE ESCALATION RULES.
//
// The question every one of these answers is the same: can somebody use this
// screen to end up with more than they started with? The answer has to be no,
// three different ways, and "owner-only" alone is not one of them — it is the
// v1 posture, and these rules are what make the coordinator path safe to add
// later without redesigning anything.
// ===========================================================================

function actor(role: Role, id = "actor-1"): AdminActor {
  return { id, role, capabilities: ROLE_DEFAULTS[role] };
}

function subject(role: Role, id = "subject-1"): AdminSubject {
  return { id, role };
}

/** A real, unlocked key the owner holds — the normal happy-path argument. */
const EDITABLE: Capability = CAPABILITY_KEYS.find(
  (k) => !LOCKED_CAPABILITIES.has(k) && ROLE_DEFAULTS.client_owner.has(k),
)!;

describe("1. only an owner-level role may administer", () => {
  it.each(ALL_ROLES)("%s", (role) => {
    const expected = role === "agency_admin" || role === "client_owner";
    expect(canAdministerCapabilities(role)).toBe(expected);
  });

  it("the admin list is exactly the owner pair", () => {
    expect([...CAPABILITY_ADMIN_ROLES].sort()).toEqual(["agency_admin", "client_owner"]);
  });

  it.each(["client_coordinator", "client_clinician", "client_staff"] as const)(
    "%s is refused every edit, whatever the arguments",
    (role) => {
      const d = canEditCapability(actor(role), subject("client_staff"), EDITABLE, true);
      expect(d.ok).toBe(false);
      expect(d.refusal).toBe("not-an-administrator");
    },
  );
});

describe("2. nobody edits their own row", () => {
  it("even an owner", () => {
    const me = actor("client_owner", "same-id");
    const d = canEditCapability(me, subject("client_coordinator", "same-id"), EDITABLE, true);
    expect(d.refusal).toBe("no-self-edit");
  });

  it("and the same rule covers a reset", () => {
    const me = actor("client_owner", "same-id");
    expect(canResetCapability(me, subject("client_staff", "same-id"), EDITABLE).refusal).toBe("no-self-edit");
  });

  it("keyed on IDENTITY, not on role — two owners are two people", () => {
    // The rule mirrors absence/rules.ts (nobody approves their own holiday). It
    // has to key on the id, or the second owner could never fix the first's row.
    const jawad = actor("client_owner", "owner-jawad");
    const murtaza = subject("client_coordinator", "user-murtaza");
    expect(canEditCapability(jawad, murtaza, EDITABLE, true).ok).toBe(true);
  });
});

describe("3. nobody edits upward or sideways", () => {
  it.each(["client_owner", "agency_admin"] as const)("an owner may not edit %s's row", (role) => {
    const d = canEditCapability(actor("client_owner"), subject(role, "someone-else"), EDITABLE, true);
    expect(d.refusal).toBe("subject-is-protected");
  });

  it("but may edit a coordinator, a clinician and a staff row", () => {
    for (const role of ["client_coordinator", "client_clinician", "client_staff"] as const) {
      expect(isProtectedSubject(role)).toBe(false);
      expect(canEditCapability(actor("client_owner"), subject(role, "x"), EDITABLE, true).ok).toBe(true);
    }
  });

  it("agency_admin rows are additionally blocked by the SCHEMA, not only by this rule", () => {
    // app_user.client_id is null for agency_admin and a null cannot satisfy the
    // composite tenant FK in 0072, so no override row for them can exist at all.
    // This assertion records that the rule and the schema agree.
    expect(isProtectedSubject("agency_admin")).toBe(true);
  });
});

describe("4. no privilege amplification", () => {
  it("an actor may not grant a capability they do not hold", () => {
    const weak: AdminActor = { id: "a", role: "client_owner", capabilities: new Set<Capability>() };
    const d = canEditCapability(weak, subject("client_staff", "b"), EDITABLE, true);
    expect(d.refusal).toBe("actor-lacks-capability");
  });

  it("but MAY revoke one they do not hold", () => {
    // Revoking is not an escalation, and refusing it would stop an owner taking
    // away a clinical write they personally never use.
    const weak: AdminActor = { id: "a", role: "client_owner", capabilities: new Set<Capability>() };
    expect(canEditCapability(weak, subject("client_staff", "b"), EDITABLE, false).ok).toBe(true);
  });

  it("is a no-op for a real owner, who holds everything", () => {
    for (const key of CAPABILITY_KEYS) {
      if (LOCKED_CAPABILITIES.has(key)) continue;
      expect(canEditCapability(actor("client_owner"), subject("client_staff", "b"), key, true).ok).toBe(true);
    }
  });
});

describe("5. the locked key can never travel through this surface", () => {
  it.each([...LOCKED_CAPABILITIES])("%s is refused as a grant", (key) => {
    const d = canEditCapability(actor("client_owner"), subject("client_coordinator", "b"), key, true);
    expect(d.refusal).toBe("capability-is-locked");
  });

  it.each([...LOCKED_CAPABILITIES])("%s is refused as a revoke and as a reset", (key) => {
    expect(canEditCapability(actor("client_owner"), subject("client_coordinator", "b"), key, false).refusal).toBe(
      "capability-is-locked",
    );
    expect(canResetCapability(actor("client_owner"), subject("client_coordinator", "b"), key).refusal).toBe(
      "capability-is-locked",
    );
  });

  it("refused BEFORE the amplification check, so the message is the true reason", () => {
    const weak: AdminActor = { id: "a", role: "client_owner", capabilities: new Set<Capability>() };
    expect(canEditCapability(weak, subject("client_staff", "b"), "security.capability.manage", true).refusal).toBe(
      "capability-is-locked",
    );
  });
});

describe("6. an unknown capability is refused, not silently written", () => {
  it.each(["money.payment.delete", "", "clinical.chart.WRITE", "*"])("%j", (key) => {
    expect(canEditCapability(actor("client_owner"), subject("client_staff", "b"), key, true).refusal).toBe(
      "unknown-capability",
    );
    expect(canResetCapability(actor("client_owner"), subject("client_staff", "b"), key).refusal).toBe(
      "unknown-capability",
    );
  });
});

describe("7. every refusal has a sentence the owner can act on", () => {
  it("no code is missing its message, and none is a bare 'forbidden'", () => {
    const codes = [
      "not-an-administrator",
      "no-self-edit",
      "subject-is-protected",
      "unknown-capability",
      "capability-is-locked",
      "actor-lacks-capability",
    ] as const;
    for (const code of codes) {
      const message = REFUSAL_MESSAGE[code];
      expect(message, code).toBeTypeOf("string");
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).not.toBe("forbidden");
    }
  });
});
