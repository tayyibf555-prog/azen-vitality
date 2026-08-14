import type { Role } from "@/lib/types";

// ---------------------------------------------------------------------------
// People & Logins — the shared shapes.
//
// Deliberately NOT a mirror of `app_user`: a person in this module is the JOIN of
// three separate systems, and the UI is honest about all three.
//
//   1. `app_user`      the practice profile: name, role, tenancy. Ours.
//   2. Supabase Auth   whether a login exists, whether it has ever been used, and
//                      whether it is currently banned. Not ours, and it is the
//                      authority on "can this person sign in".
//   3. `rota_staff`    the person on the rota, if this login is linked to one.
//
// A row can be missing (2) entirely — an `app_user` seeded by SQL with no matching
// Auth account — and that is not an error, it is a state the owner needs to see.
// `authStatus: "missing"` says so out loud rather than rendering a confident
// "active".
// ---------------------------------------------------------------------------

/**
 * The roles a practice owner may hand out.
 *
 * `agency_admin` is absent BY DESIGN and is asserted absent in rules.test.ts: it
 * spans every client (its `client_id` is null), so an owner who could grant it
 * would be granting access to every other practice on the platform. It is created
 * by Azen, in SQL, and never through this screen.
 */
export type InvitableRole = Exclude<Role, "agency_admin">;

/**
 * What Supabase Auth says about this person's login, reduced to the four states a
 * practice owner can act on. Anything we cannot determine is "unknown", never a
 * cheerful default.
 */
export type AuthStatus =
  | "missing" // no Auth account at all: a profile row with nobody behind it
  | "invited" // invited, never signed in
  | "active" // has signed in at least once, not banned
  | "deactivated" // banned: cannot sign in, fully reversible
  | "unknown"; // the Auth directory could not be read (see PeopleListResult.authReadable)

/** The staff record a login is linked to, if any (rota_staff.app_user_id). */
export interface LinkedStaff {
  id: string;
  name: string;
  role: string;
  siteId: string | null;
}

/** A rota_staff row offered in the "link login" picker. */
export interface LinkableStaff extends LinkedStaff {
  /** The app_user this staff row is ALREADY linked to, or null. */
  appUserId: string | null;
  active: boolean;
}

/** One row of the People & Logins table. */
export interface Person {
  /** app_user.id — NOT the Supabase Auth user id; they are unrelated uuids. */
  id: string;
  email: string;
  name: string;
  role: Role;
  clientId: string | null;
  authStatus: AuthStatus;
  /** ISO instant of the last sign in, when Auth could be read. */
  lastSignInAt: string | null;
  /** ISO instant the invite was issued, when Auth could be read. */
  invitedAt: string | null;
  linkedStaff: LinkedStaff | null;
}

/**
 * How an invite reaches the invitee.
 *
 * "email"  Supabase sends it (custom SMTP is configured). We never see the link.
 * "link"   we mint the link and hand it to the OWNER once, to pass on securely.
 */
export type InviteDelivery = "email" | "link";

/** The result of a successful invite. `link` is present only for delivery "link". */
export interface InviteResult {
  person: Person;
  delivery: InviteDelivery;
  /**
   * The one-time set-password link. Returned to the owner ONCE, never stored and
   * never logged. Null whenever Supabase delivered the email itself.
   */
  link: string | null;
}
