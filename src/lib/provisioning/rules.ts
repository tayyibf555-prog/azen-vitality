import type { Role } from "@/lib/types";
import type { AuthStatus, InvitableRole, InviteDelivery, LinkableStaff } from "./types";

// ===========================================================================
// PEOPLE & LOGINS — every decision, as a pure function.
//
// No React, no database, no `Date.now()`, no `process.env` read that is not passed
// in as an argument. The same discipline as `absence/rules.ts` and
// `rota/generate.ts`, and for the same reason: a rule that reaches for the clock or
// the environment itself cannot be tested at a chosen moment or in a chosen
// deployment, and this repo has already paid for that lesson twice.
//
// WHY THIS FILE IS THE INTERESTING ONE. Provisioning is the first surface in the
// platform where a practice owner can take another person's access away, and where
// a slip locks the practice out of its own system. Two of these rules exist purely
// to make that impossible:
//
//   * nobody may deactivate or demote THEMSELVES  — the owner who clicks the wrong
//     row must not be able to remove the only account that can undo it;
//   * the LAST ACTIVE OWNER may be neither deactivated nor demoted — otherwise the
//     practice has a platform with no administrator and no way back in without Azen.
//
// Both are enforced here, in one place, and are asserted in rules.test.ts by
// mutation (break the rule, the named test goes red).
// ===========================================================================

/** A refusal carries the sentence the owner reads. There is no error-code lookup. */
export type Decision = { ok: true } | { ok: false; error: string };

const ALLOW: Decision = { ok: true };
const deny = (error: string): Decision => ({ ok: false, error });

/**
 * The roles a practice owner may hand out, in the order they read on screen.
 *
 * `agency_admin` IS NOT HERE AND MUST NEVER BE. Its `client_id` is null, which in
 * `canAccessClient` means "every client on the platform"; an owner able to grant it
 * would be able to grant a login into every other practice. Azen creates those in
 * SQL. `rules.test.ts` asserts the absence rather than trusting this comment.
 */
export const INVITABLE_ROLES: readonly InvitableRole[] = [
  "client_owner",
  "client_coordinator",
  "client_clinician",
  "client_staff",
] as const;

/** Human labels for the four, so the API and the UI cannot describe them differently. */
export const ROLE_LABELS: Record<InvitableRole, string> = {
  client_owner: "Owner",
  client_coordinator: "Practice manager",
  client_clinician: "Clinician",
  client_staff: "Staff",
};

/** What each role can reach, in one sentence, for the invite form. */
export const ROLE_BLURBS: Record<InvitableRole, string> = {
  client_owner: "Everything, including reports, system controls and this screen.",
  client_coordinator: "The day to day: diary, patients, rota, holiday and messaging.",
  client_clinician: "Their own diary and the patient record. No marketing or reports.",
  client_staff: "Their own work only: their rota, their holiday, their documents.",
};

export function isInvitableRole(role: string): role is InvitableRole {
  return (INVITABLE_ROLES as readonly string[]).includes(role);
}

/** The longest password GoTrue will accept (bcrypt works in bytes, and stops at 72). */
export const MAX_PASSWORD_LENGTH = 72;

/**
 * The shortest password this platform accepts.
 *
 * Higher than Supabase's own default of 6 on purpose: these logins reach a live
 * patient database. Length is the only requirement — no character-class rules,
 * which push people towards `Passw0rd!` and are worse in practice.
 */
export const MIN_PASSWORD_LENGTH = 12;

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** Deliberately conservative: one @, no spaces, a dot in the domain, sane lengths. */
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;

/**
 * The canonical form of an email, or null if it is not one.
 *
 * Lower-cased because `getSessionUser` resolves the profile with
 * `.eq("email", user.email.toLowerCase())`: a row stored as `Blerta@…` would
 * authenticate against Supabase perfectly and then resolve to no profile at all,
 * which presents to the user as the baffling "signed in, but not linked to a
 * practice" screen. Normalising at the point of creation is what stops that.
 */
export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

export interface InviteInput {
  email: unknown;
  name: unknown;
  role: unknown;
}

export interface InviteFields {
  email: string;
  name: string;
  role: InvitableRole;
}

export type InviteValidation = { ok: true; value: InviteFields } | { ok: false; error: string };

