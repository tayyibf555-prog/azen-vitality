// ===========================================================================
// THE CAPABILITY CATALOG.
//
// A MODULE says "may you see this area". A CAPABILITY says "may you do this
// thing". They are deliberately orthogonal and compose: a route needs both, and
// `requireCapability` never replaces `requireModuleApiAccess`.
//
// WHY THIS FILE IS PURE. No `import "server-only"`, no env, no DB, no Date. The
// server guard, the coverage sweep and the owner's admin grid all read the SAME
// catalog, and a drifted copy is how a permission screen quietly stops matching
// what the server enforces. vitest (node env) imports it directly.
//
// ---------------------------------------------------------------------------
// THE CATALOG CONTAINS ONLY KEYS THAT ARE ENFORCED. THIS IS THE WHOLE RULE.
// ---------------------------------------------------------------------------
//
// `enforcedAt` / `enforcedIn` name the exact files that must call
// `requireCapability` for the key, and
// `src/app/api/destructive-route-capability-coverage.test.ts` checks it in BOTH
// directions: every named file really calls the guard with this key, and every
// route that calls the guard is named by some key. So a key cannot exist in the
// grid while guarding nothing.
//
// That is not a style preference. A permission that enforces nothing is worse
// than an absent one, because the practice owner will tick it and believe it.
// The money keys Blerta asked for by name (delete a payment, edit an invoice,
// issue a refund) are ABSENT for exactly this reason — no payment/invoice/refund
// write path exists anywhere in this platform (money moves happen in Dentally),
// so there is no enforcement point to attach them to. Do not add them "greyed
// out". The one real member of that family is `reports.allocation.view`.
//
// The v1 catalog is therefore SMALLER than the full permission surface of the
// platform. The HR-lane keys (rota.publish, hr.view-pay, hours.view, …) were
// enforced by the interim role helpers (`requireApproverRole`, `requirePayAccess`)
// and JOINED THIS CATALOG in the integration phase, when those routes were swapped
// to `requireCapability`. Adding them before the swap would have made the
// bidirectional test a lie on day one, which is why they arrived second.
//
// ---------------------------------------------------------------------------
// TWO HR-LANE KEYS WERE ASKED FOR AND ARE STILL ABSENT. Both for the same reason.
// ---------------------------------------------------------------------------
//   `hours.export`  the month's CSV is built ENTIRELY IN THE BROWSER — `toHoursCsv`
//                   (src/lib/hours/csv.ts) runs in the client component and the
//                   file is a Blob and an anchor. There is no server CSV route in
//                   this codebase, so there is no place to enforce it. Anyone who
//                   can read the report can already save it. A key here would say
//                   otherwise and enforce nothing, which is the one thing this
//                   file forbids. It arrives the day the export becomes a route.
//   `absence.approve`  ALREADY PRESENT, under the platform's own naming:
//                   `people.absence.approve`, enforced at /api/absence/[id]. A
//                   second key for the same act is how a grid ends up with two
//                   switches for one door, one of which does nothing.
//
// TWO MORE ROUTES OMIT PAY WITHOUT APPEARING IN `hr.view-pay`'s enforcedAt, and
// deliberately: /api/hr/profile and /api/hours/month do not REFUSE a caller
// without the key, they build a response with no pay fields in it at all
// (`hasCapability`, then the fields are never read from the database). Omission is
// not refusal, so it is not enforcement, so it is not listed — but it IS pinned,
// in section 5 of destructive-route-capability-coverage.test.ts.
// ===========================================================================

/** The grid's column groups, in the order the admin screen renders them. */
export const CAPABILITY_GROUPS = [
  "diary",
  "patient",
  "clinical",
  "messaging",
  "people",
  "reports",
  "system",
  "security",
] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export interface CapabilityDef {
  /** Stable key. Written to `user_capability.capability`; never renamed casually. */
  key: string;
  group: CapabilityGroup;
  /** What the practice owner reads in the grid. Their words, not ours. */
  label: string;
  /** One sentence of consequence, shown on hover/expand in the grid. */
  description: string;
  /**
   * True = a write, a send, or something that cannot be undone.
   *
   * Drives the FAIL-CLOSED posture in `requireCapability`: every other guard in
   * this codebase no-ops when auth enforcement is off (no SUPABASE_SERVICE_ROLE_KEY),
   * which is right for the un-enforced pilot and NOT right for an irreversible
   * act. `move-service.ts` already departs from the platform default for exactly
   * this reason; encoding it here makes it DATA rather than a per-route judgement
   * somebody forgets.
   */
  destructive: boolean;
  /** Route directories under src/app/api that must call requireCapability for this key. */
  enforcedAt: readonly string[];
  /**
   * Files under src/ (not routes) that enforce it instead — a service or a page.
   * A key must name at least one of `enforcedAt` / `enforcedIn`, or it guards nothing.
   */
  enforcedIn?: readonly string[];
  /**
   * NEVER grantable and never revocable by an override — only by role.
   *
   * The escalation vector this closes: an owner grants `security.capability.manage`
   * to a coordinator, who then grants themselves everything else. `resolveCapabilities`
   * refuses the key from the override layer entirely, so the only way to hold it is
   * to BE an owner.
   */
  locked?: true;
}

