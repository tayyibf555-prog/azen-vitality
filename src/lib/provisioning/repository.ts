import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase/server";
import type { Role } from "@/lib/types";
import { authStatusFrom, countActiveOwners, type AuthUserFacts, type SetPasswordType } from "./rules";
import type { AuthStatus, InvitableRole, LinkableStaff, LinkedStaff, Person } from "./types";

// ===========================================================================
// PEOPLE & LOGINS — all of the I/O, and none of the decisions.
//
// Three stores, joined here and nowhere else:
//   public.app_user       our profile rows      (service-role client)
//   Supabase Auth         the actual logins     (ADMIN API, service-role key only)
//   public.rota_staff     the person on the rota (app_user_id, written here)
//
// THE ADMIN API IS NOT `serviceClient()`. `serviceClient()` deliberately falls back
// to the anon key when SUPABASE_SERVICE_ROLE_KEY is unset, which is right for data
// reads in the un-enforced pilot and catastrophic here: every `auth.admin.*` call
// would 401 and the screen would show an empty, confident-looking list of logins.
// `adminAuthClient()` therefore returns NULL rather than a degraded client, and the
// route turns that null into an honest "user provisioning is not switched on in this
// environment" — never into a blank table.
//
// NO PASSWORD IS EVER CREATED, SET, GENERATED, TRANSMITTED OR STORED BY THIS FILE.
// `createUser` is not called anywhere in it. An invite mints a one-time link that
// the invitee exchanges for a session in their own browser, and the password they
// then choose goes straight from their browser to Supabase.
// ===========================================================================

/** How many Auth users we will page through before giving up and saying so. */
const AUTH_PAGE_SIZE = 200;
const AUTH_MAX_PAGES = 10;

/** A ban long enough to be permanent, lifted with `ban_duration: "none"`. */
const BAN_DURATION = "876000h"; // 100 years

/**
 * The service-role Supabase client, or null when the key is absent.
 *
 * Null is the whole point: see the header. Provisioning is one of the few features
 * that CANNOT degrade gracefully without the service-role key, so it says so.
 */
export function adminAuthClient(): SupabaseClient | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!key || !url) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Whether this environment can provision logins at all. */
export function provisioningAvailable(): boolean {
  return adminAuthClient() !== null;
}

// ---------------------------------------------------------------------------
// app_user
// ---------------------------------------------------------------------------

interface AppUserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  client_id: string | null;
}

const APP_USER_COLUMNS = "id, email, name, role, client_id";

/** Every profile row belonging to one practice. Throws: a failed read is not "no people". */
async function readAppUsers(clientId: string): Promise<AppUserRow[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("app_user")
    .select(APP_USER_COLUMNS)
    .eq("client_id", clientId)
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as AppUserRow[];
}

/**
 * A profile row by email, across every tenant.
 *
 * Deliberately NOT scoped by client: `app_user.email` is globally unique, so an
 * invite to an address already used by another practice must be refused with a
 * clear message rather than exploding on the unique constraint.
 */
export async function findPersonByEmail(email: string): Promise<AppUserRow | null> {
  const db = serviceClient();
  const { data, error } = await db.from("app_user").select(APP_USER_COLUMNS).eq("email", email).maybeSingle();
  if (error) throw error;
  return (data as AppUserRow | null) ?? null;
}

export async function createPersonRow(input: {
  email: string;
  name: string;
  role: InvitableRole;
  clientId: string;
}): Promise<AppUserRow> {
  const db = serviceClient();
  const { data, error } = await db
    .from("app_user")
    .insert({ email: input.email, name: input.name, role: input.role, client_id: input.clientId })
    .select(APP_USER_COLUMNS)
    .single();
  if (error) throw error;
  return data as AppUserRow;
}

// There is deliberately NO delete here. An invite that half-fails (profile created,
// Supabase refused the invite) leaves a row whose authStatus is "missing" — which
// the screen shows, with a "Resend invite" button beside it. Rolling the row back
// instead would turn a visible, fixable state into a vanished action the owner has
// to reconstruct from memory.

