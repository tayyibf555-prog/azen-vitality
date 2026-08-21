// The catalog of owner-controllable "systems" — the automated capabilities and
// agents an owner can switch on/off. This is the single source of truth for the
// control panel UI and for mapping the messaging drain's outbox sources back to
// a module slug.
//
// Switching a system OFF stops everything it DOES to patients (its sweeps, sends,
// agent replies and public intake). It does NOT stop the read-only Dentally data
// sync, so the dashboard stays current and the practice can preview a system
// before turning it on.
//
// A system here is something that DOES work server-side (a sweep, an agent, a
// public intake, an outbound send). Passive Dentally-mirror views (calendar,
// patients, payments), pure surfaces (overview, notifications, task queue,
// conversations inbox) and owner tools (co-pilot, USPs, ROI, reports, settings)
// are NOT listed: there is nothing to "halt", so there is no switch for them.
//
// Slugs match CLIENT_NAV (src/lib/nav.ts), except the documented headless
// systems (public surfaces with no dashboard page, e.g. online-booking).
// Grouping mirrors how an owner thinks, not the sidebar categories exactly.

export interface SystemDef {
  /** CLIENT_NAV slug. */
  slug: string;
  /** Human label (kept in step with the nav label). */
  label: string;
  /** Panel grouping. */
  group: "Patient lifecycle" | "Acquisition" | "Conversational agents" | "Operations";
  /** One line: what stops the moment this is switched OFF. Owner-facing copy. */
  halts: string;
  /**
   * What the ABSENCE of a system_toggle row means for this system. Omitted (the
   * case for every system but one) keeps the platform's default-ON contract: no
   * row means enabled, which is what makes the kill switch dormant until an owner
   * uses it.
   *
   * `false` inverts that for a single slug: no row means DISABLED, for every
   * client, in every environment, including one where the seeding migration has
   * not run. A brand new SEND surface has to be default-off — a system nobody has
   * ever switched on must not start messaging patients because a row is missing —
   * and a seeded row alone cannot deliver that, because a seed only covers the
   * clients and the databases it was applied to.
   */
  defaultEnabled?: boolean;
}

export const SYSTEMS: SystemDef[] = [
  // --- Patient lifecycle (automated messaging off the Dentally record) ---
  {
    slug: "recall",
    label: "Recall concierge",
    group: "Patient lifecycle",
    halts: "No recall invites are drafted or sent, and recall sweeps stop.",
  },
  {
    slug: "reactivation",
    label: "Reactivation",
    group: "Patient lifecycle",
    halts: "Lapsed-patient reactivation messaging stops.",
  },
  {
    slug: "treatment-coordinator",
    label: "Treatment Coordinator",
    group: "Patient lifecycle",
    halts: "Treatment follow-up messaging stops.",
  },
  {
    // Headless system: the closer's engine ships before its worklist UI, so it has
    // no CLIENT_NAV page yet and its switch lives in the systems control panel.
    //
    // THE ONLY DEFAULT-OFF SYSTEM. It is a new outbound surface aimed at patients
    // the practice has already messaged through the Treatment Coordinator, so the
    // absence of a toggle row must mean OFF rather than ON. Migration 0085 also
    // seeds an explicit disabled row for 'vitality'; the two are deliberately
    // independent, because the seed only covers one client and one database.
    slug: "treatment-closer",
    label: "Treatment-plan closer",
    group: "Patient lifecycle",
    halts: "The closer stops drafting follow-ups on unfinished treatment plans, and its queue stops sending.",
    defaultEnabled: false,
  },
  {
    slug: "no-show-defence",
    label: "No-show defence",
    group: "Patient lifecycle",
    halts: "Appointment confirmations, reminders and waitlist fill stop.",
  },
  {
    slug: "reviews",
    label: "Reviews",
    group: "Patient lifecycle",
    halts: "Post-appointment review requests stop.",
  },
  {
    // Headless system (no dashboard page of its own yet; the UI is a later
    // workstream). Seeds DISABLED in migration 0041, so it only ever runs during a
    // supervised client test the owner explicitly switches on from the control
    // panel. Being in this catalog is what makes the drain fail-closed for outreach
    // (getDisabledSlugsForSend returns SYSTEM_SLUGS on a live-messaging read error).
    slug: "outreach",
    label: "Segment outreach",
    group: "Patient lifecycle",
    halts: "Segment outreach campaigns stop drafting and sending, and their sweep halts.",
  },
  {
    slug: "after-hours",
    label: "After-hours capture",
    group: "Patient lifecycle",
    halts: "After-hours missed-call capture and callback booking stop.",
  },
  // --- Acquisition (public intake + first contact) ---
  {
    slug: "speed-to-lead",
    label: "Speed-to-lead",
    group: "Acquisition",
    halts: "New enquiries are no longer auto-contacted, and intake is rejected.",
  },
  {
    slug: "smile-assessment",
    label: "Smile Assessment",
    group: "Acquisition",
    halts: "The public assessment goes offline and its follow-up stops.",
  },
  {
    slug: "onboarding",
    label: "Onboarding",
    group: "Acquisition",
    halts: "The public new-patient onboarding form goes offline.",
  },
  {
    // The FP17/PR consent + exemption declaration capture. Ships DORMANT (seeded
    // disabled in migration 0071): the wording is a legal declaration and must be
    // signed off before switch-on, so the owner turns it on here when the practice is
    // ready. Switching it off makes the public form 503 and hides the module. Nothing
    // this captures is ever submitted to the NHS (Compass).
    slug: "fp17",
    label: "NHS exemption declarations",
    group: "Acquisition",
    halts: "The public NHS consent + exemption declaration form goes offline and the module is hidden.",
  },
  {
    // Headless system: no dashboard page of its own (the switch lives in the
    // systems control panel, which renders from SYSTEMS directly). Controls the
    // PUBLIC /book page's ability to create real Dentally appointments.
    slug: "online-booking",
    label: "Online booking",
    group: "Acquisition",
    halts: "The public booking page stops taking appointments (availability stays viewable).",
  },
  // --- Conversational agents (inbound auto-reply) ---
  {
    slug: "booking-agent",
    label: "Booking agent (SMS)",
    group: "Conversational agents",
    halts: "The SMS agent stops auto-replying. Opt-out (STOP) is still honoured.",
  },
  {
    // OUTBOUND WhatsApp only: the messaging drain reads this slug to decide
    // whether a patient's WhatsApp preference may route an outgoing message to
    // WhatsApp. Migration 0047 seeds it OFF. It deliberately does NOT gate the
    // inbound agent, which has its own 'whatsapp-agent' slug below: switching
    // sending off must never silently swallow inbound patient messages.
    slug: "whatsapp",
    label: "WhatsApp sending",
    group: "Conversational agents",
    halts: "Outgoing messages stop going out over WhatsApp and use SMS instead.",
  },
  {
    // Headless system: the inbound WhatsApp agent has no page of its own (the
    // 'whatsapp' nav module is the shared WhatsApp workspace), so its switch
    // lives in the systems control panel, which renders from SYSTEMS directly.
    slug: "whatsapp-agent",
    label: "WhatsApp agent (inbound)",
    group: "Conversational agents",
    halts: "The WhatsApp agent stops auto-replying and inbound messages are flagged for a human. Opt-out is still honoured.",
  },
  // --- Operations ---
  {
    slug: "calendar-writes",
    label: "Diary appointment moves",
    group: "Operations",
    halts: "Appointments can no longer be moved, reassigned or resized from the diary.",
  },
  {
    slug: "rota",
    label: "Staff rota",
    group: "Operations",
    halts: "Auto-rota generation and staff shift texts stop.",
  },
  {
    // Headless system: policy e-signing is a PANEL inside Staff HR and My work,
    // not a nav module of its own, so its switch lives here in the control panel.
    //
    // SHIPS DORMANT (migration 0077 seeds it disabled, the FP17 precedent). What
    // this feature records is a login-bound attestation offered as CQC evidence,
    // and the practice has to agree that framing before anybody is asked to
    // affirm anything. Switching it on is a business decision, not a build step —
    // which is exactly why it needs an owner switch rather than an env flag.
    slug: "staff-esign",
    label: "Policy signatures",
    group: "Operations",
    halts: "Nobody can be asked to sign a policy and no new version can be published. Signatures already recorded are kept.",
  },
  {
    slug: "daily-brief",
    label: "Daily brief",
    group: "Operations",
    halts: "The morning brief is no longer generated.",
  },
  {
    slug: "meta-ads",
    label: "Meta Ads",
    group: "Operations",
    halts: "The ads workspace is hidden (no live spend either way).",
  },
  {
    slug: "compliance",
    label: "Compliance",
    group: "Operations",
    halts: "The compliance workspace is hidden.",
  },
];

