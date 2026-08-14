import { describe, it, expect } from "vitest";
import type { Role } from "@/lib/types";
import type { LinkableStaff } from "./types";
import {
  INVITABLE_ROLES,
  ROLE_BLURBS,
  ROLE_LABELS,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  authStatusFrom,
  buildSetPasswordLink,
  canChangeRole,
  canDeactivate,
  canLinkStaff,
  canReactivate,
  friendlyLinkError,
  inviteDeliveryMode,
  isInvitableRole,
  linkableFor,
  normaliseEmail,
  parseSetPasswordEntry,
  validateInvite,
  validateNewPassword,
} from "./rules";

// ===========================================================================
// The rules that stop a practice locking itself out of its own platform, and the
// rules that stop an owner handing out access they do not have.
// ===========================================================================

const OWNER = { id: "u-owner", role: "client_owner" as Role };
const OTHER_OWNER = { id: "u-owner-2", role: "client_owner" as Role, authStatus: "active" as const };
const MANAGER = { id: "u-manager", role: "client_coordinator" as Role, authStatus: "active" as const };

describe("the invitable roles", () => {
  it("never includes agency_admin", () => {
    // THE HEADLINE. agency_admin carries a null client_id, which canAccessClient
    // reads as "every practice on the platform". An owner able to grant it could
    // hand somebody a login into every other practice Azen runs.
    expect(INVITABLE_ROLES).not.toContain("agency_admin");
    expect(isInvitableRole("agency_admin")).toBe(false);
  });

  it("is exactly the four client roles", () => {
    expect([...INVITABLE_ROLES].sort()).toEqual([
      "client_clinician",
      "client_coordinator",
      "client_owner",
      "client_staff",
    ]);
  });

  it("labels and blurbs cover every invitable role (the form cannot render a blank)", () => {
    for (const role of INVITABLE_ROLES) {
      expect(ROLE_LABELS[role]?.length ?? 0).toBeGreaterThan(0);
      expect(ROLE_BLURBS[role]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("rejects an unknown role string", () => {
    expect(isInvitableRole("superuser")).toBe(false);
    expect(isInvitableRole("")).toBe(false);
  });
});

describe("normaliseEmail", () => {
  it("lower-cases and trims, because getSessionUser looks the profile up lower-cased", () => {
    expect(normaliseEmail("  Blerta@VitalityDental.co.uk ")).toBe("blerta@vitalitydental.co.uk");
  });

  it("refuses anything that is not an email", () => {
    for (const bad of ["", "   ", "blerta", "blerta@", "@vitality.co.uk", "a b@c.co.uk", "a@b", "a@b.c", null, 7]) {
      expect(normaliseEmail(bad as unknown)).toBeNull();
    }
  });

  it("refuses two @ signs", () => {
    expect(normaliseEmail("a@b@c.co.uk")).toBeNull();
  });
});

describe("validateInvite", () => {
  it("accepts a well formed invite and returns the canonical values", () => {
    const result = validateInvite({ email: " Blerta@Vitality.co.uk ", name: "  Blerta   Hoxha ", role: "client_coordinator" });
    expect(result).toEqual({
      ok: true,
      value: { email: "blerta@vitality.co.uk", name: "Blerta Hoxha", role: "client_coordinator" },
    });
  });

  it("refuses an invite that tries to create an agency admin", () => {
    const result = validateInvite({ email: "a@b.co.uk", name: "A B", role: "agency_admin" });
    expect(result.ok).toBe(false);
  });

  it("refuses a missing name", () => {
    expect(validateInvite({ email: "a@b.co.uk", name: " ", role: "client_staff" }).ok).toBe(false);
  });

  it("refuses a name over 120 characters", () => {
    expect(validateInvite({ email: "a@b.co.uk", name: "x".repeat(121), role: "client_staff" }).ok).toBe(false);
  });
});

describe("canDeactivate", () => {
  it("refuses self-deactivation, even for an owner with colleagues", () => {
    const decision = canDeactivate({
      actor: OWNER,
      target: { id: OWNER.id, role: "client_owner", authStatus: "active" },
      activeOwnerCount: 4,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/your own login/i);
  });

  it("refuses the LAST active owner", () => {
    const decision = canDeactivate({ actor: OWNER, target: OTHER_OWNER, activeOwnerCount: 1 });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/last owner/i);
  });

  it("allows an owner to be deactivated when another active owner remains", () => {
    expect(canDeactivate({ actor: OWNER, target: OTHER_OWNER, activeOwnerCount: 2 })).toEqual({ ok: true });
  });

  it("allows a manager to be deactivated regardless of the owner count", () => {
    expect(canDeactivate({ actor: OWNER, target: MANAGER, activeOwnerCount: 1 })).toEqual({ ok: true });
  });

  it("refuses to touch an agency admin", () => {
    const decision = canDeactivate({
      actor: OWNER,
      target: { id: "u-azen", role: "agency_admin", authStatus: "active" },
      activeOwnerCount: 3,
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses when there is no login behind the profile", () => {
    const decision = canDeactivate({
      actor: OWNER,
      target: { ...MANAGER, authStatus: "missing" },
      activeOwnerCount: 3,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/nothing to deactivate/i);
  });

  it("refuses when the login directory could not be read (fails LOUD, not open)", () => {
    const decision = canDeactivate({
      actor: OWNER,
      target: { ...MANAGER, authStatus: "unknown" },
      activeOwnerCount: 3,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/could not be read/i);
  });

  it("tells you it is you before it tells you it is the last owner", () => {
    // Both are true here. The useful sentence is the first one.
    const decision = canDeactivate({
      actor: OWNER,
      target: { id: OWNER.id, role: "client_owner", authStatus: "active" },
      activeOwnerCount: 1,
    });
    expect(decision.ok === false && decision.error).toMatch(/your own login/i);
  });
});

describe("canReactivate", () => {
  it("switches a deactivated person back on", () => {
    expect(canReactivate({ target: { ...MANAGER, authStatus: "deactivated" } })).toEqual({ ok: true });
  });

  it("refuses when there is no login to switch on", () => {
    const decision = canReactivate({ target: { ...MANAGER, authStatus: "missing" } });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/send them an invite/i);
  });

  it("refuses an agency admin", () => {
    expect(canReactivate({ target: { id: "u-azen", role: "agency_admin", authStatus: "deactivated" } }).ok).toBe(false);
  });
});

describe("canChangeRole", () => {
  it("refuses to promote anybody to agency_admin", () => {
    const decision = canChangeRole({
      actor: OWNER,
      target: MANAGER,
      nextRole: "agency_admin",
      activeOwnerCount: 3,
    });
    expect(decision.ok).toBe(false);
  });

  it("refuses an unknown role", () => {
    expect(canChangeRole({ actor: OWNER, target: MANAGER, nextRole: "root", activeOwnerCount: 3 }).ok).toBe(false);
  });

  it("refuses changing your own access level", () => {
    const decision = canChangeRole({
      actor: OWNER,
      target: { id: OWNER.id, role: "client_owner", authStatus: "active" },
      nextRole: "client_staff",
      activeOwnerCount: 5,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/your own access level/i);
  });

  it("refuses demoting the last owner", () => {
    const decision = canChangeRole({
      actor: OWNER,
      target: OTHER_OWNER,
      nextRole: "client_coordinator",
      activeOwnerCount: 1,
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/last owner/i);
  });

  it("allows demoting an owner while another active owner remains", () => {
    expect(
      canChangeRole({ actor: OWNER, target: OTHER_OWNER, nextRole: "client_coordinator", activeOwnerCount: 2 }),
    ).toEqual({ ok: true });
  });

  it("allows PROMOTING to owner even when there is only one owner today", () => {
    // The count guard must not block the very action that fixes a single-owner
    // practice, which is the mistake a naive "activeOwnerCount <= 1" check makes.
    expect(
      canChangeRole({ actor: OWNER, target: MANAGER, nextRole: "client_owner", activeOwnerCount: 1 }),
    ).toEqual({ ok: true });
  });

  it("refuses a no-op change", () => {
    expect(
      canChangeRole({ actor: OWNER, target: MANAGER, nextRole: "client_coordinator", activeOwnerCount: 3 }).ok,
    ).toBe(false);
  });

  it("refuses to re-role an agency admin", () => {
    expect(
      canChangeRole({
        actor: OWNER,
        target: { id: "u-azen", role: "agency_admin", authStatus: "active" },
        nextRole: "client_staff",
        activeOwnerCount: 3,
      }).ok,
    ).toBe(false);
  });
});

describe("link login -> staff record", () => {
  const staff = (over: Partial<LinkableStaff> = {}): LinkableStaff => ({
    id: "s1",
    name: "Blerta Hoxha",
    role: "Practice manager",
    siteId: "site-n15",
    appUserId: null,
    active: true,
    ...over,
  });

  it("links an active, unlinked staff record", () => {
    expect(
      canLinkStaff({ personId: "u1", clientId: "vitality", personClientId: "vitality", staff: staff() }),
    ).toEqual({ ok: true });
  });

  it("refuses a staff record that was not found in this practice", () => {
    const decision = canLinkStaff({ personId: "u1", clientId: "vitality", personClientId: "vitality", staff: null });
    expect(decision.ok).toBe(false);
  });

  it("refuses an archived staff record", () => {
    const decision = canLinkStaff({
      personId: "u1",
      clientId: "vitality",
      personClientId: "vitality",
      staff: staff({ active: false }),
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/archived/i);
  });

  it("refuses a login belonging to a different practice", () => {
    const decision = canLinkStaff({
      personId: "u1",
      clientId: "vitality",
      personClientId: "otherclient",
      staff: staff(),
    });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/different practice/i);
  });

  it("allows an agency admin (null client) to link on a practice's behalf", () => {
    expect(
      canLinkStaff({ personId: "u1", clientId: "vitality", personClientId: null, staff: staff() }),
    ).toEqual({ ok: true });
  });

  it("offers the unlinked rows plus the person's own current row, and nothing else", () => {
    const rows: LinkableStaff[] = [
      staff({ id: "free", appUserId: null }),
      staff({ id: "mine", appUserId: "u1" }),
      staff({ id: "theirs", appUserId: "u2" }),
      staff({ id: "archived", appUserId: null, active: false }),
    ];
    expect(linkableFor(rows, "u1").map((s) => s.id)).toEqual(["free", "mine"]);
  });

  it("turns the partial unique index violation into a sentence", () => {
    expect(friendlyLinkError({ code: "23505" })).toMatch(/already linked/i);
  });

  it("turns a missing column or table into an honest 'not set up yet'", () => {
    expect(friendlyLinkError({ code: "42703" })).toMatch(/not set up/i);
    expect(friendlyLinkError({ code: "42P01" })).toMatch(/not set up/i);
  });

  it("does NOT dress up an error it does not recognise", () => {
    // An unrecognised failure must surface as a failure, not as a tidy sentence
    // that implies the platform understood what went wrong.
    expect(friendlyLinkError({ code: "08006" })).toBeNull();
    expect(friendlyLinkError(null)).toBeNull();
    expect(friendlyLinkError(undefined)).toBeNull();
  });
});

describe("authStatusFrom", () => {
  const NOW = Date.parse("2026-08-14T12:00:00Z");

  it("says 'missing' when there is no Auth account behind the profile", () => {
    expect(authStatusFrom(null, NOW)).toBe("missing");
    expect(authStatusFrom(undefined, NOW)).toBe("missing");
  });

  it("says 'invited' for an account that has never signed in", () => {
    expect(authStatusFrom({ invited_at: "2026-08-14T09:00:00Z" }, NOW)).toBe("invited");
  });

  it("says 'active' once they have signed in", () => {
    expect(authStatusFrom({ last_sign_in_at: "2026-08-14T10:00:00Z" }, NOW)).toBe("active");
  });

  it("says 'deactivated' while the ban is in the future", () => {
    expect(
      authStatusFrom({ last_sign_in_at: "2026-08-01T10:00:00Z", banned_until: "2126-08-14T12:00:00Z" }, NOW),
    ).toBe("deactivated");
  });

  it("says 'active' again once the ban has expired", () => {
    expect(
      authStatusFrom({ last_sign_in_at: "2026-08-01T10:00:00Z", banned_until: "2026-08-13T12:00:00Z" }, NOW),
    ).toBe("active");
  });

  it("treats an unreadable banned_until as a live ban (safe direction)", () => {
    expect(authStatusFrom({ last_sign_in_at: "2026-08-01T10:00:00Z", banned_until: "not-a-date" }, NOW)).toBe(
      "deactivated",
    );
  });
});

describe("inviteDeliveryMode", () => {
  it("defaults to 'link', because Supabase's built-in mailer would silently not deliver", () => {
    expect(inviteDeliveryMode({})).toBe("link");
    expect(inviteDeliveryMode({ SUPABASE_SMTP_CONFIGURED: "" })).toBe("link");
    expect(inviteDeliveryMode({ SUPABASE_SMTP_CONFIGURED: "false" })).toBe("link");
    expect(inviteDeliveryMode({ SUPABASE_SMTP_CONFIGURED: "yes" })).toBe("link");
  });

  it("only an explicit true switches to letting Supabase send the email", () => {
    expect(inviteDeliveryMode({ SUPABASE_SMTP_CONFIGURED: "true" })).toBe("email");
  });
});

describe("buildSetPasswordLink", () => {
  it("points at OUR page carrying the hashed token, not at Supabase's verify endpoint", () => {
    const link = buildSetPasswordLink("abc123", "invite", "https://azen-vitality.vercel.app");
    expect(link).toBe("https://azen-vitality.vercel.app/set-password?token_hash=abc123&type=invite");
  });

  it("strips a trailing slash on the base", () => {
    expect(buildSetPasswordLink("t", "recovery", "https://x.dev/")).toBe(
      "https://x.dev/set-password?token_hash=t&type=recovery",
    );
  });

  it("falls back to a root-relative path when no absolute base is configured", () => {
    expect(buildSetPasswordLink("t", "invite", undefined)).toBe("/set-password?token_hash=t&type=invite");
    expect(buildSetPasswordLink("t", "invite", "localhost:3000")).toBe("/set-password?token_hash=t&type=invite");
  });

  it("url-encodes a token containing url-unsafe characters", () => {
    expect(buildSetPasswordLink("a+b/c=", "invite", "https://x.dev")).toContain("token_hash=a%2Bb%2Fc%3D");
  });
});

describe("parseSetPasswordEntry", () => {
  it("reads our own token_hash link", () => {
    expect(parseSetPasswordEntry("?token_hash=abc&type=invite", "")).toEqual({
      mode: "token_hash",
      tokenHash: "abc",
      type: "invite",
    });
  });

  it("accepts a recovery link (the re-send path uses one)", () => {
    expect(parseSetPasswordEntry("?token_hash=abc&type=recovery", "")).toEqual({
      mode: "token_hash",
      tokenHash: "abc",
      type: "recovery",
    });
  });

  it("defaults a token_hash with no type to invite", () => {
    expect(parseSetPasswordEntry("?token_hash=abc", "")).toEqual({
      mode: "token_hash",
      tokenHash: "abc",
      type: "invite",
    });
  });

  it("refuses a token_hash carrying a type we do not accept", () => {
    const entry = parseSetPasswordEntry("?token_hash=abc&type=phone_change", "");
    expect(entry.mode).toBe("error");
  });

  it("reads the FRAGMENT shape GoTrue's own redirect produces", () => {
    // The half that only exists in a browser: if the practice ever switches on
    // Supabase's default invite email, this is what the invitee arrives with.
    expect(
      parseSetPasswordEntry("", "#access_token=at&refresh_token=rt&type=invite&expires_in=3600"),
    ).toEqual({ mode: "session", accessToken: "at", refreshToken: "rt" });
  });

  it("ignores a fragment carrying only half a session", () => {
    expect(parseSetPasswordEntry("", "#access_token=at&type=invite").mode).toBe("none");
  });

  it("reports an expired link as expired, in words the invitee can act on", () => {
    const entry = parseSetPasswordEntry(
      "",
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired",
    );
    expect(entry.mode).toBe("error");
    expect(entry.mode === "error" && entry.error).toMatch(/expired/i);
  });

  it("reports a query-string error too (not every provider uses the fragment)", () => {
    expect(parseSetPasswordEntry("?error=server_error&error_description=boom", "").mode).toBe("error");
  });

  it("returns 'none' for a bare visit", () => {
    expect(parseSetPasswordEntry("", "")).toEqual({ mode: "none" });
    expect(parseSetPasswordEntry("?", "#")).toEqual({ mode: "none" });
  });

  it("prefers the error over a token that is also present", () => {
    expect(parseSetPasswordEntry("?token_hash=abc&type=invite&error_code=otp_expired", "").mode).toBe("error");
  });
});

describe("validateNewPassword", () => {
  const GOOD = "correct horse battery";

  it("accepts a long passphrase typed twice", () => {
    expect(validateNewPassword(GOOD, GOOD)).toEqual({ ok: true });
  });

  it("refuses anything shorter than the minimum", () => {
    const decision = validateNewPassword("short", "short");
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toContain(String(MIN_PASSWORD_LENGTH));
  });

  it("accepts exactly the minimum length", () => {
    const exact = "a".repeat(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword(exact, exact)).toEqual({ ok: true });
  });

  it("refuses more than bcrypt's 72 bytes, which GoTrue would reject anyway", () => {
    const long = "a".repeat(MAX_PASSWORD_LENGTH + 1);
    expect(validateNewPassword(long, long).ok).toBe(false);
  });

  it("refuses a whitespace-only password that is long enough to pass the length check", () => {
    const spaces = " ".repeat(MIN_PASSWORD_LENGTH + 4);
    expect(validateNewPassword(spaces, spaces).ok).toBe(false);
  });

  it("refuses a mismatched confirmation", () => {
    const decision = validateNewPassword(GOOD, `${GOOD}x`);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toMatch(/do not match/i);
  });
});