export async function updatePersonRole(clientId: string, id: string, role: InvitableRole): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("app_user").update({ role }).eq("client_id", clientId).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Supabase Auth (admin)
// ---------------------------------------------------------------------------

export interface AuthDirectory {
  /** email (lower-cased) -> { id, facts }. Empty when `readable` is false. */
  byEmail: Map<string, { id: string; facts: AuthUserFacts }>;
  /** False when the directory could not be read, or was larger than the cap. */
  readable: boolean;
  /** Why it could not be read, for the honest failure line. Null when readable. */
  error: string | null;
}

/**
 * Every Auth user, keyed by email.
 *
 * `admin.listUsers` has no email filter, so this pages. The cap is not decoration:
 * a truncated directory would silently mark real logins "missing", so hitting it
 * sets `readable: false` and every status becomes "unknown" — the screen then says
 * it could not read the login directory instead of inventing four missing logins.
 */
export async function readAuthDirectory(): Promise<AuthDirectory> {
  const admin = adminAuthClient();
  if (!admin) {
    return { byEmail: new Map(), readable: false, error: "The service-role key is not configured in this environment." };
  }
  const byEmail = new Map<string, { id: string; facts: AuthUserFacts }>();
  try {
    for (let page = 1; page <= AUTH_MAX_PAGES; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE });
      if (error) throw error;
      const users = data?.users ?? [];
      for (const u of users) {
        const email = u.email?.toLowerCase();
        if (!email) continue;
        byEmail.set(email, {
          id: u.id,
          facts: {
            banned_until: u.banned_until ?? null,
            last_sign_in_at: u.last_sign_in_at ?? null,
            invited_at: u.invited_at ?? null,
          },
        });
      }
      if (users.length < AUTH_PAGE_SIZE) return { byEmail, readable: true, error: null };
    }
    // The cap was reached with a full final page: there may be more, so this
    // directory is INCOMPLETE and must not be presented as authoritative.
    return {
      byEmail: new Map(),
      readable: false,
      error: "There are more logins than this screen can read in one go. Contact Azen.",
    };
  } catch (e) {
    return {
      byEmail: new Map(),
      readable: false,
      error: e instanceof Error ? e.message : "The login directory could not be read.",
    };
  }
}

/** The Auth user id behind an email, or null. Used before every ban/unban. */
export async function findAuthUserId(email: string): Promise<string | null> {
  const directory = await readAuthDirectory();
  if (!directory.readable) return null;
  return directory.byEmail.get(email.toLowerCase())?.id ?? null;
}

/**
 * Ban or unban a login. THIS IS THE WHOLE OF "deactivate".
 *
 * Reversible by construction — `ban_duration: "none"` restores the account exactly
 * as it was, with the same password, the same `app_user` row and the same role. No
 * profile data is touched and nothing is deleted, so "deactivate" can never be a
 * quiet way of losing a person's history.
 *
 * GoTrue refuses a banned user on `/auth/v1/user`, which is the call `getSessionUser`
 * makes on EVERY request, so the block takes effect on their next request rather
 * than whenever a token happens to expire.
 */
export async function setAuthBanned(authUserId: string, banned: boolean): Promise<void> {
  const admin = adminAuthClient();
  if (!admin) throw new Error("provisioning-unavailable");
  const { error } = await admin.auth.admin.updateUserById(authUserId, {
    ban_duration: banned ? BAN_DURATION : "none",
  });
  if (error) throw error;
}

export interface InvitedAuthUser {
  authUserId: string;
  /** Present only when we minted the link ourselves. NEVER logged, never stored. */
  tokenHash: string | null;
}

/**
 * Create the Auth account and let Supabase email the invite. No link comes back.
 *
 * Used only when an operator has asserted that custom SMTP is configured
 * (`SUPABASE_SMTP_CONFIGURED=true`); otherwise Supabase's built-in sender would
 * accept the call and quietly not deliver.
 */
