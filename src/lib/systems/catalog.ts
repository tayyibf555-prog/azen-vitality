// The catalog of owner-controllable "systems" — the automated capabilities and
// agents an owner can switch on/off. This is the single source of truth for the
// control panel UI and for mapping the messaging drain's outbox sources back to
// a module slug.
//
// A system here is something that DOES work server-side (a sweep, an agent, a
// public intake, an outbound send). Passive Dentally-mirror views (calendar,
// patients, payments), pure surfaces (overview, notifications, task queue,
// conversations inbox) and owner tools (co-pilot, USPs, ROI, reports, settings)
// are NOT listed: there is nothing to "halt", so there is no switch for them.
//
// Slugs match CLIENT_NAV (src/lib/nav.ts). Grouping mirrors how an owner thinks,
// not the sidebar categories exactly.

export interface SystemDef {
  /** CLIENT_NAV slug. */
  slug: string;
  /** Human label (kept in step with the nav label). */
  label: string;
  /** Panel grouping. */
  group: "Patient lifecycle" | "Acquisition" | "Conversational agents" | "Operations";
  /** One line: what stops the moment this is switched OFF. Owner-facing copy. */
  halts: string;
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
    halts: "Treatment follow-up messaging and the plan sync stop.",
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
  // --- Conversational agents (inbound auto-reply) ---
  {
    slug: "booking-agent",
    label: "Booking agent (SMS)",
    group: "Conversational agents",
    halts: "The SMS agent stops auto-replying. Opt-out (STOP) is still honoured.",
  },
  {
    slug: "whatsapp",
    label: "WhatsApp agent",
    group: "Conversational agents",
    halts: "The WhatsApp agent stops auto-replying. Opt-out is still honoured.",
  },
  // --- Operations ---
  {
    slug: "rota",
    label: "Staff rota",
    group: "Operations",
    halts: "Auto-rota generation and staff shift texts stop.",
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
  reactivation: "reactivation",
  recall: "recall",
  noshow: "no-show-defence",
  coordinator: "treatment-coordinator",
  reviews: "reviews",
};

/** Whether a slug is a real controllable system (guards toggle writes). */
export function isControllableSystem(slug: string): boolean {
  return SYSTEM_BY_SLUG.has(slug);
}