/** Validate an invite form. Every refusal is a sentence, because the owner reads it. */
export function validateInvite(input: InviteInput): InviteValidation {
  const email = normaliseEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email address for this person." };

  const name = typeof input.name === "string" ? input.name.trim().replace(/\s+/g, " ") : "";
  if (name.length < 2) return { ok: false, error: "Enter the person's full name." };
  if (name.length > 120) return { ok: false, error: "That name is too long (120 characters maximum)." };

  if (typeof input.role !== "string" || !isInvitableRole(input.role)) {
    return { ok: false, error: "Choose one of the four access levels." };
  }
  return { ok: true, value: { email, name, role: input.role } };
}

// ---------------------------------------------------------------------------
// Deactivation and role change — the two ways to lock a practice out
// ---------------------------------------------------------------------------

/** The minimum a rule needs to know about the person being acted on. */
export interface TargetPerson {
  id: string;
  role: Role;
  authStatus: AuthStatus;
}

export interface ActorPerson {
  id: string;
  role: Role;
}

export interface DeactivateContext {
  actor: ActorPerson;
  target: TargetPerson;
  /**
   * How many `client_owner` logins in this practice are currently able to sign in.
   * Counted from the SAME merged view the screen shows, so the rule and the screen
   * cannot disagree about who is left.
   */
  activeOwnerCount: number;
}

/**
 * May `actor` deactivate `target`?
 *
 * The order of the checks is the order the owner would want to be told about them:
 * "that is you" beats "that is the last owner", because when both are true the
 * first is the useful sentence.
 */
export function canDeactivate({ actor, target, activeOwnerCount }: DeactivateContext): Decision {
  if (actor.id === target.id) {
    return deny("You cannot deactivate your own login. Ask another owner to do it.");
  }
  if (target.role === "agency_admin") {
    return deny("Azen administrator logins are managed by Azen, not from this screen.");
  }
  if (target.authStatus === "missing") {
    return deny("There is no login for this person yet, so there is nothing to deactivate.");
  }
  if (target.authStatus === "unknown") {
    return deny("The login directory could not be read, so this cannot be changed safely. Try again in a moment.");
  }
  if (target.role === "client_owner" && activeOwnerCount <= 1) {
    return deny("This is the last owner login. Give somebody else owner access first, or the practice will be locked out.");
  }
  return ALLOW;
}

/** May `actor` switch `target` back on? Symmetrical, and far less dangerous. */
export function canReactivate({ target }: { target: TargetPerson }): Decision {
  if (target.role === "agency_admin") {
    return deny("Azen administrator logins are managed by Azen, not from this screen.");
  }
  if (target.authStatus === "missing") {
    return deny("There is no login for this person yet. Send them an invite instead.");
  }
  if (target.authStatus === "unknown") {
    return deny("The login directory could not be read, so this cannot be changed safely. Try again in a moment.");
  }
  return ALLOW;
}

export interface RoleChangeContext extends DeactivateContext {
  nextRole: string;
}

/**
 * May `actor` move `target` to `nextRole`?
 *
 * A role change is quieter than a deactivation and can do the same damage: demoting
 * the only owner to "Staff" leaves nobody who can promote anybody. Same two guards,
 * plus the one that matters most — `agency_admin` is not on the menu in either
 * direction.
 */