export async function inviteByEmail(email: string, name: string, redirectTo: string): Promise<InvitedAuthUser> {
  const admin = adminAuthClient();
  if (!admin) throw new Error("provisioning-unavailable");
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: name },
    redirectTo,
  });
  if (error) throw error;
  if (!data?.user?.id) throw new Error("Supabase accepted the invite but returned no user.");
  return { authUserId: data.user.id, tokenHash: null };
}

/**
 * Create the Auth account and return the hashed token WITHOUT sending anything.
 *
 * `generateLink` is the "custom email provider" path: it creates the user and hands
 * back the token, and sends no mail at all. The caller turns the token into a
 * /set-password URL for the owner to pass on. The raw token is returned exactly once
 * and is never written to a log, a database row or a telemetry event.
 */
export async function generateInviteToken(
  email: string,
  name: string,
  redirectTo: string,
): Promise<InvitedAuthUser> {
  const admin = adminAuthClient();
  if (!admin) throw new Error("provisioning-unavailable");
  const { data, error } = await admin.auth.admin.generateLink({
    type: "invite",
    email,
    options: { data: { full_name: name }, redirectTo },
  });
  if (error) throw error;
  const tokenHash = data?.properties?.hashed_token;
  if (!data?.user?.id || !tokenHash) throw new Error("Supabase returned no invite token.");
  return { authUserId: data.user.id, tokenHash };
}

/**
 * A fresh token for somebody who already has an Auth account.
 *
 * `type: "invite"` fails once the user exists, so a re-send is a RECOVERY link. It
 * lands on the same /set-password page, which is why that page accepts both types.
 */
export async function generateRecoveryToken(
  email: string,
  redirectTo: string,
): Promise<{ tokenHash: string; type: SetPasswordType }> {
  const admin = adminAuthClient();
  if (!admin) throw new Error("provisioning-unavailable");
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email,
    options: { redirectTo },
  });
  if (error) throw error;
  const tokenHash = data?.properties?.hashed_token;
  if (!tokenHash) throw new Error("Supabase returned no recovery token.");
  return { tokenHash, type: "recovery" };
}

/**
 * Ask Supabase to EMAIL a password-reset link. Nothing comes back to us.
 *
 * Note this is `auth.resetPasswordForEmail`, not an `auth.admin.*` call:
 * `generateLink` deliberately sends nothing (it exists for custom email providers),
 * so using it here would have "succeeded" while no invitee ever received anything.
 */
export async function sendRecoveryEmail(email: string, redirectTo: string): Promise<void> {
  const admin = adminAuthClient();
  if (!admin) throw new Error("provisioning-unavailable");
  const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// rota_staff — THE LINK NOBODY EVER WROTE
// ---------------------------------------------------------------------------

interface StaffRow {
  id: string;
  name: string;
  role: string;
  site_id: string | null;
  app_user_id: string | null;
  active: boolean;
}

export interface StaffDirectory {
  rows: LinkableStaff[];
  /** False when rota_staff (or 0068's app_user_id column) is not present yet. */
  readable: boolean;
}

/**
 * The practice's staff records, with the login each is linked to.
 *
 * Tolerates a missing table/column (42P01/42703) because 0068 is applied by the
 * orchestrator, not by this builder: until it lands, linking is UNAVAILABLE and the
 * screen says so. Any other error throws — "the read failed" must never render as
 * "this practice has no staff".
 */
export async function readStaffDirectory(clientId: string): Promise<StaffDirectory> {
  const db = serviceClient();
  const { data, error } = await db
    .from("rota_staff")
    .select("id, name, role, site_id, app_user_id, active")
    .eq("client_id", clientId)
    .order("name", { ascending: true });
  if (error) {
    if (error.code === "42P01" || error.code === "42703") return { rows: [], readable: false };
    throw error;
  }
  const rows = ((data ?? []) as StaffRow[]).map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    siteId: r.site_id,
    appUserId: r.app_user_id,
    active: r.active,
  }));
  return { rows, readable: true };
}

