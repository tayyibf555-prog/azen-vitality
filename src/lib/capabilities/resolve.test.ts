import { describe, it, expect } from "vitest";
import type { Role } from "@/lib/types";
import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  DESTRUCTIVE_CAPABILITIES,
  LOCKED_CAPABILITIES,
  isCapability,
  isDestructive,
  type Capability,
} from "./keys";
import { ALL_ROLES, ROLE_DEFAULTS, safeDefaults } from "./defaults";
import { capabilitySource, resolveCapabilities } from "./resolve";

// ===========================================================================
// THE PURE RESOLVER.
//
// Everything the enforcement layer believes about a person comes out of this
// function, so the properties below are stated as properties rather than as
// examples: identity, exact deltas, deny-by-default on unknowns, locked keys,
// purity, and a floor so a gutted catalog cannot make the file pass vacuously.
// ===========================================================================

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** The symmetric difference of two sets, sorted. */
function symmetricDifference(a: Iterable<string>, b: Iterable<string>): string[] {
  const A = new Set(a);
  const B = new Set(b);
  return sorted([...[...A].filter((x) => !B.has(x)), ...[...B].filter((x) => !A.has(x))]);
}

/** A key this role holds by default, for revoke tests. */
function heldBy(role: Role): Capability {
  const key = [...ROLE_DEFAULTS[role]].find((k) => !LOCKED_CAPABILITIES.has(k));
  if (!key) throw new Error(`${role} holds no unlocked capability, so the test below proves nothing`);
  return key;
}

/** A key this role does NOT hold by default, for grant tests. Null for a role that holds everything. */
function notHeldBy(role: Role): Capability | null {
  return CAPABILITY_KEYS.find((k) => !ROLE_DEFAULTS[role].has(k) && !LOCKED_CAPABILITIES.has(k)) ?? null;
}

/** The roles a GRANT test can actually be run against. */
const ROLES_MISSING_SOMETHING = ALL_ROLES.filter((r) => notHeldBy(r) !== null);

describe("1. identity — no overrides means the role, exactly", () => {
  it.each(ALL_ROLES)("%s with no overrides resolves to its role defaults", (role) => {
    expect(sorted(resolveCapabilities(role, []))).toEqual(sorted(ROLE_DEFAULTS[role]));
  });

  it("which is what makes shipping the table inert", () => {
    // Stated on its own because it is the claim the whole feature rests on: until
    // an owner ticks a box, nobody's answer changes.
    for (const role of ALL_ROLES) {
      expect(symmetricDifference(resolveCapabilities(role, []), ROLE_DEFAULTS[role])).toEqual([]);
    }
  });
});

describe("2. one override moves exactly one key", () => {
  it("the owner and the agency admin hold everything, so they are not grant-testable", () => {
    // Stated rather than silently skipped: the GRANT case below runs on the three
    // roles that are missing something, and this is why it is three and not five.
    expect(notHeldBy("client_owner")).toBeNull();
    expect(notHeldBy("agency_admin")).toBeNull();
    expect(ROLES_MISSING_SOMETHING).toHaveLength(3);
  });

  it.each(ROLES_MISSING_SOMETHING)("%s: a GRANT adds precisely that key and nothing else", (role) => {
    const key = notHeldBy(role)!;
    const after = resolveCapabilities(role, [{ capability: key, granted: true }]);
    // The SYMMETRIC DIFFERENCE, not mere membership: an implementation that
    // granted the key and dropped an unrelated one would pass a membership check.
    expect(symmetricDifference(after, ROLE_DEFAULTS[role])).toEqual([key]);
    expect(after.has(key)).toBe(true);
  });

  it.each(ALL_ROLES.filter((r) => ROLE_DEFAULTS[r].size > 0))(
    "%s: a REVOKE removes precisely that key and nothing else",
    (role) => {
      const key = heldBy(role);
      const after = resolveCapabilities(role, [{ capability: key, granted: false }]);
      expect(symmetricDifference(after, ROLE_DEFAULTS[role])).toEqual([key]);
      expect(after.has(key)).toBe(false);
    },
  );

  it("the last override for a key wins", () => {
    const key = notHeldBy("client_staff")!;
    const after = resolveCapabilities("client_staff", [
      { capability: key, granted: true },
      { capability: key, granted: false },
    ]);
    expect(after.has(key)).toBe(false);
  });
});

