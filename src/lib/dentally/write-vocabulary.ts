// ===========================================================================
// THE WRITE VOCABULARY — a PURE LEAF, and that is the whole point of it.
//
// It imports NOTHING. Not the Supabase client, not the systems repository, not
// the Dentally client. Everything in here is a constant, a type or a pure
// function, so it can be read by the gate (server), by the ledger (server), by
// the Sync Status composer (server) AND by the browser component that renders
// the result — without dragging the service-role Supabase client into a client
// bundle, which is what happened the first time these lived beside their
// consumers.
//
// So the rule for this file is simply: no imports, ever. Anything that needs an
// environment variable, a database or a network call belongs in write-gate.ts or
// sync-ledger.ts, which import this and re-export the parts their own callers
// have always used.
// ===========================================================================

/** The five write methods DentallyClient supports. There is no sixth. */
export const DENTALLY_WRITE_KINDS = [
  "patient.create",
  "patient.update",
  "appointment.create",
  "appointment.update",
  "appointment.cancel",
] as const;
export type DentallyWriteKind = (typeof DENTALLY_WRITE_KINDS)[number];

/** Every status a row can hold. Mirrors the CHECK in migration 0096. */
export const WRITE_INTENT_STATUSES = ["dry_run", "queued", "sent", "failed", "blocked"] as const;
export type WriteIntentStatus = (typeof WRITE_INTENT_STATUSES)[number];

/** Why the platform refused a write before making a request. */
export const BLOCKED_REASONS = [
  "writes_disabled",
  "master_off",
  "system_off",
  "invalid_target",
  "client_read_only",
  "no_supported_endpoint",
] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

/**
 * THE MASTER SWITCH over every outbound Dentally write.
 *
 * It sits ABOVE the five kinds and above each module's own switch, so the
 * practice owner has ONE lever that stops everything flowing to Dentally without
 * having to find and flip nine. It composes with the environment rather than
 * replacing it: the agency arms the deployment (DENTALLY_WRITE_*) and the owner
 * arms the practice (this switch), and BOTH have to be on before a single write
 * leaves this platform.
 *
 * Declared here rather than being typed out at each consumer so the slug the gate
 * checks, the slug the catalog declares and the slug the migration seeds are one
 * value that cannot drift.
 */
export const DENTALLY_WRITE_MASTER_SLUG = "dentally-write-back";

/** Plain-English wording for each blocked reason, as an owner reads it. */
export const BLOCKED_REASON_COPY: Record<BlockedReason, string> = {
  writes_disabled:
    "Writing back to Dentally is switched off for this deployment, so this was recorded here and nothing was sent. This is what staff tried to send to Dentally while write-back was off.",
  master_off:
    "Your Dentally write-back switch is off in System controls, so nothing was sent. Everything else about the action went through as normal.",
  system_off:
    "The system that asked for this write is switched off in System controls, so nothing was sent to Dentally.",
  invalid_target:
    "The write named no Dentally record to act on, so it was refused here rather than sent as an incomplete request.",
  client_read_only:
    "The Dentally connection is read-only. Writing back needs a dedicated write key, which the practice has not issued yet.",
  no_supported_endpoint:
    "Dentally publishes no supported way to write this. It is held in this platform and does not flow back.",
};

// ---------------------------------------------------------------------------
// WHO WRITES, AND WHICH SWITCH GOVERNS THEM.
//
// The same shape as DRAIN_SOURCE_TO_SLUG in src/lib/systems/catalog.ts, and for
// the same reason: an outbound act whose source is not mapped to a slug is an
// act the owner's kill switch cannot stop. There the rule is "unmapped =
// unkillable"; here it is enforced by the type — a caller must name a source
// that exists, and every source names a slug or states in writing why it has
// none.
// ---------------------------------------------------------------------------

interface WriteSourceDef {
  /** The system_toggle slug that governs this source, or null (see whyNoSwitch). */
  slug: string | null;
  /** Owner-facing: which surface this is. */
  label: string;
  /**
   * Required when `slug` is null. There are exactly two such sources and both
   * are a member of staff editing the record in front of them rather than an
   * automated system doing work on its own — there is no sweep to halt, so
   * there is nothing for a kill switch to switch off. Adding one would put a
   * control in the owner's panel that nobody asked for, which is a product
   * decision and not a build step.
   */
  whyNoSwitch?: string;
  /** The write kinds this source is allowed to make. */
  kinds: readonly DentallyWriteKind[];
}

