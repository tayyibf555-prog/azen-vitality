import { normaliseEmail, toE164 } from "@/lib/messaging/phone";
import { normaliseGender } from "./demographics";

/**
 * The editable patient profile: whitelist, validation, canonicalisation and diffing.
 *
 * PURE. No I/O, no Dentally client, no database. The route and the service layer above
 * do the talking; everything that decides WHAT may be written to a real clinical record
 * lives here so it can be tested exhaustively.
 *
 * The field keys are DENTALLY'S OWN names (first_name, mobile_phone, date_of_birth ...),
 * deliberately: the whitelist then maps 1:1 onto the PUT body with no translation layer
 * to get wrong. Same posture as buildManualBookingPayload - we never forward a caller's
 * object, we build a fresh one from keys we recognise.
 *
 * CALIBRATED AGAINST REAL DENTALLY (2026-07-26), not the local mock:
 *   - `gender` is a BOOLEAN, true = male and false = female (proven across 200 real
 *     records for this practice). A string here is refused outright, never coerced.
 *   - `payment_plan_id` for this practice is 1 = NHS, 2 = Private, 47752 = UDC.
 *   - There is no `archived` field on a live patient; `active` is the real flag.
 */

export const PROFILE_FIELDS = [
  "title",
  "first_name",
  "last_name",
  "date_of_birth",
  "gender",
  "mobile_phone",
  "email_address",
  "address_line_1",
  "address_line_2",
  "address_line_3",
  "postcode",
  "payment_plan_id",
  "active",
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

const FIELD_SET: ReadonlySet<string> = new Set<string>(PROFILE_FIELDS);

/** Every editable value, always present, `null` when the record does not carry it. */
export interface PatientProfile {
  title: string | null;
  first_name: string | null;
  last_name: string | null;
  date_of_birth: string | null;
  gender: boolean | null;
  mobile_phone: string | null;
  email_address: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  postcode: string | null;
  payment_plan_id: number | null;
  active: boolean | null;
}

/** A subset of the profile: the fields a caller is actually setting. */
export type ProfileChanges = Partial<PatientProfile>;

/** One editable value, in the union the whole module compares and stores. */
export type ProfileValue = string | number | boolean | null;

/** Human labels for messages and the audit trail. British English throughout. */
export const FIELD_LABELS: Record<ProfileField, string> = {
  title: "Title",
  first_name: "First name",
  last_name: "Last name",
  date_of_birth: "Date of birth",
  gender: "Gender",
  mobile_phone: "Mobile",
  email_address: "Email",
  address_line_1: "Address line 1",
  address_line_2: "Address line 2",
  address_line_3: "Address line 3",
  postcode: "Postcode",
  payment_plan_id: "Payment plan",
  active: "Active",
};

/**
 * The titles this practice uses. Whitelisted exactly like the public booking route's
 * knownTitle(): these five are the ones proven to register against live Dentally, so a
 * free-text title can never land on a real record. A patient already carrying some other
 * title keeps it untouched - the field is only validated when it is being CHANGED.
 */
export const TITLES = ["Mr", "Mrs", "Miss", "Ms", "Master"] as const;

/** This practice's own live Dentally payment plan ids. Whitelisted, never passed through. */
export const PAYMENT_PLANS: ReadonlyArray<{ id: number; label: string }> = [
  { id: 1, label: "NHS" },
  { id: 2, label: "Private" },
  { id: 47752, label: "UDC" },
];
const PLAN_IDS: ReadonlySet<number> = new Set(PAYMENT_PLANS.map((p) => p.id));

/**
 * The fields an empty value may CLEAR. Everything else must carry a real value when it is
 * being changed, because Dentally requires it (name, date of birth, title, payment plan)
 * or because the practice loses its only way to reach the patient (mobile). Blanking one
 * of those is refused with a message rather than written through.
 */
const CLEARABLE: ReadonlySet<ProfileField> = new Set<ProfileField>([
  "email_address",
  "address_line_1",
  "address_line_2",
  "address_line_3",
  "postcode",
]);

function text(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
}

/**
 * A real calendar date as YYYY-MM-DD, the same UTC round-trip the booking route uses so
 * an impossible date (2001-13-40, 31 February) is refused rather than written through
 * because it merely looked date-shaped.
 */
export function canonicalDob(raw: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** UK postcode canonical form (uppercase, single space before the inward code), or the
 *  uppercased original for a non-UK code we still accept. null for anything unusable. */
export function canonicalPostcode(raw: string): string | null {
  const squashed = raw.replace(/\s+/g, "").toUpperCase();
  if (squashed === "") return null;
  const uk = /^([A-Z]{1,2}\d[A-Z\d]?)(\d[A-Z]{2})$/.exec(squashed);
  if (uk) return `${uk[1]} ${uk[2]}`;
  // Not a UK code: accept a short alphanumeric string (a patient may live abroad) but
  // never arbitrary punctuation on a clinical record.
  const loose = raw.replace(/\s+/g, " ").trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9 -]{0,11}$/.test(loose) ? loose : null;
}

/**
 * Dentally's gender as the BOOLEAN it really is: true = male, false = female. A raw
 * boolean passes straight through; the historical string/integer encodings are routed
 * through the existing normaliseGender helper rather than reimplemented here.
 */
export function canonicalGender(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  const g = normaliseGender(raw);
  return g === null ? null : g === "male";
}

/**
 * Canonicalise ANY source of profile values - a raw Dentally patient object, or the
 * `expected` snapshot a form posts back - into the same full shape, so the diff and the
 * conflict check compare like with like.
 *
 * This matters more than it looks: Dentally stores mobiles in national format
 * ("07834 123456") while ours are E.164 ("+447834123456"). Comparing raw strings would
 * mark an UNTOUCHED number as changed and rewrite it on every save.
 */
export function canonicaliseProfile(raw: Record<string, unknown> | null | undefined): PatientProfile {
  const r = raw ?? {};
  // Dentally exposes the plan as a flat id, and some payloads nest it. Read both rather
  // than assuming the mock's shape (the systemic lesson: check field names against real
  // Dentally, or the code silently produces nothing).
  const nestedPlan = r.payment_plan && typeof r.payment_plan === "object"
    ? (r.payment_plan as Record<string, unknown>).id
    : undefined;
  const planRaw = r.payment_plan_id ?? nestedPlan;
  const plan = typeof planRaw === "number" ? planRaw : Number(planRaw);

  return {
    title: text(r.title),
    first_name: text(r.first_name),
    last_name: text(r.last_name),
    date_of_birth: typeof r.date_of_birth === "string" ? canonicalDob(r.date_of_birth) : null,
    gender: canonicalGender(r.gender),
    mobile_phone: toE164(typeof r.mobile_phone === "string" ? r.mobile_phone : null),
    email_address: normaliseEmail(typeof r.email_address === "string" ? r.email_address : null),
    address_line_1: text(r.address_line_1),
    address_line_2: text(r.address_line_2),
    address_line_3: text(r.address_line_3),
    postcode: typeof r.postcode === "string" ? canonicalPostcode(r.postcode) : null,
    payment_plan_id: Number.isFinite(plan) && plan !== 0 ? plan : null,
    // Real Dentally omits `active` only on a record we could not read; treat an absent
    // flag as null (unknown) rather than guessing, so it never shows as a change.
    active: typeof r.active === "boolean" ? r.active : null,
  };
}

export interface ParsedChanges {
  /** The whitelisted, validated, canonicalised values. Only fields the caller sent. */
  values: ProfileChanges;
  /** Keys the caller sent that are NOT editable. Recorded so the refusal is visible. */
  dropped: string[];
}

export type ParseResult =
  | { ok: true; parsed: ParsedChanges }
  | { ok: false; errors: Partial<Record<ProfileField, string>> };

/**
 * Build the editable value set from an untrusted object.
 *
 * STRICT WHITELIST, exactly like buildManualBookingPayload: an unrecognised key is
 * DROPPED, never forwarded, so no caller can smuggle `id`, `site_id`, a balance or any
 * other Dentally field onto a real patient record through this endpoint. Every accepted
 * key is then re-validated and re-normalised here; nothing the caller sent is trusted as
 * written.
 */
export function parseProfileChanges(raw: unknown): ParseResult {
  const body = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const values: ProfileChanges = {};
  const errors: Partial<Record<ProfileField, string>> = {};
  const dropped: string[] = [];

  for (const key of Object.keys(body)) {
    if (!FIELD_SET.has(key)) {
      dropped.push(key);
      continue;
    }
    const field = key as ProfileField;
    const v = body[key];

    // An explicit empty value means "clear this", allowed only where the record can
    // genuinely live without it.
    const isEmpty = v === null || v === undefined || (typeof v === "string" && v.trim() === "");
    if (isEmpty) {
      if (!CLEARABLE.has(field)) {
        errors[field] = `${FIELD_LABELS[field]} cannot be left empty.`;
      } else {
        values[field] = null;
      }
      continue;
    }

    switch (field) {
      case "title": {
        const t = text(v);
        const match = t ? TITLES.find((x) => x.toLowerCase() === t.toLowerCase()) : undefined;
        if (!match) errors.title = `Title must be one of ${TITLES.join(", ")}.`;
        else values.title = match;
        break;
      }
      case "first_name":
      case "last_name": {
        const s = text(v);
        if (!s) errors[field] = `${FIELD_LABELS[field]} cannot be left empty.`;
        else if (s.length > 100) errors[field] = `${FIELD_LABELS[field]} is too long.`;
        else values[field] = s;
        break;
      }
      case "date_of_birth": {
        const d = typeof v === "string" ? canonicalDob(v) : null;
        if (!d) {
          errors.date_of_birth = "Enter a real date of birth as YYYY-MM-DD.";
        } else if (d >= new Date().toISOString().slice(0, 10)) {
          // Must be a real PAST date. String compare is safe on YYYY-MM-DD.
          errors.date_of_birth = "Date of birth must be in the past.";
        } else if (d < "1900-01-01") {
          errors.date_of_birth = "Date of birth looks wrong. Check the year.";
        } else {
          values.date_of_birth = d;
        }
        break;
      }
      case "gender": {
        // A BOOLEAN in Dentally, and only a boolean here: "male" would be truthy and
        // silently record every patient as male, so a string is refused by name.
        if (typeof v !== "boolean") errors.gender = "Gender must be true (male) or false (female).";
        else values.gender = v;
        break;
      }
      case "mobile_phone": {
        const p = typeof v === "string" || typeof v === "number" ? toE164(String(v)) : null;
        if (!p) errors.mobile_phone = "Enter a valid mobile number.";
        else values.mobile_phone = p;
        break;
      }
      case "email_address": {
        const e = typeof v === "string" ? normaliseEmail(v) : null;
        if (!e) errors.email_address = "Enter a valid email address.";
        else values.email_address = e;
        break;
      }
      case "address_line_1":
      case "address_line_2":
      case "address_line_3": {
        const s = text(v);
        if (!s) errors[field] = `${FIELD_LABELS[field]} is not valid.`;
        else if (s.length > 100) errors[field] = `${FIELD_LABELS[field]} is too long.`;
        else values[field] = s;
        break;
      }
      case "postcode": {
        const pc = typeof v === "string" ? canonicalPostcode(v) : null;
        if (!pc) errors.postcode = "Enter a valid postcode.";
        else values.postcode = pc;
        break;
      }
      case "payment_plan_id": {
        const n = typeof v === "number" ? v : Number(v);
        if (!Number.isInteger(n) || !PLAN_IDS.has(n)) errors.payment_plan_id = "Choose one of the practice's payment plans.";
        else values.payment_plan_id = n;
        break;
      }
      case "active": {
        if (typeof v !== "boolean") errors.active = "Active must be true or false.";
        else values.active = v;
        break;
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, parsed: { values, dropped } };
}

/** Read one field off a profile as the shared value union. */
function valueOf(p: PatientProfile | ProfileChanges, field: ProfileField): ProfileValue {
  const v = (p as Record<string, unknown>)[field];
  return v === undefined ? null : (v as ProfileValue);
}

/**
 * The fields whose requested value genuinely DIFFERS from the record as it stands now.
 *
 * This is what stops an edit of one field silently rewriting the other twelve with the
 * stale values a page loaded minutes ago: only what actually changed is ever sent.
 * Both sides are already canonical, so "07834 123456" vs "+447834123456" is correctly
 * seen as no change at all.
 */
export function diffProfile(current: PatientProfile, changes: ProfileChanges): ProfileField[] {
  const out: ProfileField[] = [];
  for (const field of PROFILE_FIELDS) {
    if (!(field in changes)) continue;
    if (valueOf(changes, field) !== valueOf(current, field)) out.push(field);
  }
  return out;
}

/**
 * Fields where the record moved underneath the caller: what their form was loaded with
 * (`expected`) no longer matches what Dentally holds now (`current`). Checked only for
 * the fields being changed, so two people editing different fields of the same patient
 * never block each other; a genuine collision on the SAME field is refused so the second
 * save cannot silently overwrite the first.
 */
export function detectConflicts(
  expected: PatientProfile,
  current: PatientProfile,
  fields: ProfileField[],
): ProfileField[] {
  return fields.filter((f) => valueOf(expected, f) !== valueOf(current, f));
}

/** The Dentally PUT body: only the changed fields, rebuilt from the whitelist. */
export function buildUpdatePayload(changes: ProfileChanges, changed: ProfileField[]): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of changed) {
    if (field === "active") continue; // handled by the status service, never here
    payload[field] = valueOf(changes, field);
  }
  return payload;
}

/** One audit row per changed field: the before and after value of that field. */
export interface ProfileAuditRow {
  field: ProfileField;
  from: string | null;
  to: string;
}

/** Render a value for the audit trail. Empty string means "cleared" (the column is NOT NULL). */
export function auditValue(v: ProfileValue): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/**
 * The audit trail for one edit: who changed what, from what, to what. One row per changed
 * field, so a five-field edit is five legible before/after entries rather than one opaque
 * blob. `active` is excluded because the status service writes its own richer entry.
 */
export function buildAuditRows(
  current: PatientProfile,
  changes: ProfileChanges,
  changed: ProfileField[],
): ProfileAuditRow[] {
  return changed
    .filter((f) => f !== "active")
    .map((field) => ({
      field,
      from: valueOf(current, field) === null ? null : auditValue(valueOf(current, field)),
      to: auditValue(valueOf(changes, field)),
    }));
}