describe("3. an unknown capability is ignored, never granted", () => {
  const junk = [
    "money.payment.delete", // the key that has no enforcement point anywhere
    "diary.appointment.MOVE", // right key, wrong case
    "clinical.chart.write ", // trailing space
    "",
    "*",
  ];

  it.each(junk)("%j never appears in the resolved set", (capability) => {
    expect(isCapability(capability)).toBe(false);
    const after = resolveCapabilities("client_staff", [{ capability, granted: true }]);
    expect([...after]).not.toContain(capability);
    // And it changed nothing at all.
    expect(symmetricDifference(after, ROLE_DEFAULTS.client_staff)).toEqual([]);
  });

  it("deny-by-default is the opposite of the nav, deliberately", () => {
    // canRoleAccessModule returns TRUE for a slug it does not recognise, which is
    // what made the clinician role dangerous to add. This layer must never do that.
    const after = resolveCapabilities("client_owner", [{ capability: "not.a.capability", granted: true }]);
    expect(after.has("not.a.capability" as Capability)).toBe(false);
  });

  it("a malformed override row cannot crash the resolver", () => {
    const rows = [null, undefined, 42, { granted: true }] as unknown as Array<{
      capability: string;
      granted: boolean;
    }>;
    expect(() => resolveCapabilities("client_owner", rows)).not.toThrow();
  });
});

describe("4. a LOCKED key can be neither granted nor revoked", () => {
  it("there is at least one, and it is the one that guards this very screen", () => {
    expect(LOCKED_CAPABILITIES.has("security.capability.manage")).toBe(true);
    expect(LOCKED_CAPABILITIES.size).toBeGreaterThanOrEqual(1);
  });

  it.each([...LOCKED_CAPABILITIES])("%s cannot be granted to a role that lacks it", (key) => {
    const lacking = ALL_ROLES.filter((r) => !ROLE_DEFAULTS[r].has(key as Capability));
    // Guards the guard: if every role held it, this loop would assert nothing.
    expect(lacking.length).toBeGreaterThan(0);
    for (const role of lacking) {
      const after = resolveCapabilities(role, [{ capability: key, granted: true }]);
      expect(after.has(key as Capability)).toBe(false);
    }
  });

  it.each([...LOCKED_CAPABILITIES])("%s cannot be revoked from a role that holds it", (key) => {
    const holding = ALL_ROLES.filter((r) => ROLE_DEFAULTS[r].has(key as Capability));
    expect(holding.length).toBeGreaterThan(0);
    for (const role of holding) {
      const after = resolveCapabilities(role, [{ capability: key, granted: false }]);
      expect(after.has(key as Capability)).toBe(true);
    }
  });

  it("closes the escalation it exists for", () => {
    // A coordinator handed the admin key would grant themselves everything else.
    // The only way to hold it is to BE an owner.
    const escalated = resolveCapabilities("client_coordinator", [
      { capability: "security.capability.manage", granted: true },
    ]);
    expect(escalated.has("security.capability.manage")).toBe(false);
    expect(ROLE_DEFAULTS.client_owner.has("security.capability.manage")).toBe(true);
  });
});

describe("5. purity", () => {
  it("two identical calls return equal sets", () => {
    const a = resolveCapabilities("client_coordinator", [{ capability: "reports.run", granted: true }]);
    const b = resolveCapabilities("client_coordinator", [{ capability: "reports.run", granted: true }]);
    expect(sorted(a)).toEqual(sorted(b));
  });

  it("mutating the returned set does not mutate ROLE_DEFAULTS", () => {
    const before = sorted(ROLE_DEFAULTS.client_owner);
    const result = resolveCapabilities("client_owner", []) as Set<Capability>;
    result.clear();
    result.add("patient.note.write");
    expect(sorted(ROLE_DEFAULTS.client_owner)).toEqual(before);
    // ...and a second resolve is unaffected by the first's vandalism.
    expect(sorted(resolveCapabilities("client_owner", []))).toEqual(before);
  });

  it("resolving one role does not disturb another", () => {
    const staffBefore = sorted(ROLE_DEFAULTS.client_staff);
    resolveCapabilities("client_owner", [{ capability: "patient.note.write", granted: false }]);
    expect(sorted(ROLE_DEFAULTS.client_staff)).toEqual(staffBefore);
  });
});

describe("6. capabilitySource distinguishes inherited from decided", () => {
  it("a key with no row reads as inherited from the role", () => {
    expect(capabilitySource("client_owner", "reports.run", [])).toBe("role");
    expect(capabilitySource("client_staff", "reports.run", [])).toBe("role");
  });

  it("an explicit grant and an explicit revoke each read as themselves", () => {
    expect(
      capabilitySource("client_staff", "reports.run", [{ capability: "reports.run", granted: true }]),
    ).toBe("granted");
    expect(
      capabilitySource("client_owner", "reports.run", [{ capability: "reports.run", granted: false }]),
    ).toBe("revoked");
  });

  it("a row that merely agrees with the role is not an override", () => {
    // The grid must not show a blue "changed" dot on a cell nobody changed the
    // meaning of, or the owner cannot see at a glance what they actually decided.
    expect(
      capabilitySource("client_owner", "reports.run", [{ capability: "reports.run", granted: true }]),
    ).toBe("role");
  });

  it("a locked key always reads as inherited, because an override on it is inert", () => {
    expect(
      capabilitySource("client_coordinator", "security.capability.manage", [
        { capability: "security.capability.manage", granted: true },
      ]),
    ).toBe("role");
  });
});