/** Slug -> SystemDef, for quick lookups and to validate a toggle request. */
export const SYSTEM_BY_SLUG: Map<string, SystemDef> = new Map(SYSTEMS.map((s) => [s.slug, s]));

/** Every controllable slug (for API validation and tests). */
export const SYSTEM_SLUGS: string[] = SYSTEMS.map((s) => s.slug);

/**
 * The messaging drain iterates per-module outbox "sources" whose `name` is the
 * source, not the nav slug. This maps a drain source name to the system slug so
 * the drain can skip a disabled system's outbox. Only the five modules that
 * enqueue to the shared drain appear here.
 */
export const DRAIN_SOURCE_TO_SLUG: Record<string, string> = {
  // The owner's kill switch for diary moves also stops the texts those moves
  // generate: switching the write off but leaving the notice on would text a
  // patient about a change that never happened.
  diary: "calendar-writes",
  reactivation: "reactivation",
  recall: "recall",
  noshow: "no-show-defence",
  coordinator: "treatment-coordinator",
  closer: "treatment-closer",
  reviews: "reviews",
  outreach: "outreach",
};

/** Whether a slug is a real controllable system (guards toggle writes). */
export function isControllableSystem(slug: string): boolean {
  return SYSTEM_BY_SLUG.has(slug);
}

/**
 * Slugs whose ABSENT system_toggle row means DISABLED. Derived from the catalog
 * rather than maintained by hand, so declaring `defaultEnabled: false` on a
 * system is the whole of the work.
 */
export const DEFAULT_OFF_SLUGS: Set<string> = new Set(
  SYSTEMS.filter((s) => s.defaultEnabled === false).map((s) => s.slug),
);

/**
 * What the absence of a system_toggle row means for `slug`. Every read path in
 * src/lib/systems/repository.ts consults this instead of hard-coding `true`, so a
 * default-off system stays off when no row exists AND when the toggle read fails.
 * An unknown slug is treated as default-on, matching the historical behaviour for
 * anything not in the catalog.
 */
export function defaultEnabledFor(slug: string): boolean {
  return !DEFAULT_OFF_SLUGS.has(slug);
}