export const DENTALLY_WRITE_SOURCES = {
  "online-booking": {
    slug: "online-booking",
    label: "Online booking (the public booking page)",
    kinds: ["patient.create", "appointment.create"],
  },
  onboarding: {
    slug: "onboarding",
    label: "New-patient onboarding (registering a completed form)",
    kinds: ["patient.create"],
  },
  recall: {
    slug: "recall",
    label: "Recall concierge (booking a recall from the worklist)",
    kinds: ["appointment.create"],
  },
  reactivation: {
    slug: "reactivation",
    label: "Reactivation (booking a lapsed patient back in)",
    kinds: ["appointment.create"],
  },
  coordinator: {
    slug: "treatment-coordinator",
    label: "Treatment Coordinator (booking the next step)",
    kinds: ["appointment.create"],
  },
  noshow: {
    slug: "no-show-defence",
    label: "No-show defence (rebooking, and cancelling on a patient's reply)",
    kinds: ["appointment.create", "appointment.cancel"],
  },
  diary: {
    slug: "calendar-writes",
    label: "Diary (moving, resizing or reassigning an appointment)",
    kinds: ["appointment.update"],
  },
  "booking-agent": {
    slug: "booking-agent",
    label: "Booking agent (the 24/7 SMS and WhatsApp assistant)",
    kinds: ["patient.create", "appointment.create", "appointment.update", "appointment.cancel"],
  },
  "patient-admin": {
    slug: null,
    label: "Patient record editing (a manager correcting a patient's details)",
    whyNoSwitch:
      "A member of staff editing the record in front of them, not an automated system. There is no sweep, no queue and no message to halt, so there is nothing for a kill switch to stop; the lock is the role guard on the route (requirePatientAdmin) and the write gate itself.",
    kinds: ["patient.update"],
  },
  // ADDED BY W1-E (the co-pilot clearance lane), additively and by agreement:
  // routing `create_patient` through the gate needs a source, and using
  // `onboarding` would have put "registering a completed form" on a ledger row
  // for something an owner typed into a chat. The ledger's whole value is that
  // it does not misdescribe what the platform did.
  copilot: {
    slug: null,
    label: "Co-pilot (the owner adding a patient, or booking, moving or cancelling, by asking)",
    whyNoSwitch:
      "The same shape as patient-admin: an owner in a session, behind a two-step confirm, not an automated system. There is no sweep, no queue and no message to halt, so there is nothing for a per-module kill switch to stop, and the co-pilot is deliberately absent from the systems catalog for that reason. The locks are the module guard and the `system.copilot.ask` capability on /api/copilot, the owner-only `diary-write` clearance domain, the tool's own confirm gate, and the master dentally-write-back switch that governs every source here.",
    // WIDENED BY WAVE 2, LANE A, from patient.create alone to the three
    // appointment kinds as well: the co-pilot's `diary_write` tool books, moves
    // and cancels through this gate. Declared here because the Sync Status page
    // derives "which surfaces make this write" from this registry, and a surface
    // that changes a practice's diary while being absent from the page they read
    // to find out what changes their diary is the exact gap W1-A closed.
    kinds: ["patient.create", "appointment.create", "appointment.update", "appointment.cancel"],
  },
  "patient-status": {
    slug: null,
    label: "Patient status (marking a record active or inactive)",
    whyNoSwitch:
      "The same staff action as patient-admin, on the one field Dentally exposes as a genuine upstream flag. No sweep, no queue, no message; the platform override applies whatever Dentally does.",
    kinds: ["patient.update"],
  },
} as const satisfies Record<string, WriteSourceDef>;

export type DentallyWriteSource = keyof typeof DENTALLY_WRITE_SOURCES;

/** The system_toggle slug that governs a source, or null when it has none. */
export function writeSlugFor(source: DentallyWriteSource): string | null {
  return DENTALLY_WRITE_SOURCES[source].slug;
}