/**
 * The catalog, written `as const` so `Capability` below is a union of the actual
 * keys rather than `string`. It is re-exported as `CAPABILITIES` with the
 * uniform `CapabilityDef` type, because the literal form gives each entry its
 * own exact type and the optional fields then "do not exist" on the ones that
 * omit them — which is correct and useless to every consumer.
 */
const RAW_CAPABILITIES = [
  // ------------------------------------------------------------------ diary --
  {
    key: "diary.appointment.move",
    group: "diary",
    label: "Move an appointment",
    description: "Drag, reassign or resize a booked appointment. Writes to Dentally.",
    destructive: true,
    enforcedAt: [],
    // The PATCH route delegates its whole body to performMove, so the check has to
    // live in the service or it would guard the read and not the write.
    enforcedIn: ["lib/calendar/move-service.ts"],
  },
  {
    key: "diary.appointment.cancel",
    group: "diary",
    label: "Cancel an appointment",
    description: "Cancel a booked appointment from no-show defence. Writes to Dentally.",
    destructive: true,
    enforcedAt: ["noshow/[action]"],
  },
  {
    key: "diary.entry.write",
    group: "diary",
    label: "Edit breaks and diary notes",
    description: "Add, change or remove a break, blocked time or note on the diary.",
    destructive: true,
    enforcedAt: ["diary/entry"],
  },

  // ---------------------------------------------------------------- patient --
  {
    key: "patient.profile.edit",
    group: "patient",
    label: "Edit patient details",
    description: "Change a patient's name, contact details or address. Writes to Dentally.",
    destructive: true,
    enforcedAt: ["patients/[id]/profile"],
  },
  {
    key: "patient.status.change",
    group: "patient",
    label: "Change a patient's status",
    description: "Make a patient active, inactive or do-not-contact.",
    destructive: true,
    enforcedAt: ["patients/[id]/status"],
  },
  {
    key: "patient.create",
    group: "patient",
    label: "Register a new patient",
    description: "Create a patient record from an onboarding submission. Writes to Dentally.",
    destructive: true,
    enforcedAt: ["onboarding/register"],
  },
  {
    key: "patient.note.write",
    group: "patient",
    label: "Write a practice note",
    description: "Add or edit a practice note on a patient record, typed or dictated.",
    destructive: true,
    enforcedAt: ["patient-notes", "patient-notes/transcribe"],
  },

  // --------------------------------------------------------------- clinical --
  {
    key: "clinical.chart.write",
    group: "clinical",
    label: "Chart a tooth",
    description: "Mark up the FDI chart. Becomes part of the clinical record, attributed to the author.",
    destructive: true,
    enforcedAt: ["charting/draft"],
  },
  {
    key: "clinical.perio.write",
    group: "clinical",
    label: "Record a perio exam",
    description: "Record a BPE or a full periodontal chart. Part of the clinical record.",
    destructive: true,
    enforcedAt: ["perio/[action]"],
  },
  {
    key: "clinical.medical-history.write",
    group: "clinical",
    label: "Record a medical history",
    description: "Enter or review a medical-history questionnaire on a patient's behalf.",
    destructive: true,
    enforcedAt: ["medical-history/[action]"],
  },
  {
    key: "clinical.record.retract",
    group: "clinical",
    label: "Retract a clinical record",
    description: "Withdraw a perio exam or medical history already entered. The original stays visible as retracted.",
    destructive: true,
    enforcedAt: ["perio/[action]", "medical-history/[action]"],
  },
  {
    key: "clinical.fp17.view",
    group: "clinical",
    label: "See FP17 declarations",
    description: "Read the captured NHS FP17/PR consent and exemption declarations.",
    destructive: false,
    enforcedAt: ["fp17/list"],
  },

  // -------------------------------------------------------------- messaging --
  {
    key: "messaging.patient.reply",
    group: "messaging",
    label: "Reply to a patient",
    description: "Send a message to a patient from the shared inbox.",
    destructive: true,
    enforcedAt: ["inbox/reply"],
  },
  {
    key: "messaging.lifecycle.send",
    group: "messaging",
    label: "Send a recall or reactivation message",
    description:
      "Release a drafted recall, reactivation, treatment-coordinator or treatment-plan-closer message to the patient.",
    destructive: true,
    // The closer is on this key rather than one of its own because it is the same
    // act: a drafted lifecycle message is released to a patient in the practice's
    // name. Four surfaces, one permission — an owner who withholds "release a
    // drafted message" means it, and should not have to withhold it four times.
    //
    // NOTE the closer's is on APPROVE, not on a `send` action. It has none: the
    // approval IS the release (it writes the outbox row the shared drain picks up),
    // which is also the shape the coordinator's own `send` has drifted into.
    enforcedAt: [
      "recall/[action]",
      "reactivation/[action]",
      "coordinator/[action]",
      "closer/[action]",
    ],
  },
  {
    key: "messaging.campaign.launch",
    group: "messaging",
    label: "Launch a campaign",
    description: "Start a segment-outreach campaign, which begins messaging everyone in it.",
    destructive: true,
    enforcedAt: ["outreach/campaigns/[id]"],
  },

  // ----------------------------------------------------------------- people --
  {
    key: "people.absence.request",
    group: "people",
    label: "Request time off",
    description: "Put in a holiday or absence request. Everyone who works here has this.",
    destructive: true,
    enforcedAt: ["absence"],
  },
  {
    key: "people.absence.approve",
    group: "people",
    label: "Approve time off",
    description: "Approve or refuse somebody else's holiday request.",
    destructive: true,
    enforcedAt: ["absence/[id]"],
  },
  {
    key: "people.clock.self",
    group: "people",
    label: "Clock themselves in and out",
    description: "Record their own arrival and departure.",
    destructive: true,
    enforcedAt: ["staff-check-in"],
  },
  {
    key: "people.clock.record-for-other",
    group: "people",
    label: "Clock somebody else in or out",
    description: "Record an arrival or departure on another person's behalf. Stamped as manager-recorded.",
    destructive: true,
    enforcedAt: ["staff-check-in"],
  },

  // ------------------------------------------------- people: the HR lane -----
  // Grouped with the rest of the workforce rather than given a group of their
  // own: the practice owner opening this grid is answering one question — "what
  // may this person do about our staff" — and splitting rota from hours from the
  // employee file into three column groups makes that harder to read, not easier.
  //
  // EVERY ONE OF THESE STILL SITS BEHIND ITS ROLE GUARD AS WELL. The route chain
  // is requireApproverRole (or requireOwnerRole) AND requireCapability, so the key
  // is NECESSARY AND NOT SUFFICIENT — the same posture the permissions API itself
  // takes. Revoking a key from one person works today and is what the practice
  // asked for; granting one BEYOND the role does not, and will not until the role
  // guard comes off. The one genuine swap is `hr.view-pay`, which replaced
  // `requirePayAccess` outright precisely so a named coordinator CAN be granted it.
  {
    key: "rota.view",
    group: "people",
    label: "See the rota",
    description: "Open the staff rota and read who is working when.",
    destructive: false,
    // The publish PREVIEW is a read of the rota, so it takes this key rather than
    // rota.publish: a destructive key would blank the screen she reads before
    // deciding, on every environment without sign-in configured.
    enforcedAt: ["rota/shifts", "rota/publish"],
  },
  {
    key: "rota.edit",
    group: "people",
    label: "Change the rota",
    description: "Add, move or remove a shift by hand.",
    destructive: true,
    enforcedAt: ["rota/shifts", "rota/shift/[id]"],
  },
  {
    key: "rota.publish",
    group: "people",
    label: "Publish the rota to staff",
    description: "Release a week's rota to the team. This texts real phones and cannot be unsent.",
    destructive: true,
    enforcedAt: ["rota/publish"],
  },
  {
    key: "hours.view",
    group: "people",
    label: "See the month's hours",
    description: "Read the attendance report: hours worked against hours rostered. Not payroll.",
    destructive: false,
    enforcedAt: ["hours/month"],
  },
  {
    // THE ONE PERMISSION THE PRACTICE ASKED FOR BY NAME. The practice manager runs
    // the rota, the holiday, the attendance and the month, and must not see what
    // individuals are paid — so "may open Staff HR" and "may see pay" are two
    // different questions. Off for the coordinator by default, grantable per person.
    key: "hr.view-pay",
    group: "people",
    label: "See what somebody is paid",
    description: "Read hourly rates and the cost columns on the hours report. Off for the practice manager unless granted.",
    destructive: false,
    enforcedAt: ["hr/profile/pay-rate"],
  },
  {
    key: "hr.view-documents",
    group: "people",
    label: "Open an employee document",
    description: "Read the staff file and open a contract, certificate or right-to-work document.",
    destructive: false,
    enforcedAt: ["hr/document", "hr/document/url"],
  },
  {
    key: "hr.manage-documents",
    group: "people",
    label: "Add or replace an employee document",
    description: "Upload a document into somebody's staff file.",
    destructive: true,
    enforcedAt: ["hr/document"],
  },
  {
    key: "esign.manage-policies",
    group: "people",
    label: "Publish a policy for signing",
    description: "Put a policy in front of every member of staff and ask them to affirm it. A new version can never be edited afterwards.",
    destructive: true,
    enforcedAt: ["hr/policy"],
  },

  // ---------------------------------------------------------------- reports --
  {
    key: "reports.run",
    group: "reports",
    label: "Run a report",
    description: "Generate a practice report over the patient and appointment data.",
    destructive: false,
    enforcedAt: ["reports/generate"],
  },
  {
    key: "reports.nhs.view",
    group: "reports",
    label: "See the NHS reports",
    description: "Read the NHS activity and completion reports, including the per-clinician breakdowns.",
    destructive: false,
    enforcedAt: ["reports/nhs-activity", "reports/nhs-clinical"],
  },
  {
    key: "reports.allocation.view",
    group: "reports",
    label: "See the payment allocation report",
    description: "Read which payments settled which invoices.",
    destructive: false,
    enforcedAt: ["reports/payment-allocation"],
  },

  // ----------------------------------------------------------------- system --
  {
    key: "system.toggle",
    group: "system",
    label: "Switch a system on or off",
    description: "Use the master kill switch. Off halts that system's work everywhere.",
    destructive: true,
    enforcedAt: ["systems"],
  },
  {
    key: "system.copilot.ask",
    group: "system",
    label: "Ask the co-pilot",
    description: "Query the practice co-pilot, which can read across the practice's data.",
    destructive: false,
    enforcedAt: ["copilot"],
  },

  // --------------------------------------------------------------- security --
  {
    key: "security.capability.manage",
    group: "security",
    label: "Change what people can do",
    description: "Open this screen and change anyone's permissions. Cannot be granted here — it comes with being an owner.",
    destructive: true,
    enforcedAt: ["permissions"],
    locked: true,
  },
] as const satisfies readonly CapabilityDef[];