export function canChangeRole({ actor, target, nextRole, activeOwnerCount }: RoleChangeContext): Decision {
  if (!isInvitableRole(nextRole)) {
    return deny("Choose one of the four access levels.");
  }
  if (target.role === "agency_admin") {
    return deny("Azen administrator logins are managed by Azen, not from this screen.");
  }
  if (actor.id === target.id) {
    return deny("You cannot change your own access level. Ask another owner to do it.");
  }
  if (nextRole === target.role) {
    return deny("That is already this person's access level.");
  }
  if (target.role === "client_owner" && nextRole !== "client_owner" && activeOwnerCount <= 1) {
    return deny("This is the last owner login. Give somebody else owner access first.");
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------
// Link login -> staff record
// ---------------------------------------------------------------------------

export interface LinkContext {
  /** app_user.id of the login being linked. */
  personId: string;
  /** The client this action is scoped to; both sides must belong to it. */
  clientId: string;
  personClientId: string | null;
  staff: LinkableStaff | null;
}

/**
 * May this login be linked to this staff record?
 *
 * `rota_staff.app_user_id` is the join every self-service surface resolves the
 * caller through (`findStaffByAppUser`), and until now NOTHING in the product wrote
 * it. The database already refuses the dangerous half — a partial unique index on
 * `(client_id, app_user_id)` means one login can never point at two staff rows — so
 * this function exists to say the same thing in English BEFORE the insert, and
 * `friendlyLinkError` says it afterwards if two owners race.
 */
export function canLinkStaff({ clientId, personClientId, staff }: LinkContext): Decision {
  if (personClientId !== null && personClientId !== clientId) {
    return deny("That login belongs to a different practice.");
  }
  if (!staff) {
    return deny("That staff record was not found in this practice.");
  }
  if (!staff.active) {
    return deny("That staff record is archived. Make it active on the rota first.");
  }
  return ALLOW;
}

/**
 * Which staff rows the picker may offer for `personId`: the unlinked ones, plus the
 * one this person is already on (so the current choice is visible, not missing).
 */
export function linkableFor(staff: readonly LinkableStaff[], personId: string): LinkableStaff[] {
  return staff.filter((s) => s.active && (s.appUserId === null || s.appUserId === personId));
}

/**
 * A Postgres error turned into the sentence an owner can act on, or null when it is
 * not one of ours (in which case the caller must NOT dress it up — an unrecognised
 * failure surfaces as a failure).
 *
 * 23505 is the partial unique index from 0068. It fires when a second owner links
 * the same login to a different staff row between this screen's read and its write.
 */
export function friendlyLinkError(error: { code?: string } | null | undefined): string | null {
  if (!error?.code) return null;
  if (error.code === "23505") {
    return "That login is already linked to a different staff record. Unlink it there first.";
  }
  if (error.code === "42P01" || error.code === "42703") {
    return "Staff records are not set up on this environment yet, so logins cannot be linked.";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Auth status
// ---------------------------------------------------------------------------

/** The subset of a Supabase Auth user this module reads. */
export interface AuthUserFacts {
  banned_until?: string | null;
  last_sign_in_at?: string | null;
  invited_at?: string | null;
}

/**
 * The four states, derived from Supabase Auth rather than stored by us.
 *
 * THIS IS WHY THERE IS NO MIGRATION IN THIS FEATURE. `banned_until`,
 * `last_sign_in_at` and `invited_at` already carry every state the screen needs, and
 * GoTrue itself refuses a banned user on `/auth/v1/user` — which is the exact call
 * `getSessionUser` makes on every request. A duplicate `app_user.deactivated_at`
 * column would be a second source of truth for "can this person sign in", and the
 * two would drift the first time anybody used the Supabase dashboard.
 *
 * `now` is a parameter, so an expiring ban can be tested at a chosen instant.
 */
export function authStatusFrom(auth: AuthUserFacts | null | undefined, nowMs: number): AuthStatus {
  if (!auth) return "missing";
  if (auth.banned_until) {
    const until = Date.parse(auth.banned_until);
    // An unparseable banned_until is treated as a live ban: refusing access on bad
    // data is the safe direction, and the screen will say "deactivated" out loud.
    if (Number.isNaN(until) || until > nowMs) return "deactivated";
  }
  if (auth.last_sign_in_at) return "active";
  return "invited";
}

// ---------------------------------------------------------------------------
// Invite delivery
// ---------------------------------------------------------------------------

/**
 * How the invite reaches the invitee.
 *
 * Supabase's built-in email sender is rate limited to a handful of messages an hour
 * and, on a project without custom SMTP, delivers only to the project's own team.
 * A practice inviting fifty staff through it would see most invites silently never
 * arrive — the exact confident-empty-state failure this build forbids.
 *
 * So the DEFAULT is "link": mint the link, hand it to the owner once, and say so on
 * screen. Only an explicit `SUPABASE_SMTP_CONFIGURED=true` — an operator asserting
 * that custom SMTP is wired up — switches to letting Supabase send the email, in
 * which case the link never comes back to us at all.
 */
export function inviteDeliveryMode(
  env: Record<string, string | undefined> = process.env,
): InviteDelivery {
  return env.SUPABASE_SMTP_CONFIGURED === "true" ? "email" : "link";
}

/** The email-link token types this platform's set-password page accepts. */
export const SET_PASSWORD_TYPES = ["invite", "recovery", "signup", "magiclink", "email"] as const;
export type SetPasswordType = (typeof SET_PASSWORD_TYPES)[number];

export function isSetPasswordType(value: string): value is SetPasswordType {
  return (SET_PASSWORD_TYPES as readonly string[]).includes(value);
}

/**
 * The one-time link the owner passes on: OUR page, carrying Supabase's hashed
 * token, never Supabase's own `/auth/v1/verify` URL.
 *
 * Following the raw `action_link` would send the invitee through GoTrue's redirect,
 * which lands them back with the session in a URL fragment — a different, older flow
 * that the @supabase/ssr browser client does not consume the same way. Handing them
 * `token_hash` instead means the page can call `verifyOtp` directly, which is the
 * documented flow for a self-hosted email template and the one this build uses.
 *
 * Falls back to a root-relative path when no absolute base is configured, mirroring
 * `buildMedicalHistoryLink`.
 */
export function buildSetPasswordLink(
  tokenHash: string,
  type: SetPasswordType,
  baseUrl: string | undefined = process.env.PUBLIC_BASE_URL,
): string {
  const base = baseUrl && baseUrl.startsWith("http") ? baseUrl.replace(/\/$/, "") : "";
  const query = new URLSearchParams({ token_hash: tokenHash, type });
  return `${base}/set-password?${query.toString()}`;
}

// ---------------------------------------------------------------------------
// The set-password page's own parsing
// ---------------------------------------------------------------------------

export type SetPasswordEntry =
  /** Our own link: exchange the hashed token for a session with verifyOtp. */
  | { mode: "token_hash"; tokenHash: string; type: SetPasswordType }
  /** Supabase's redirect landed with the session in the fragment: adopt it. */
  | { mode: "session"; accessToken: string; refreshToken: string }
  /** Supabase reported a problem on the link itself (expired is the common one). */
  | { mode: "error"; error: string }
  /** Nothing usable in the URL. The page may still have a live session. */
  | { mode: "none" };

const EXPIRED_HINT =
  "That invite link has expired or has already been used. Ask the practice to send you a new one.";

/**
 * Read the entry conditions out of the URL, as a pure function of two strings.
 *
 * The page component does nothing but call this and render the result, which is what
 * makes the awkward half of the flow testable at all: hash fragments never reach the
 * server, so there is no server test that could cover it.
 *
 * Both shapes are accepted deliberately. `token_hash` is what `buildSetPasswordLink`
 * mints and what Supabase's own templates emit when they use `{{ .TokenHash }}`.
 * The fragment shape is what GoTrue's `/auth/v1/verify` redirect produces, which is
 * what the invitee gets if the practice ever switches on Supabase's default invite
 * email. Handling only the first would have worked in testing and stranded real
 * invitees on a blank page.
 */
export function parseSetPasswordEntry(search: string, hash: string): SetPasswordEntry {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const h = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);

  const errorCode = h.get("error_code") ?? q.get("error_code");
  const errorRaw = h.get("error") ?? q.get("error");
  if (errorCode || errorRaw) {
    const description = h.get("error_description") ?? q.get("error_description") ?? "";
    const expired = /expired|otp_expired|invalid/i.test(`${errorCode ?? ""} ${errorRaw ?? ""} ${description}`);
    return { mode: "error", error: expired ? EXPIRED_HINT : "That link could not be opened. Ask the practice to send you a new one." };
  }

  const tokenHash = q.get("token_hash") ?? h.get("token_hash");
  const type = q.get("type") ?? h.get("type") ?? "invite";
  if (tokenHash) {
    if (!isSetPasswordType(type)) return { mode: "error", error: "That link is not a set-password link." };
    return { mode: "token_hash", tokenHash, type };
  }

  const accessToken = h.get("access_token");
  const refreshToken = h.get("refresh_token");
  if (accessToken && refreshToken) return { mode: "session", accessToken, refreshToken };

  return { mode: "none" };
}

/**
 * Whether the password the INVITEE typed into their own browser is acceptable.
 *
 * Nothing in this platform ever generates, sets, transmits or stores a password:
 * this function inspects a string the person typed, in their own session, and the
 * only thing that ever leaves the browser with it is `auth.updateUser`.
 */
export function validateNewPassword(password: string, confirmation: string): Decision {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return deny(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return deny(`Use ${MAX_PASSWORD_LENGTH} characters or fewer.`);
  }
  if (password.trim().length === 0) {
    return deny(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== confirmation) {
    return deny("Those two passwords do not match.");
  }
  return ALLOW;
}