// ---------------------------------------------------------------------------
// THE PAYLOAD SUMMARY.
//
// AN ALLOW-LIST, NEVER A DENY-LIST. A key's VALUE is stored only when the key is
// on NON_PERSONAL_FIELDS; every other key contributes its NAME and nothing else.
// So the ledger can say "this registration carried a first_name, a
// date_of_birth and a mobile_phone" while holding not one character of any of
// them — and a field somebody adds tomorrow (an nhs_number, an address line) is
// summarised as a name by default rather than flowing into a table nobody
// thinks of as holding patient data.
//
// `notes` is deliberately NOT on the list. It is the one field on a booking
// payload that carries a patient's own words ("Patient interest: ...").
// ---------------------------------------------------------------------------

const NON_PERSONAL_FIELDS = new Set([
  "patient_id",
  "site_id",
  "practitioner_id",
  "payment_plan_id",
  "appointment_id",
  "start_time",
  "finish_time",
  "duration",
  "reason",
  "state",
  "active",
  "booked_via_api",
  "use_sms",
  "use_email",
]);

/**
 * WHO ACTED, reduced to something the ledger may hold.
 *
 * An OPAQUE USER ID or an agent slug, never an email address. The ruling is
 * simple and it is the right one: this table's whole design is that it holds no
 * personal data, and a staff member's work email is personal data — it names a
 * real person and it is a credential-shaped identifier that would be sitting in a
 * row alongside a patient's Dentally id.
 *
 * Belt AND braces. The call sites pass `auth?.id`, and a source crawl
 * (write-gate-sites.test.ts) fails if any of them ever passes `auth.email`
 * instead. This function is the braces: anything that looks like an address is
 * replaced here, so a future call site's slip cannot put one in the database.
 */
export function sanitiseActor(actor: string | null | undefined): string | null {
  if (!actor) return null;
  const trimmed = String(actor).trim();
  if (!trimmed) return null;
  if (/[\w.+-]+@[\w-]+\.[\w.-]+/.test(trimmed)) return "[redacted:email]";
  return trimmed.slice(0, 200);
}

export interface WritePayloadSummary {
  /** Every key the payload carried, sorted. Names only. */
  fields: string[];
  /** The values of the non-personal keys, and only those. */
  values: Record<string, string | number | boolean>;
  fieldCount: number;
}

export function summariseWritePayload(payload: Record<string, unknown>): WritePayloadSummary {
  const fields: string[] = [];
  const values: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    fields.push(key);
    if (!NON_PERSONAL_FIELDS.has(key)) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      values[key] = value;
      continue;
    }
    // Truncated even on the allow-list: these are catalogue values and ISO
    // timestamps, and a field that has quietly become free text must not be able
    // to smuggle a paragraph into the ledger on the strength of its name.
    if (typeof value === "string") values[key] = value.slice(0, 64);
  }
  fields.sort();
  return { fields, values, fieldCount: fields.length };
}

/**
 * Is this HOST the practice's real Dentally book?
 *
 * The same hostname rule targetsRealDentally applies to a whole URL, expressed
 * over the host alone so a stored ledger row can be judged long after the URL it
 * came from is gone — and so the BROWSER can judge one, which targetsRealDentally
 * cannot do from here (it lives beside the client and drags the server with it).
 * write-gate.test.ts pins the two against each other for the same inputs.
 *
 * Matches on the whole host, never on a substring, so neither
 * `localhost:3000/api/mock-dentally.co/...` nor `dentally.co.evil.test` can pass
 * as the real book. An unrecognised host is treated as REAL: the safe answer to
 * "I cannot tell where this went" is "assume the live patient book".
 */
export function isLiveDentallyHost(host: string): boolean {
  const hostname = String(host ?? "").split(":")[0].trim().toLowerCase();
  if (!hostname) return true;
  return /(^|\.)dentally\.co$/.test(hostname);
}

/**
 * How a ledger row's target reads to an owner.
 *
 * A `dry_run` row against the local mock and a `dry_run` row that never left the
 * building look identical in a table unless one of them says so, and reading a
 * developer's mock write as a rehearsal against the real book is exactly the
 * misreading this label exists to prevent.
 */
export function targetLabel(host: string): string {
  return isLiveDentallyHost(host) ? host : `${host} (local mock)`;
}

/**
 * Whether this deployment's Dentally writes go to the practice's real book.
 * The TYPE lives here (the pure leaf) because the Sync Status surface is typed
 * on it; the RESOLVER lives in write-gate.ts, because it reads the environment.
 */
export type DentallyWriteMode = "live" | "dry_run";