/** Every capability key in the platform, as a union. */
export type Capability = (typeof RAW_CAPABILITIES)[number]["key"];

/** The catalog, uniformly typed. Iterate this; `Capability` comes from the raw form. */
export const CAPABILITIES: readonly CapabilityDef[] = RAW_CAPABILITIES;

const BY_KEY: ReadonlyMap<string, CapabilityDef> = new Map(CAPABILITIES.map((c) => [c.key, c]));

/** Every key, in catalog order. */
export const CAPABILITY_KEYS: readonly Capability[] = CAPABILITIES.map((c) => c.key as Capability);

/**
 * Keys that can never be granted or revoked by a per-person override.
 *
 * Read from the catalog rather than retyped, so marking a key `locked` is the
 * single act that locks it.
 */
export const LOCKED_CAPABILITIES: ReadonlySet<string> = new Set(
  CAPABILITIES.filter((c) => c.locked).map((c) => c.key),
);

/** Keys whose act is a write, a send, or otherwise irreversible. */
export const DESTRUCTIVE_CAPABILITIES: ReadonlySet<string> = new Set(
  CAPABILITIES.filter((c) => c.destructive).map((c) => c.key),
);

/** True when this string is a key in the catalog. Unknown strings are NEVER capabilities. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === "string" && BY_KEY.has(value);
}

/** True when the act behind this key cannot be undone. Unknown keys are treated as destructive. */
export function isDestructive(key: string): boolean {
  const def = BY_KEY.get(key);
  // FAIL CLOSED on an unknown key: "we do not recognise it" is not a reason to
  // treat an act as safe.
  return def ? def.destructive : true;
}

/** True when this key can never be moved by an override. */
export function isLocked(key: string): boolean {
  return LOCKED_CAPABILITIES.has(key);
}
