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
  /**
   * Panel grouping.
   *
   * "Dentally" is a group of ONE and is meant to be. Every other group here
   * collects systems of a kind; this one holds the master lever over what the
   * whole platform writes back to the practice's Dentally account, and it was
   * filed under "Operations" between Compliance and the IT desk — a switch that
   * governs nine modules sitting in a list as though it were a tenth. It has its
   * own heading so the question it answers ("does any of this reach Dentally?")
   * is asked and answered in one place, next to the Dentally sync tab that
   * records what it held back.
   */
  group: "Patient lifecycle" | "Acquisition" | "Conversational agents" | "Operations" | "Dentally";
  /** One line: what stops the moment this is switched OFF. Owner-facing copy. */
  halts: string;
  /**
   * What the ABSENCE of a system_toggle row means for this system. Omitted (the
   * case for most systems) keeps the platform's default-ON contract: no row means
   * enabled, which is what makes the kill switch dormant until an owner uses it.
   *
   * `false` inverts that: no row means DISABLED, for every client, in every
   * environment, including one where the seeding migration has not run. A brand
   * new SEND surface has to be default-off — a system nobody has ever switched on
   * must not start messaging patients because a row is missing — and a seeded row
   * alone cannot deliver that, because a seed only covers the clients and the
   * databases it was applied to. The same reasoning covers a system that does not
   * send but does make an ASSERTION to the practice about its own numbers.
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
    // THE FIRST DEFAULT-OFF SYSTEM. There are several now; DEFAULT_OFF_SLUGS at
    // the foot of this file is the live list, derived from the catalog itself,
    // so the count is never restated in prose and cannot go stale. This one is a
    // new outbound surface aimed at patients the practice has already messaged
    // through the Treatment Coordinator, so the absence of a toggle row must
    // mean OFF rather than ON. Migration 0085 also seeds an explicit disabled
    // row for 'vitality'; the two are deliberately independent, because the seed
    // only covers one client and one database.
    slug: "treatment-closer",
    label: "Treatment-plan closer",
    group: "Patient lifecycle",
    halts: "The closer stops drafting follow-ups on unfinished treatment plans, and its queue stops sending.",
    defaultEnabled: false,
  },
  {
    // Headless system: the post-op engine ships before its worklist UI, so it has no
    // CLIENT_NAV page yet and its switch lives in the systems control panel.
    //
    // DEFAULT-OFF, for the same reason as the treatment-closer and with more force.
    // It is a brand new outbound surface aimed at patients who have just had a tooth
    // out, and the reply path is the most compliance-sensitive in the platform: the
    // absence of a toggle row must mean OFF rather than ON. Migration 0091 also seeds
    // an explicit disabled row for 'vitality'; the two are deliberately independent,
    // because the seed only covers one client and one database.
    //
    // Switching it OFF halts the sweep and the outbox. It does NOT stop an inbound
    // reply being triaged and escalated: a switch the practice flipped afterwards
    // must never be the reason a patient's symptom went unseen. See
    // src/lib/postop/inbound.ts.
    slug: "postop-checkin",
    label: "Post-op check-in",
    group: "Patient lifecycle",
    halts: "No aftercare check-ins are drafted, and its queue stops sending. Replies are still triaged and escalated to a person.",
    defaultEnabled: false,
  },
  {
    // Headless system: the engine ships before its worklist UI, so it has no
    // CLIENT_NAV page yet and its switch lives in the systems control panel.
    //
    // DEFAULT-OFF, for the same reason the closer is and then some. It is a new
    // outbound surface that tells patients they owe the practice money, so the
    // absence of a toggle row must mean OFF rather than ON. Migration 0090 also
    // seeds an explicit disabled row for 'vitality'; the two are deliberately
    // independent, because the seed only covers one client and one database.
    //
    // NOTE THE LABEL. It is what an owner sees in the control panel, and "Balance
    // reminders" is what this is: a reminder about an invoice. Anything with
    // "collection" or "chasing" in it would describe a thing this module refuses
    // to be, and its own compliance scan refuses every word that would make it one.
    slug: "balance-reminders",
    label: "Balance reminders",
    group: "Patient lifecycle",
    halts:
      "No reminders are drafted about unpaid invoices, and any approved ones stop sending.",
    defaultEnabled: false,
  },
  {
    // The pre-appointment questionnaire + treatment-interest capture. It has a
    // CLIENT_NAV page of its own (the question-bank editor, the interest lists and
    // the mining list), so it is not headless.
    //
    // DEFAULT-OFF, and it needs to be for two independent reasons rather than the
    // usual one. It is a new outbound surface, like the closer and post-op: the
    // absence of a toggle row must never be why a patient receives the first text
    // from a system nobody switched on. AND it is a surface that ASKS A PATIENT
    // QUESTIONS ABOUT THEIR MOUTH, where which questions depends on a fork resolved
    // from their payment plan — so switching it on is a decision the practice takes
    // with its contract in mind, not a build step. Migration 0097 also seeds an
    // explicit disabled row for 'vitality'; the two are deliberately independent,
    // because a seed only covers the clients and the databases it was applied to.
    //
    // Switching it OFF halts the sweep, the queue AND the public form: an already
    // sent link stops opening, so a flip is a complete revert rather than a stop
    // with a live form still collecting answers behind it.
    //
    // AND IT HALTS THE IMPLANT SCAN, which the sentence below now says out loud
    // (ruling W3/21, wave-3 review). The implant-candidate list is the other half
    // of this module and it is fail-CLOSED under this one switch: both of its
    // doors ask `isSystemEnabled(client, TRIAGE_SYSTEM_SLUG)` before they read a
    // single patient — the scheduler's (src/app/api/previsit/mining-sweep) and
    // the owner's own "Build / refresh candidates" button, which posts to
    // src/app/api/previsit/mining-run. A practice that switches this off should
    // not find the implant list has grown anyway, and an owner deciding whether
    // to switch it off should be told that is what happens. There is no separate
    // mining switch: one is a LEDGER item for the client (W3/21), not a thing
    // this row may quietly imply. catalog.test.ts derives the requirement from
    // the two route files rather than from this comment.
    slug: "pre-visit-triage",
    label: "Pre-visit questions",
    group: "Patient lifecycle",
    halts:
      "No pre-visit questionnaires are sent, any queued ones stop sending, and links already sent stop opening. " +
      "Answers already given are kept, and the implant-candidate list stops growing: neither its nightly scan nor " +
      "the owner's Build / refresh candidates button on the pre-visit page adds to it while this is off.",
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
    // Headless system: this is a behaviour of the booking agent rather than a
    // module, so it has no CLIENT_NAV page and its switch lives in the systems
    // control panel.
    //
    // DEFAULT-OFF. It does not send anything by itself, but it changes what the
    // agent SAYS to a patient, and the absence of a toggle row must never be the
    // reason the practice's 24/7 agent starts opening conversations differently
    // from the way it opened them yesterday. Switching it off is also the exact
    // revert: with no context resolved the agent is byte-for-byte its old self.
    // Migration 0092 seeds an explicit disabled row for 'vitality'; the two are
    // deliberately independent, because a seed only covers the clients and the
    // databases it was applied to.
    slug: "booking-reply-context",
    label: "Booking reply context",
    group: "Conversational agents",
    halts:
      "The booking agent stops recognising which invite a reply answers, and treats every reply as a brand new conversation.",
    defaultEnabled: false,
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
    // THE SENTENCE NAMES BOTH DOORS, because the switch closes both (ruling
    // W3/2, wave-3 review). This row used to describe the desk alone — "from the
    // diary" — and it was written when the diary WAS the only way to change an
    // appointment. It is not any more: the co-pilot's `diary_write` tool books,
    // moves and cancels, and all three of its kinds resolve to THIS slug
    // (src/lib/dentally/write-vocabulary.ts, `copilot.slugByKind`), so an owner
    // who switches this off and watches the desk refuse a drag cannot then move
    // the same appointment by asking for it in a sentence.
    //
    // The behaviour landed first and this sentence was behind it, which is the
    // wrong way round for a kill switch: the row is what the owner reads while
    // deciding whether one flip is enough. Ruling W3/9 — copy matches code,
    // never the reverse — and catalog.test.ts derives the requirement from the
    // write registry rather than from this comment, so a kind that stops
    // resolving `calendar-writes` turns the assertion red instead of leaving the
    // sentence quietly over-promising.
    slug: "calendar-writes",
    label: "Diary appointment moves",
    group: "Operations",
    halts:
      "Appointments can no longer be moved, reassigned or resized from the diary — and the co-pilot cannot book, move or cancel one either.",
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
    // Headless system: the alerts appear inside Notifications rather than on a
    // page of their own, so the switch lives here in the control panel.
    //
    // DEFAULT-OFF, and for a different reason from the sending systems. This one
    // never messages a patient — it never messages anyone, it writes a row that
    // the in-app feed reads — but it does tell a practice owner that their
    // takings are down, and an alert that turns out to be an artefact of a
    // truncated scan costs more trust than the feature earns. It ships off so a
    // week of its output can be read by a person before anybody relies on it.
    // Migration 0093 also seeds an explicit disabled row for 'vitality'; the two
    // are deliberately independent, because a seed only covers the clients and
    // the databases it was applied to.
    //
    // Switching it OFF halts the pass AND hides the alerts already raised: the
    // notifications source consults this same switch, so a flip is a complete
    // and immediate revert rather than a stop with residue on the screen.
    slug: "anomaly-alerts",
    label: "Proactive alerts",
    group: "Operations",
    halts:
      "Nothing is watched for takings dips, no-show clusters, uncontacted enquiries or stuck queues, and any alerts already raised stop showing in Notifications.",
    defaultEnabled: false,
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
  {
    // DEFAULT-OFF, and for the anomaly-alerts reason rather than the sending one:
    // it messages nobody, but it ANSWERS A MEMBER OF STAFF STANDING AT A MACHINE,
    // and an answer given before the practice has loaded its own manuals is an
    // answer from nothing. It ships off so the register and the manuals go in
    // first and somebody reads what it says before anyone relies on it.
    // Migration 0098 also seeds an explicit disabled row for 'vitality'; the two
    // are deliberately independent, because a seed only covers the clients and
    // the databases it was applied to.
    //
    // Switching it OFF halts the AGENT only — the chat refuses and no model call
    // is made. The register and the manuals stay reachable and editable, because
    // they are the management surface for this system and they have to be
    // loadable BEFORE it is switched on. That is why the slug is in
    // NAV_SWITCH_EXEMPT_SLUGS (src/lib/nav.ts), exactly like Segment outreach.
    slug: "equipment",
    label: "Equipment desk",
    group: "Operations",
    halts:
      "The equipment desk stops answering questions. The asset register and the uploaded manuals stay readable and editable.",
    defaultEnabled: false,
  },
  {
    // DEFAULT-OFF for the same reason as the equipment desk, plus one of its own:
    // its whole job at the end of a playbook is to hand somebody the practice's
    // IT contact, and until that contact has been set the hand-off has nowhere to
    // go. Migration 0099 also seeds an explicit disabled row for 'vitality'.
    //
    // Switching it OFF halts the AGENT only. The playbooks and the IT contact
    // stay readable, because a receptionist may need both at the exact moment the
    // owner has the agent switched off.
    slug: "it-desk",
    label: "IT desk",
    group: "Operations",
    halts:
      "The IT desk stops answering questions. The troubleshooting playbooks and the practice's IT contact stay readable.",
    defaultEnabled: false,
  },
  {
    // THE MASTER SWITCH OVER EVERYTHING THIS PLATFORM WRITES BACK TO DENTALLY.
    //
    // Headless: it is not a module, it is a lever ABOVE nine of them. Every
    // outbound Dentally write — a new appointment, a move, a cancellation, a new
    // patient, an edit — passes the WriteGate (src/lib/dentally/write-gate.ts),
    // and the gate checks THIS switch before it checks the switch on the module
    // that asked. So an owner who wants everything to stop reaching their
    // Dentally book flips one control rather than finding nine.
    //
    // IT COMPOSES WITH THE ENVIRONMENT, IT DOES NOT REPLACE IT. The agency arms
    // the deployment (DENTALLY_WRITE_ENABLED + a write key + an explicit write
    // base URL) and the owner arms the practice (this switch). Both must be on
    // before one write leaves this platform, and either one alone stops all of
    // them. That is deliberate: neither party can turn on writes to 51,000 live
    // patient records without the other.
    //
    // DEFAULT-OFF, twice, per the platform's own rule for anything that acts on a
    // patient: `defaultEnabled: false` here means the ABSENCE of a row is OFF for
    // every client in every environment, and migration 0096 also seeds an
    // explicit disabled row for 'vitality'. The two are independent, because a
    // seed covers only the clients and the databases it was applied to.
    //
    // THE ONE PLACE ITS ABSENCE IS NOT READ AS OFF is a deployment where writes
    // are only SIMULATED — no write key, so nothing can reach a real book anyway.
    // There the gate treats a missing row as on, so a developer's machine and the
    // local mock keep working; the moment the deployment is armed for real, a
    // missing or unreadable row is a refusal. See isSystemExplicitlyDisabled in
    // src/lib/systems/repository.ts, which exists for exactly this switch.
    //
    // Switching it OFF stops the WRITES. It does not touch the read-only Dentally
    // sync, so the diary, the patient list and the money screens stay current —
    // and every write it stops is recorded on the Dentally sync screen, so the
    // practice can see what did not go across.
    slug: "dentally-write-back",
    label: "Dentally write-back",
    // ITS OWN GROUP, of one (Dental OS wave 2). See the `group` field's comment:
    // a lever ABOVE nine modules does not belong in a list of modules, and the
    // control panel draws this group last, beside the Dentally sync tab that
    // shows every write it held back.
    group: "Dentally",
    halts:
      "Nothing this platform does is written back to Dentally: no appointments are created, moved or cancelled there, and no patient records are created or edited there. Everything still works here, and the Dentally sync screen records what was held back.",
    defaultEnabled: false,
  },
];

/** Slug -> SystemDef, for quick lookups and to validate a toggle request. */
export const SYSTEM_BY_SLUG: Map<string, SystemDef> = new Map(SYSTEMS.map((s) => [s.slug, s]));

/** Every controllable slug (for API validation and tests). */
export const SYSTEM_SLUGS: string[] = SYSTEMS.map((s) => s.slug);

/**
 * The messaging drain iterates per-module outbox "sources" whose `name` is the
 * source, not the nav slug. This maps a drain source name to the system slug so
 * the drain can skip a disabled system's outbox. Only the modules that enqueue
 * to the shared drain appear here.
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
  collection: "balance-reminders",
  postop: "postop-checkin",
  previsit: "pre-visit-triage",
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