describe("7. safeDefaults is what an unreadable overlay falls back to", () => {
  it.each(ALL_ROLES)("%s keeps every read and loses every write", (role) => {
    const safe = safeDefaults(role);
    for (const key of safe) {
      expect(ROLE_DEFAULTS[role].has(key)).toBe(true);
      expect(isDestructive(key)).toBe(false);
    }
    for (const key of ROLE_DEFAULTS[role]) {
      if (!isDestructive(key)) expect(safe.has(key)).toBe(true);
    }
  });

  it("is strictly smaller than the defaults for a role that can write", () => {
    // Guards the guard: if nothing were marked destructive, safeDefaults would
    // equal the defaults and the fail-closed posture would be decorative.
    expect(safeDefaults("client_owner").size).toBeLessThan(ROLE_DEFAULTS.client_owner.size);
    expect(safeDefaults("client_staff").size).toBeLessThan(ROLE_DEFAULTS.client_staff.size);
  });
});

describe("8. anti-vacuity — the catalog is real", () => {
  it("has a substantial number of keys", () => {
    // v1 deliberately contains ONLY keys that are enforced (see keys.ts). The HR
    // lane's keys join when their routes swap from the interim role helpers to
    // requireCapability, at which point this floor should rise.
    expect(CAPABILITIES.length).toBeGreaterThanOrEqual(24);
  });

  it("every key is unique, non-empty and dotted", () => {
    expect(new Set(CAPABILITY_KEYS).size).toBe(CAPABILITY_KEYS.length);
    for (const key of CAPABILITY_KEYS) expect(key).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it("most keys are destructive, and at least a few are not", () => {
    expect(DESTRUCTIVE_CAPABILITIES.size).toBeGreaterThanOrEqual(15);
    expect(CAPABILITIES.filter((c) => !c.destructive).length).toBeGreaterThanOrEqual(3);
  });

  it("an unrecognised key counts as destructive (fail closed)", () => {
    expect(isDestructive("nobody.knows.this")).toBe(true);
  });

  it("every key names somewhere it is enforced", () => {
    // A capability with no enforcement point is the failure mode this whole
    // catalog exists to prevent: the owner ticks it and believes it.
    for (const def of CAPABILITIES) {
      const places = def.enforcedAt.length + (def.enforcedIn?.length ?? 0);
      expect(places, `${def.key} names no enforcement point`).toBeGreaterThan(0);
    }
  });

  it("every key is held by at least one role", () => {
    for (const key of CAPABILITY_KEYS) {
      const holders = ALL_ROLES.filter((r) => ROLE_DEFAULTS[r].has(key));
      expect(holders.length, `${key} is held by nobody`).toBeGreaterThan(0);
    }
  });

  it("the universal keys are named, and there are only three", () => {
    // A capability every role holds decides nothing on its own, so there had
    // better be a reason. There are exactly three, and all three are self-service
    // or scope-decided-elsewhere. A fourth has to be argued for HERE.
    //
    //   people.absence.request  everybody who works here may ask for time off,
    //   people.clock.self       and may clock themselves in.
    //   system.copilot.ask      everybody may ASK the co-pilot (Dental OS W1-E, on
    //                           the coordinator's ruling of 3 Sep 2026). This one
    //                           is the reason the sentence above says "decides
    //                           nothing on its own" and means it: holding it gets
    //                           you a turn, and `copilotAccessForRole` decides
    //                           per-turn, from the SESSION, what that turn may
    //                           reach — six read tools and no act for a clinician,
    //                           ONE tool about themselves for a member of staff.
    //                           A universal key whose ANSWER is role-scoped is a
    //                           different animal from a universal key that grants
    //                           a universal act, and the difference is enforced in
    //                           src/lib/copilot/clearance.ts, not here.
    //
    // All three remain useful as REVOKES — an owner can take any of them away
    // from one named person on People & logins.
    const universal = CAPABILITY_KEYS.filter((k) => ALL_ROLES.every((r) => ROLE_DEFAULTS[r].has(k)));
    expect(universal.sort()).toEqual([
      "people.absence.request",
      "people.clock.self",
      "system.copilot.ask",
    ]);
  });
});