/**
 * Point a staff record at a login, or clear it (`appUserId: null`).
 *
 * BOTH `.eq()`s matter. Without `client_id` this is a cross-tenant write: a staff id
 * belonging to another practice would be linked to this practice's login, and the
 * composite tenancy the rest of the schema is careful about would be undone by the
 * one screen that hands out access.
 *
 * The partial unique index `uniq_rota_staff_client_app_user` (0068) is what actually
 * enforces one login -> one staff row; a 23505 from here is turned into a sentence
 * by `friendlyLinkError`.
 */
export async function setStaffLink(input: {
  clientId: string;
  staffId: string;
  appUserId: string | null;
}): Promise<{ ok: true } | { ok: false; code?: string }> {
  const db = serviceClient();
  const { error, count } = await db
    .from("rota_staff")
    .update({ app_user_id: input.appUserId }, { count: "exact" })
    .eq("client_id", input.clientId)
    .eq("id", input.staffId);
  if (error) return { ok: false, code: error.code };
  if (!count) return { ok: false, code: "no-row" };
  return { ok: true };
}

/** Clear whatever staff row currently points at this login, within one practice. */
export async function clearStaffLinkForPerson(clientId: string, appUserId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("rota_staff")
    .update({ app_user_id: null })
    .eq("client_id", clientId)
    .eq("app_user_id", appUserId);
  if (error && error.code !== "42P01" && error.code !== "42703") throw error;
}

// ---------------------------------------------------------------------------
// The joined view
// ---------------------------------------------------------------------------

export interface PeopleView {
  people: Person[];
  /** False when Supabase Auth could not be read: every status is then "unknown". */
  authReadable: boolean;
  authError: string | null;
  /** False when rota_staff is not available: the link control is disabled, honestly. */
  staffReadable: boolean;
  staff: LinkableStaff[];
  /** How many owner logins can currently sign in. Feeds the last-owner rules. */
  activeOwnerCount: number;
}

/**
 * The whole screen's data, in one place, joined across three systems.
 *
 * The `app_user` read is the only one allowed to throw: it is our own table and its
 * failure means we do not know who the people ARE. The other two degrade to a stated
 * "could not read this" rather than to a plausible-looking empty column.
 */
export async function readPeople(clientId: string, nowMs: number): Promise<PeopleView> {
  const [rows, directory, staff] = await Promise.all([
    readAppUsers(clientId),
    readAuthDirectory(),
    readStaffDirectory(clientId),
  ]);

  const staffByAppUser = new Map<string, LinkedStaff>();
  for (const s of staff.rows) {
    if (s.appUserId) staffByAppUser.set(s.appUserId, { id: s.id, name: s.name, role: s.role, siteId: s.siteId });
  }

  const people: Person[] = rows.map((row) => {
    const auth = directory.readable ? directory.byEmail.get(row.email.toLowerCase()) : undefined;
    const authStatus: AuthStatus = directory.readable ? authStatusFrom(auth?.facts ?? null, nowMs) : "unknown";
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role,
      clientId: row.client_id,
      authStatus,
      lastSignInAt: auth?.facts.last_sign_in_at ?? null,
      invitedAt: auth?.facts.invited_at ?? null,
      linkedStaff: staffByAppUser.get(row.id) ?? null,
    };
  });

  // "Active" means CAN SIGN IN. The predicate lives in `countActiveOwners` with
  // its own test rather than inline here, because this number is what the
  // last-owner lockout guard rests on and this file has no test file at all.
  const activeOwnerCount = countActiveOwners(people);

  return {
    people,
    authReadable: directory.readable,
    authError: directory.error,
    staffReadable: staff.readable,
    staff: staff.rows,
    activeOwnerCount,
  };
}
