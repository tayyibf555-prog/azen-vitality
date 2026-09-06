// ===========================================================================
// EVERY AGENT IN THE PLATFORM, AND THE FIVE THINGS THAT HAVE TO BE TRUE OF ONE.
//
// The programme's mandate for this lane is "all AI agents working where they
// need to be". That sentence is not checkable until somebody writes down what
// "an agent" is, so this file does: a trigger, a guard, a drafter, an outbox (or
// an explicit statement that it sends directly), and a place on the patient's
// record. All of them, in one list, with the exact file that does each part.
//
// AND NO TOTAL IS WRITTEN DOWN IN THIS PARAGRAPH, deliberately. It used to say
// how many there were, and that was the roster's size on the day the file was
// written rather than its size now: the list outgrew the sentence, and the
// sentence went on being read as the roster's own count of what it covers — by
// an auditor scoring the charter's enumeration against it, that reads as agents
// MISSING when in fact extra ones are present. The runbook's opening line had
// the identical defect and is now pinned against it:
// runbook.test.ts, "does not restate a total number of agents in the opening line".
// This header is pinned the same way by
// roster.test.ts, "states no fixed agent count in its header or its test names".
// `AGENTS.length` is the only answer that cannot go stale.
//
// WHAT IS PINNED INSTEAD IS THE MEMBERSHIP:
// roster.test.ts, "covers every agent the programme charter lists"
// holds the charter's own §2 W1-B names by key, so none of them can quietly
// leave. `pre-visit-triage`, `outreach` and `diary-notify` were rostered on top
// of that list after it was written, which is why this roster is LONGER than the
// charter's enumeration rather than shorter.
//
// WHY A RECORD AND NOT PROSE. The codebase already had three partial registries
// pulling in three directions:
//
//   src/lib/systems/catalog.ts     what an OWNER can switch off
//   src/lib/inbox/send-sites.ts    what can put a message on the WIRE
//   src/lib/inbox/repository.ts    what the patient's RECORD reads
//
// Each is complete about its own question and silent about the others, so an
// agent could be in all three and still be broken between them — a sweep with no
// toggle read, a drafter whose row nothing drains, an outbox nothing records.
// That is precisely the class of defect this lane found (see `gaps` below). This
// roster is the join, and roster.test.ts fails when the join breaks in either
// direction.
//
// IT IS ALSO THE RUNBOOK'S SOURCE. docs/runbooks/agent-switch-on.md answers, per
// agent, "what does switching this on start, what does it need first, how do I
// see it working, how do I stop it" — and a test asserts the runbook names every
// key here, so a new agent cannot ship with no switch-on instructions.
// ===========================================================================

/** How the message a patient receives is composed. */
export type DraftKind =
  /** Fixed wording in our own source. No model call, no variance. */
  | "templated"
  /** Claude composes it. Every one of these has an output guardrail after it. */
  | "llm"
  /** Nothing is drafted: the agent decides, routes or alerts, but never speaks. */
  | "none";

/**
 * Who an agent's messages go to. Only "patient" needs a place on the record: a
 * rota text to a nurse filed under a patient of the same name would be its own
 * defect. Mirrors SendAudience in src/lib/inbox/send-sites.ts on purpose.
 */
export type AgentAudience = "patient" | "staff" | "nobody";

/** How a drafted message becomes a sent one. */
export type SendPath =
  /** Row lands in the module's own outbox; the shared drain delivers it. */
  | "drain"
  /** sendMessage is called in-request. Speed matters more than batching. */
  | "direct"
  /** This agent never sends anything at all. */
  | "none";

export interface AgentDef {
  /** Stable key. Used by the scenario suite and the runbook's headings. */
  key: string;
  label: string;
  /**
   * The owner switch in src/lib/systems/catalog.ts that halts it, or null when
   * the agent has no switch of its own (then `slugNote` says what governs it).
   */
  slug: string | null;
  slugNote?: string;
  /** Repo-relative file whose handler starts this agent. */
  trigger: string;
  /**
   * Repo-relative file where the owner kill switch is actually read for this
   * agent, or null when nothing reads it (a gap, and `gaps` must say so).
   */
  guard: string | null;
  draft: DraftKind;
  /** Repo-relative file that composes the message, if it composes one. */
  drafter: string | null;
  audience: AgentAudience;
  sendPath: SendPath;
  /** The drain SOURCES name, which must also be a DRAIN_SOURCE_TO_SLUG key. */
  drainSource: string | null;
  /**
   * Correspondence sources (CORRESPONDENCE_SOURCE_NAMES) where this agent's
   * outbound messages appear on a patient's record. Empty ONLY for an agent that
   * sends nothing to a patient, and then `recordNote` says why.
   */
  correspondence: readonly string[];
  recordNote?: string;
  /** Env vars / external configuration required before it can work at all. */
  needs: readonly string[];
  /** What the FIRST tick after switch-on actually does. */
  firstTick: string;
  /** What bounds the volume of that first tick. */
  bound: string;
  /** Where a person looks in the first hour to see it working. */
  verify: string;
  /** How to stop it. */
  stop: string;
  /** Known residual gaps, stated rather than hidden. */
  gaps: readonly string[];
}

export const AGENTS: readonly AgentDef[] = [
  // -------------------------------------------------------------------------
  // Acquisition
  // -------------------------------------------------------------------------
  {
    key: "smile-assessment",
    label: "Smile Assessment",
    slug: "smile-assessment",
    trigger: "src/app/api/smile-assessment/submit/route.ts",
    guard: "src/app/api/smile-assessment/submit/route.ts",
    draft: "llm",
    drafter: "src/lib/speed-to-lead/draft.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent", "speed-to-lead"],
    needs: ["SMILE_ASSESSMENT_SUBMIT_KEY", "PUBLIC_BASE_URL"],
    firstTick:
      "The public /assess pages come online. A submission that clears the follow-up band " +
      "becomes a speed-to-lead lead and is texted within the request.",
    bound:
      "One message per submission, and only for a submission the follow-up config selects; " +
      "a medium-band enquiry lands on the task queue for a person instead.",
    verify:
      "Leads → the new lead appears with a first-contact attempt; Conversations shows the " +
      "outbound turn. Server log: the submit route's response carries contacted:true.",
    stop: "Switch off 'smile-assessment' (the public pages 503) or 'speed-to-lead' (nothing is texted).",
    gaps: [
      "DOUBLE-GATED on purpose: the auto-contact needs BOTH smile-assessment and speed-to-lead on. " +
        "Switching smile-assessment on alone publishes the form and contacts nobody.",
    ],
  },
  {
    key: "speed-to-lead",
    label: "Speed-to-lead",
    slug: "speed-to-lead",
    trigger: "src/app/api/speed-to-lead/sweep/route.ts",
    guard: "src/app/api/speed-to-lead/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/speed-to-lead/draft.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent", "speed-to-lead"],
    needs: ["SPEED_TO_LEAD_INTAKE_KEY", "TWILIO_* sender", "PUBLIC_BASE_URL"],
    firstTick:
      "Every uncontacted lead inside the 48-hour window is drafted and texted on the next " +
      "minute's tick, then the nurture cadence follows up the ones who never replied.",
    // Three is MAX_FAILED_CONTACT_ATTEMPTS in src/lib/speed-to-lead/contact.ts —
    // a source constant with no environment override, so there is nothing for an
    // owner to set and nothing for `needs` to carry. The sentence states the
    // number, which is the whole of the answer to "what bounds this".
    bound:
      "The sweep runs every minute and takes leads in age order; a lead that fails to deliver " +
      "is retried at most three times before it needs a person.",
    verify: "Leads worklist → stage moves new → contacted, with an attempt row and a first-response time.",
    stop: "Switch off 'speed-to-lead'. Intake is rejected and nothing is auto-contacted.",
    gaps: [
      // THE COUNT IS DERIVED, NOT REMEMBERED. "all four callers" was true when it
      // was written and was four doors short by the time anybody read it again:
      // the co-pilot's nudge_lead, the missed-call bridge and the smile-assessment
      // submit path all reach the same primitive now. "the roster's speed-to-lead
      // gap sentence names as many callers as the crawl finds" in roster.test.ts
      // recomputes the word below from the crawl, so it cannot silently drift a
      // second time.
      "contactLead itself reads no toggle: all six callers gate it, pinned by a source crawl " +
        "in roster.test.ts rather than by a guard inside the function — and that crawl can " +
        "only see that a switch was read, never which way it fails. So a second crawl beside " +
        "it requires every one of those doors to use the fail-closed read, where a switch " +
        "nobody can reach counts as off; the staff worklist's Resend, the last of them to " +
        "move, is pinned by its own test in resend-switch.test.ts.",
    ],
  },
  {
    key: "missed-call-bridge",
    label: "Missed-call text-back",
    slug: "after-hours",
    trigger: "src/app/api/webhooks/twilio/voice/route.ts",
    guard: "src/app/api/webhooks/twilio/voice/route.ts",
    draft: "llm",
    drafter: "src/lib/after-hours/callback-copy.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent", "speed-to-lead"],
    needs: [
      "the practice's Twilio number Voice webhook pointed at /api/webhooks/twilio/voice",
      "PUBLIC_BASE_URL byte-matching the Twilio console URL (or the signature check 403s every call)",
      "the practice's own line forwarding on no-answer to the Twilio number",
    ],
    firstTick:
      "A missed call is captured and the caller is texted back; where the number is new it also " +
      "becomes a speed-to-lead lead so the booking agent picks up the reply.",
    bound: "One text per call, deduped against an existing open lead for the same number.",
    verify:
      "After-hours worklist → the capture row; Conversations → the outbound callback text. " +
      "Twilio console → the Voice webhook returning 200.",
    stop: "Switch off 'after-hours'.",
    gaps: [
      "This has NEVER been wired end to end: no Twilio number is known to point its Voice webhook here. " +
        "The code path is live-tested only against a synthetic request.",
    ],
  },
  {
    // WHERE THE DECISIONS BEHIND THIS ENTRY ARE RECORDED: ruling W1-B/4 (the two
    // switches this rescue needs, and its narrow transactional basis) and ruling
    // W1-B/5 (the shared ten-row gate on the host sweep), both in the programme's
    // decisions log.
    //
    // THEY ARE CITED HERE AND NOT IN THE STRINGS BELOW, which is a change made on
    // 5 September 2026. Eight of this Record's fields are read straight back to a
    // practice owner — `slugNote`, `bound` and `gaps` among them, through the
    // co-pilot's agent_status and the control panel — and three of these sentences
    // ended in an internal code. To the owner, "Ruling W1-B/4, 3 Sep 2026" inside
    // an answer about his own platform is a reference he cannot resolve, and it
    // makes a settled fact read like an unfinished note. It is the same argument
    // that deleted a lane-ownership hedge from the pre-visit entry below
    // (roster.test.ts, "names no build lane as the owner of anything"): a comment
    // is where a build decision is traced; owner copy states the decision itself.
    key: "abandoned-booking-rescue",
    label: "Abandoned-booking rescue",
    slug: null,
    slugNote:
      "No switch of its own, and it needs TWO to run: 'speed-to-lead' (the machinery it feeds) AND " +
      "'online-booking' (the flow it invites the patient back into). An owner who has switched " +
      "online booking off has switched off the page this text points at.",
    trigger: "src/lib/booking/abandoned-holds.ts",
    guard: "src/app/api/speed-to-lead/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/speed-to-lead/draft.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent", "speed-to-lead"],
    needs: [],
    firstTick:
      "A booking hold abandoned for 20 minutes becomes a lead, which the same sweep then " +
      "first-contacts like any other.",
    bound:
      "At most 25 holds converted per tick, and — because the host sweep re-reads its switch as it " +
      "goes — drafting stops within ten rows of the switch being turned " +
      "off mid-run, rather than at the end of the batch.",
    verify: "Leads → a lead with source 'booking' and an attempt row.",
    stop: "Switch off 'speed-to-lead'.",
    gaps: [
      "Its basis is narrow ON PURPOSE: one transactional follow-up about the booking " +
        "the patient started, never marketing. It is excluded from the nurture cadence at both of " +
        "listNurtureDue's selection queries, and the lead records consent source 'booking-form'.",
    ],
  },
  {
    key: "online-booking",
    label: "Online booking",
    slug: "online-booking",
    trigger: "src/app/api/booking/create/route.ts",
    guard: "src/app/api/booking/create/route.ts",
    draft: "none",
    drafter: null,
    audience: "nobody",
    sendPath: "none",
    drainSource: null,
    correspondence: [],
    recordNote:
      "Booking writes an appointment; it says nothing to the patient, so there is nothing for the " +
      "Correspondence tab to hold. The confirmation the patient gets is Dentally's, not ours.",
    needs: ["DENTALLY_DEFAULT_PAYMENT_PLAN_ID", "a Dentally key with write scope", "DENTALLY_WRITE_ENABLED"],
    firstTick: "The public /book page starts creating real Dentally appointments from held slots.",
    bound: "One appointment per completed hold; holds expire after 20 minutes.",
    verify: "The diary shows the new appointment; the booking route returns the Dentally appointment id.",
    stop: "Switch off 'online-booking'. Availability stays viewable; nothing can be booked.",
    gaps: [
      "The create route reads the switch with isSystemEnabledStrict (fail CLOSED) while the hold " +
        "route reads it fail-open, on purpose: a hold is reversible, a booking is not.",
      "Slot duration on live Dentally is uncalibrated (see docs/runbooks/booking-live-calibration.md).",
    ],
  },
  // -------------------------------------------------------------------------
  // Conversational
  // -------------------------------------------------------------------------
  {
    key: "booking-agent",
    label: "Booking agent (SMS)",
    slug: "booking-agent",
    trigger: "src/app/api/webhooks/twilio/inbound/route.ts",
    guard: "src/app/api/webhooks/twilio/inbound/route.ts",
    draft: "llm",
    drafter: "src/lib/agent/run.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent"],
    needs: ["TWILIO_* sender", "the SMS number's Messaging webhook pointed at /api/webhooks/twilio/inbound"],
    firstTick: "Every inbound SMS gets an agent reply within the request. STOP is honoured either way.",
    // 20 an hour is AGENT_SENDER_BUDGET_LIMIT / AGENT_SENDER_BUDGET_WINDOW (3600s)
    // in src/app/api/webhooks/twilio/inbound/route.ts. Both have defaults and
    // neither is required for the agent to work, so they do not belong in `needs`
    // ("required before it can work at all") and the name would be unreadable in
    // an agent_status answer. The figure is the answer; the names live here.
    bound:
      "At most 20 agent replies an hour to any one number, by default: somebody texting the " +
      "practice number over and over cannot run the model without limit.",
    verify: "Conversations → a two-way thread with agent turns.",
    stop: "Switch off 'booking-agent'. Inbound messages are flagged for a human; opt-out still works.",
    gaps: [
      "Booking into real Dentally still needs DENTALLY_DEFAULT_PAYMENT_PLAN_ID; without it the " +
        "agent refuses early and routes to the onboarding form rather than 422-ing mid-conversation.",
    ],
  },
  {
    key: "whatsapp-agent",
    label: "WhatsApp agent (inbound)",
    slug: "whatsapp-agent",
    trigger: "src/app/api/webhooks/twilio/inbound/route.ts",
    guard: "src/app/api/webhooks/twilio/inbound/route.ts",
    draft: "llm",
    drafter: "src/lib/agent/run.ts",
    audience: "patient",
    sendPath: "direct",
    drainSource: null,
    correspondence: ["agent"],
    needs: ["the client's Meta Business login", "TWILIO_WHATSAPP_FROM"],
    firstTick: "Inbound WhatsApp messages get an agent reply, on the same route as SMS.",
    bound: "The same 20-an-hour per-sender budget as the SMS agent, on the same route.",
    verify: "Conversations → a thread whose channel is WhatsApp.",
    stop:
      "Switch off 'whatsapp-agent' (inbound replies stop). The separate 'whatsapp' switch controls " +
      "OUTBOUND routing only, and switching it off must never swallow inbound messages.",
    gaps: ["Blocked on the client's Meta Business login; only the Twilio sandbox has ever been used."],
  },
  {
    key: "booking-reply-context",
    label: "Booking reply context",
    slug: "booking-reply-context",
    trigger: "src/app/api/webhooks/twilio/inbound/route.ts",
    guard: "src/app/api/webhooks/twilio/inbound/route.ts",
    draft: "none",
    drafter: "src/lib/agent/reply-context.ts",
    audience: "nobody",
    sendPath: "none",
    drainSource: null,
    correspondence: [],
    recordNote:
      "It sends nothing. It changes what the booking agent already about to reply KNOWS, and that " +
      "reply appears under 'agent' like any other.",
    needs: ["recall or reactivation being switched on for there to be an invite to recognise"],
    firstTick:
      "The agent starts recognising which invite a 'yes' answers, instead of opening a fresh conversation.",
    bound: "One resolved context per inbound message, at most 30 days old.",
    verify: "Conversations → a reply that names the appointment type the invite offered.",
    stop: "Switch it off. With no context resolved the agent is byte-for-byte its old self.",
    // The constant behind this sentence is POSTOP_NEVER_PRIMES in
    // src/lib/agent/reply-context.ts, and it stays in this comment: `gaps` is
    // handed straight back to a practice owner as agent_status's `knownGaps`,
    // and a bare identifier in brackets is a reference he cannot resolve. Same
    // argument as the ruling codes deleted from the abandoned-rescue entry.
    gaps: [
      "Post-op check-ins deliberately never prime it: someone answering 'how is the healing going?' " +
        "is telling the practice about a wound, not accepting an appointment, and a reply that late " +
        "is usually about something else entirely.",
    ],
  },
  // -------------------------------------------------------------------------
  // Patient lifecycle (the drain modules)
  // -------------------------------------------------------------------------
  {
    key: "recall",
    label: "Recall concierge",
    slug: "recall",
    trigger: "src/app/api/recall/sweep/route.ts",
    guard: "src/app/api/recall/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/recall/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "recall",
    correspondence: ["recall"],
    needs: ["RECALL_DAILY_CONTACT_LIMIT (default 25)", "RECALL_GRACE_DAYS (default 60)"],
    // NO ENVIRONMENT-VARIABLE NAMES IN THIS FIELD (wave-3 review, 4 Sep 2026).
    // `firstTick` is not runbook prose: src/lib/systems/vocabulary.ts reads it by
    // identity into `SystemVocabulary.starts`, and the control panel prints it
    // verbatim under this row while the system is OFF — which is every time the
    // owner is deciding whether to switch it on. `needs` is the field that may
    // carry env names (vocabulary.ts:50-55 exempts it BY NAME, and the panel
    // prints it a paragraph below under "Needs first"); this one carries the
    // NUMBER, so the sentence answers the question the owner is actually asking.
    // The 25 below is RECALL_DEFAULT_DAILY_CONTACT_LIMIT in
    // src/app/api/recall/sweep/route.ts. Pinned by roster.test.ts, "the
    // switch-on sentence an owner reads never names an environment variable".
    firstTick:
      "Up to 25 due patients a day — the shipped default — are drafted, auto-approved and " +
      "queued; the drain sends them on its next five-minute tick.",
    bound: "25 per London day by default, across the whole 51k book. Capped cadences stay due for tomorrow.",
    verify: "Recall worklist → touches move draft → approved → sent; the drain response reports perSource.recall.sent.",
    stop: "Switch off 'recall'. Queued rows stay queued and drain only when it is switched back on.",
    gaps: [
      "A row queued while the system was off fires on switch-back if it is still under 48 hours old.",
    ],
  },
  {
    key: "reactivation",
    label: "Reactivation",
    slug: "reactivation",
    trigger: "src/app/api/reactivation/sweep/route.ts",
    guard: "src/app/api/reactivation/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/reactivation/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "reactivation",
    correspondence: ["reactivation"],
    needs: ["REACTIVATION_AUTO_SEND_THRESHOLD", "REACTIVATION_MAX_LAPSE_MONTHS (uncapped by default)"],
    firstTick:
      "Lapsed patients above the auto-send score are drafted, approved and queued; the rest wait " +
      "for a person in the worklist.",
    bound: "The reactivation_settings daily contact limit, enforced before drafting.",
    verify: "Reactivation worklist → touches move to sent; the drain reports perSource.reactivation.",
    stop: "Switch off 'reactivation'.",
    // MISSING_FROM_MIGRATIONS in src/lib/test-support/fake-supabase.ts is where
    // the four tables are hand-declared for the test fake. The name stays in this
    // comment for the same reason as POSTOP_NEVER_PRIMES above: `gaps` is read
    // back to the owner as `knownGaps`, and "see X in the fake" is an instruction
    // to a developer, not an answer to a practice.
    gaps: [
      "Its four tables were created directly on the database rather than by a migration, so the " +
        "repository cannot see what the live columns and constraints actually are. Nothing is broken " +
        "by it today; it is what to check first if a reactivation write ever fails on live and not here.",
    ],
  },
  {
    key: "no-show-defence",
    label: "No-show defence",
    slug: "no-show-defence",
    trigger: "src/app/api/noshow/sweep/route.ts",
    guard: "src/app/api/noshow/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/noshow/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "noshow",
    correspondence: ["noshow"],
    needs: ["NOSHOW_MAX_SENDS_PER_RUN (default 25)", "NOSHOW_OFFER_TTL_HOURS (default 4)"],
    // The number, not its variable name — see the note on recall's firstTick. 25
    // is NOSHOW_DEFAULT_MAX_SENDS_PER_RUN in src/lib/noshow/ramp.ts, and the
    // env name that raises it stays in `needs` directly below the sentence.
    firstTick:
      "Confirmations go out for appointments already inside their T-48/T-24/T-3 windows — which on " +
      "day one is a BACKLOG, not a trickle. The two-pass sweep settles unsendable targets first and " +
      "then sends at most 25 a run by default, soonest appointment first.",
    // Same correction as the sentence above it: the number, not its variable
    // name. 25 is NOSHOW_DEFAULT_MAX_SENDS_PER_RUN and the env name that raises
    // it is already in `needs`. Ten minutes is app-sweep-noshow's registered
    // schedule (`*/10 * * * *` in ./scheduler.ts), not an assumption — the
    // comment on NOSHOW_DEFAULT_MAX_SENDS_PER_RUN still says "hourly".
    bound: "At most 25 confirmations a run by default, and the run comes round every ten minutes.",
    verify: "No-show worklist → confirmations sent; the drain reports perSource.noshow (transactional, drains second).",
    stop: "Switch off 'no-show-defence'. Confirmations, reminders AND waitlist fill all stop.",
    gaps: [
      "Waitlist slot offers carry a NULL target_id, so they appear in the no-show module's own view " +
        "but on nobody's record. A schema change, not a wiring one.",
      "Above ~300 in-window appointments the sync's run cap can mark live appointments cancelled " +
        "(see the noshow-run-cap memory) — unrelated to the switch, but it is what to watch on day one.",
    ],
  },
  {
    key: "treatment-coordinator",
    label: "Treatment Coordinator",
    slug: "treatment-coordinator",
    trigger: "src/app/api/coordinator/sweep/route.ts",
    guard: "src/app/api/coordinator/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/coordinator/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "coordinator",
    correspondence: ["coordinator"],
    needs: ["COORDINATOR_AUTO_SEND_THRESHOLD"],
    firstTick:
      "Unfinished treatment opportunities above the auto-send score are drafted and queued; the rest " +
      "wait for approval in the worklist.",
    bound: "The sweep's own per-run cap; the drain then applies the cross-module once-per-day cap.",
    verify: "Treatment Coordinator worklist → touches sent; drain perSource.coordinator.",
    stop: "Switch off 'treatment-coordinator'.",
    gaps: [
      "It is the only module whose outbox is the bare legacy `outbox` table rather than a prefixed one.",
      "src/app/api/sync/coordinator/route.ts reads no toggle; it only mirrors opportunities (no touch, " +
        "no outbox, no send), which is the same posture as every other read-only sync.",
    ],
  },
  {
    key: "treatment-closer",
    label: "Treatment-plan closer",
    slug: "treatment-closer",
    trigger: "src/app/api/closer/sweep/route.ts",
    guard: "src/app/api/closer/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/closer/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "closer",
    correspondence: ["closer"],
    needs: ["the app-sweep-closer cron REGISTERED (supabase/ops/register-closer-cron.sql — NOT applied)", "CLOSER_BOOKING_URL"],
    firstTick:
      "NOTHING IS SENT. The sweep drafts follow-ups for a human to approve; approval is the only " +
      "thing that ever writes closer_outbox.",
    // The figures are DEFAULT_CLOSER_CONFIG in src/lib/closer/types.ts
    // (maxExaminedPerRun 500, maxDraftsPerRun 25, cooldownHours 24), read by the
    // sweep at src/app/api/closer/sweep/route.ts:97/132/196. The old sentence
    // named CLOSER_DRAFT_BUDGET_LIMIT/_WINDOW instead, which is the MODEL-cost
    // guard in draft.ts (200 an hour) rather than the volume the owner asked
    // about, and named it with no figure at all.
    bound:
      "At most 500 plans looked at and 25 drafts written a run; a plan whose draft was refused, or " +
      "whose approved message failed to deliver, waits 24 hours before it is tried again.",
    verify: "The closer queue in the coordinator worklist fills with drafts. Nothing leaves until someone approves.",
    stop: "Switch off 'treatment-closer'. Drafting stops and approved-but-unsent rows stop draining.",
    gaps: [
      "Its cron is deliberately unregistered: switching the toggle on alone does nothing at all until " +
        "supabase/ops/register-closer-cron.sql is applied.",
    ],
  },
  {
    key: "balance-reminders",
    label: "Balance reminders",
    slug: "balance-reminders",
    trigger: "src/app/api/collection/sweep/route.ts",
    guard: "src/app/api/collection/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/collection/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "collection",
    correspondence: ["collection"],
    needs: [
      "the app-sweep-collection cron REGISTERED (supabase/ops/register-collection-cron.sql — NOT applied)",
      "ONE real Dentally invoice reconciled before COLLECTION_QUOTE_AMOUNT is ever set",
      "COLLECTION_PAYMENT_URL",
    ],
    firstTick: "NOTHING IS SENT. Reminders are drafted for approval; no figure is quoted by default.",
    // DEFAULT_COLLECTION_CONFIG in src/lib/collection/types.ts (maxExaminedPerRun
    // 300, maxVerifyReadsPerRun 40, maxDraftsPerRun 10, cooldownHours 24), read
    // by the sweep at src/app/api/collection/sweep/route.ts:149/194/195/278. As
    // with the closer, COLLECTION_DRAFT_BUDGET_LIMIT is the model-cost guard, not
    // the volume, and the old sentence carried no figure at all.
    bound:
      "At most 300 accounts looked at, 40 balances verified against Dentally and 10 drafts written " +
      "a run; an account that could not be verified waits 24 hours before it is tried again.",
    verify: "The balance queue fills with drafts. Nothing leaves until someone approves.",
    stop: "Switch off 'balance-reminders'.",
    gaps: [
      "Its cron is unregistered.",
      "COLLECTION_QUOTE_AMOUNT must stay unset until pounds-vs-pence is settled against a real invoice.",
    ],
  },
  {
    key: "postop-checkin",
    label: "Post-op check-in",
    slug: "postop-checkin",
    trigger: "src/app/api/postop/sweep/route.ts",
    guard: "src/app/api/postop/sweep/route.ts",
    draft: "templated",
    drafter: "src/lib/postop/copy.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "postop",
    correspondence: ["postop"],
    needs: [
      "the app-sweep-postop cron REGISTERED (supabase/ops/register-postop-cron.sql — NOT applied)",
      "STAFF_ALERT_PHONE, so an escalation reaches a person rather than only a task",
    ],
    firstTick:
      "NOTHING IS SENT. One check-in per flagged procedure is drafted for approval. Replies are " +
      "triaged and escalated whether the system is on or off.",
    bound: "One check-in per flagged appointment, retired after 48 hours if not sent.",
    verify: "The post-op queue fills; an escalation appears the moment a reply contains a symptom word.",
    stop:
      "Switch off 'postop-checkin'. Drafting and sending stop; inbound triage and escalation " +
      "deliberately do NOT, because a switch flipped afterwards must never be why a symptom went unseen.",
    gaps: [
      "There is NO model on the reply path, by design. Adding a drafter or a staff edit box would " +
        "re-open the advice risk the fixed template closes.",
      "Its cron is unregistered.",
    ],
  },
  {
    // ADDED BY THE WIRING GUARD, NOT BY THIS LANE. The pre-visit questionnaire is
    // W1-C's module. It registered a `previsit` source with the shared drain, a
    // `previsit` source with the correspondence read and a `pre-visit-triage` slug
    // in the catalog — correctly, all three — and roster.test.ts then went red
    // because a module the drain sends for had no switch-on runbook and no scenario
    // trace. That is the guard working, so the entry below is filled in from the
    // tree rather than the guard being loosened. W1-C owns the wording: what is
    // here is what the code says today.
    key: "pre-visit-triage",
    label: "Pre-visit questions",
    slug: "pre-visit-triage",
    trigger: "src/app/api/previsit/sweep/route.ts",
    guard: "src/app/api/previsit/sweep/route.ts",
    draft: "templated",
    drafter: "src/lib/triage/copy.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "previsit",
    correspondence: ["previsit"],
    // NAME THE CONSEQUENCE, NOT JUST THE TASK (wave-3b handoff H45, 5 Sep 2026).
    // This is the ONLY owner-visible warning that the flagship pre-visit feature
    // is unreachable: `needs` is read BY IDENTITY into `needsFirst` by
    // src/lib/systems/vocabulary.ts, shipped by /api/systems and printed as
    // "Needs first: …" under the switched-OFF row, and handed to the co-pilot's
    // agent_status. "a cron registration for /api/previsit/sweep" reads like one
    // more item on a setup list; what it actually means is that flipping the
    // switch changes nothing at all — no invite, no queue row, no error — which
    // is the failure a person only discovers by waiting a day for a text that was
    // never going to come. §2 of the runbook already says it in those words
    // ("Needs first — and this one is a hard stop"), and ./scheduler.ts's
    // SCHEDULER holds the read of cron.job that makes it true: app-sweep-previsit
    // is not registered. Registering it deletes this clause AND flips the
    // SCHEDULER row, in one edit, or the tests disagree with each other.
    needs: [
      "a cron registration for /api/previsit/sweep — until it is run the switch sends nothing at all, " +
        "silently: no invite, no queue row, no error (the SQL is in §2 of docs/runbooks/agent-switch-on.md)",
      // THE SECOND JOB THIS MODULE OWNS (wave-3c handoff H39/B77). The module has
      // TWO unregistered sweeps and this line named one of them, so an owner who
      // arranged everything "Needs first" asked for still had a nightly scan that
      // never ran — and, unlike the questionnaire, that one has a manual door, so
      // the honest sentence is "or" rather than a second hard stop. Both jobs are
      // in the runbook §2 table and in SCHEDULER (app-sweep-previsit-mining,
      // 20 2 * * *, not registered); registering it deletes this clause and flips
      // that row in the same edit.
      "a cron registration for /api/previsit/mining-sweep, or the implant-candidate list grows only " +
        "when the owner presses Build / refresh candidates on the Implants tab (that SQL is in §2 of " +
        "docs/runbooks/agent-switch-on.md too)",
      "PUBLIC_BASE_URL, so the link the text carries resolves",
    ],
    // DELIVERY COPY MATCHES THE CODE (ruling W3/9). The brief asked for the link
    // "alongside the medical-history link" and this sentence repeated the brief;
    // the module decided otherwise and said so in src/lib/triage/copy.ts — two
    // links do not fit in one SMS credit, so the handover moved into the JOURNEY
    // (the thank-you screen offers the medical-history form) and the invite is
    // its own message. This sentence is what the control panel prints as "what
    // switching it on starts" (src/lib/systems/vocabulary.ts reads it by
    // identity), so it has to name the cost: one extra text per appointment.
    firstTick:
      "Patients with an appointment coming up are sent a link to a short questionnaire. " +
      "It is its own text, sent before the appointment and separate from the medical-history " +
      "link — one extra message per appointment. Switching it on also opens the implant-candidate " +
      "list on the Implants tab, which the owner builds by hand and which messages nobody.",
    bound: "One invite per upcoming appointment, bounded per site by the sweep's own page cap.",
    // THE SURFACE THIS NAMES HAS TO BE ONE THAT RENDERS (wave-3 review, 4 Sep
    // 2026). This field is the runbook's "verify in the first hour" step AND the
    // co-pilot's `howToSeeItWorking` (src/lib/copilot/tools.ts, agent_status), so
    // a wrong screen name is repeated to the owner by the assistant as well as
    // printed in the doc. It said "on the appointment"; there is no
    // appointment-level surface — the diary's appointment panel reads no triage
    // summary. `previsitSummaryFor` has exactly two non-test callers: the record
    // tab below and the co-pilot's previsit_summary tool. Pinned by
    // roster.test.ts, "the pre-visit summary is verified on the record, which is
    // where it is drawn".
    verify:
      "The patient's Correspondence tab shows the invite; a completed form appears as " +
      "'What the patient shared before this visit', above the appointment list on the patient " +
      "record's Appointments tab.",
    stop:
      "Switch off 'pre-visit-triage'. The sweep, the queue AND the public form all stop — a " +
      "link already sent stops opening, so the flip is a complete revert.",
    gaps: [
      // "Owned by lane W1-C; this roster entry and its runbook section are a
      // snapshot of the code and should be confirmed by that lane before
      // go-live." was here and is gone (wave-3b handoffs H36/H44, 5 Sep 2026).
      // Two reasons, and the second is the one that matters. W1-C is FINAL in the
      // decisions log, so the hedge was stale; and `gaps` is not an internal note
      // — the co-pilot's agent_status returns it to the owner as `knownGaps`
      // (src/lib/copilot/tools.ts), so an internal lane code was being read back
      // to a practice owner as a known gap in his own platform. The runbook half
      // of the same hedge was deleted by the runbook lane and its absence pinned
      // (runbook.test.ts, "the pre-visit section is finished work"); this is the
      // other half. Nothing about the module's behaviour changed with it.
      "It drains as TRANSACTIONAL, so it is exempt from the once-per-day outreach cap.",
      // Stated rather than hidden (wave-3 review, 4 Sep 2026). firstTick above is
      // now honest that the invite is its own text; this is the other half of the
      // same fact. The handover the module designed instead of a second link is
      // the thank-you screen at src/app/pv/[token]/page.tsx, and that screen only
      // mints the medical-history link when isMedicalHistoryEnabled() is true —
      // the MEDICAL_HISTORY_ENABLED flag, exact string "true", which DEFAULTS
      // FALSE. That flag is read in exactly ONE module in the whole of src/
      // (src/lib/patient-medical/gate.ts) and gate.test.ts proves it by crawling
      // every source file for the `process.env.` reference, comments included —
      // which is why this comment names the variable without that prefix rather
      // than the assertion being widened to forgive a comment. It is
      // deliberately NOT in `needs`: the
      // pre-visit module works without it, so listing it would tell an owner he
      // must arrange something he does not need. But a go-live that leaves it
      // unset gets neither link in the message nor the offer on the screen.
      "The medical-history hand-off on the completion screen appears only when " +
        "MEDICAL_HISTORY_ENABLED is on, and that defaults off. Switching pre-visit questions on " +
        "does not switch it on.",
    ],
  },
  {
    key: "reviews",
    label: "Reviews",
    slug: "reviews",
    trigger: "src/app/api/reviews/sweep/route.ts",
    guard: "src/app/api/reviews/sweep/route.ts",
    draft: "templated",
    drafter: "src/lib/reviews/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "reviews",
    correspondence: ["reviews"],
    needs: ["REVIEW_LINK_URL (the sweep no-ops entirely without it)", "REVIEW_PRACTICE_NAME"],
    // TWO CORRECTIONS, not one (wave-3 review, 4 Sep 2026). This sentence named
    // three environment variables to an owner who has no way to read their
    // values — see the note on recall's firstTick — and it also described the
    // schedule as a send WINDOW, which src/lib/reviews/schedule.ts is not: the
    // sweep has no hour gate at all (src/app/api/reviews/sweep/route.ts sends
    // whatever is due whenever it ticks). The hours live in `reviewSendAt`, which
    // is same-day-delay-or-next-morning: attended before the cutoff hour (15) →
    // delayHours (3) later that day; attended at or after it → morningHour (10)
    // the next day, in Europe/London. DEFAULT_REVIEW_SCHEDULE holds all three.
    firstTick:
      "A patient seen before 3pm is asked for a review three hours later the same day; anyone " +
      "seen after that is asked at 10am the next morning. Those hours are the shipped defaults.",
    bound: "One request per attended appointment; the drain's daily cap yields to every lifecycle message.",
    verify: "The drain reports perSource.reviews.sent; the request rows move to sent.",
    // `stop` is read back by the co-pilot as `howToStopIt`, so the second clause
    // used to hand a practice owner an environment-variable name as one of his
    // two ways to stop an agent. The clause is true (the sweep no-ops without the
    // link) and stays, in words; the name it needs is already in `needs`.
    stop: "Switch off 'reviews'. Clearing the review link the sweep sends people to also stops it dead.",
    gaps: ["Templated deliberately: a model must never paraphrase a review link or an incentive."],
  },
  {
    key: "outreach",
    label: "Segment outreach",
    slug: "outreach",
    trigger: "src/app/api/outreach/sweep/route.ts",
    guard: "src/app/api/outreach/sweep/route.ts",
    draft: "llm",
    drafter: "src/lib/outreach/draft.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "outreach",
    correspondence: ["outreach"],
    // REGISTRATION TRUTH, AND WHY THIS LIST IS EMPTY (ruling W3/7, 4 Sep 2026).
    // This field used to say "the app-sweep-outreach cron REGISTERED
    // (supabase/ops/register-outreach-cron.sql — NOT applied)". `cron.job` says
    // otherwise and has for months: app-sweep-outreach is registered, active and
    // firing every ten minutes (scheduler.ts's SCHEDULER holds the read, and
    // §2 of the runbook prints it). This is not documentation drift — vocabulary.ts
    // reads `needs` BY IDENTITY into `needsFirst`, /api/systems ships it, and
    // systems-view.tsx prints "Needs first: …" on every switched-OFF row, so the
    // sentence was telling the owner that a scheduler prerequisite stood between
    // this switch and its first message. It does not: the switch IS the last gate,
    // which is the opposite fail direction and the one that matters at go-live.
    // Nothing else has to be arranged either — no env var, no external account —
    // so the honest list is the empty one, and the row then prints no "Needs
    // first" line at all rather than an invented one. The warning belongs in
    // `firstTick`, which already says a built campaign starts drafting.
    // Registered ≠ safe to flip; it means the flip is all there is.
    needs: [],
    firstTick: "Campaigns already built start drafting and queueing to their targets.",
    bound: "Per-campaign target caps; drains LAST, so it yields its slot to every lifecycle message.",
    verify: "The campaign's own progress counters; drain perSource.outreach.",
    stop: "Switch off 'outreach'. Campaign BUILDING deliberately continues; only sending stops.",
    gaps: ["Seeded disabled since migration 0041; it has only ever run in supervised tests."],
  },
  {
    key: "diary-notify",
    label: "Diary appointment moves",
    slug: "calendar-writes",
    trigger: "src/app/api/calendar/appointment/[id]/route.ts",
    guard: "src/lib/calendar/move-service.ts",
    draft: "templated",
    drafter: "src/lib/calendar/move-service.ts",
    audience: "patient",
    sendPath: "drain",
    drainSource: "diary",
    correspondence: ["diary"],
    needs: ["the site's publicPhone (the reschedule text refuses to draft without it)"],
    firstTick: "Moving an appointment in the diary texts the patient their new time.",
    bound: "One notice per move; drains FIRST, ahead of even the no-show confirmations.",
    verify: "The patient's Correspondence tab shows the move notice.",
    stop: "Switch off 'calendar-writes'. The move AND its text stop together, which is the point.",
    gaps: [
      "A move whose diary_move row is deleted resolves to no patient and drops off the record.",
    ],
  },
  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------
  {
    key: "anomaly-alerts",
    label: "Proactive alerts",
    slug: "anomaly-alerts",
    trigger: "src/app/api/anomaly/sweep/route.ts",
    guard: "src/app/api/anomaly/sweep/route.ts",
    draft: "none",
    drafter: null,
    audience: "nobody",
    sendPath: "none",
    drainSource: null,
    correspondence: [],
    recordNote: "It never messages anyone. It writes a row the in-app Notifications feed reads.",
    // SAME CORRECTION AS OUTREACH, SAME RULING (W3/7). app-sweep-anomaly is
    // registered and active, hourly at minute 45. Its ops file used to propose
    // minute 40 — the hourly Dentally prewarm's own minute — so an owner who acted
    // on this line and ran that file would have re-scheduled a job that had been
    // working for months (cron.schedule updates a job of the same name), and the
    // runbook warns about exactly that at §2. The file was corrected to 45 under
    // ruling W3/22 on 5 September 2026, and src/lib/agent-wiring/
    // ops-cron-registration.test.ts now holds every ops file to the minute its job
    // really runs. Empty for the same reason as outreach: this agent needs nothing
    // arranged. It writes notification rows and messages nobody, so there is no
    // sender, link or key to prepare.
    needs: [],
    firstTick: "The first hourly pass raises alerts for takings dips, no-show clusters, SLA breaches and stuck queues.",
    bound: "Deduped per condition; an alert only resolves on evidence the condition ENDED.",
    verify: "Notifications → the alerts appear with their evidence.",
    stop: "Switch off 'anomaly-alerts'. The pass stops AND alerts already raised stop showing.",
    gaps: [
      // "Its cron is unregistered." was here and was false (W3/7): the job has
      // been running the whole time, returning {"ok":true,"skipped":"system off"}
      // on every pass. `gaps` reaches the owner too — the co-pilot's agent_status
      // returns it as `knownGaps` — so a false gap is a false answer, not just a
      // stale note. Collection and post-op keep theirs: those two really are
      // unregistered (SCHEDULER in ./scheduler.ts, read from cron.job).
      "Alerts are client-scoped while the notifications feed is site-scoped.",
    ],
  },
  {
    key: "rota-notify",
    label: "Staff rota notifications",
    slug: "rota",
    trigger: "src/app/api/rota/publish/route.ts",
    guard: "src/app/api/rota/publish/route.ts",
    draft: "templated",
    drafter: "src/lib/rota/draft.ts",
    audience: "staff",
    sendPath: "direct",
    drainSource: null,
    correspondence: [],
    recordNote:
      "STAFF, not patients. Filing a nurse's shift text under a patient of the same name would be " +
      "its own defect, so these are deliberately kept off the record.",
    needs: ["staff mobile numbers on the rota_staff rows", "TWILIO_* sender"],
    firstTick:
      "Publishing a rota texts and emails every member of staff their own shifts; the 06:00 sweep " +
      "then texts each of them their upcoming list.",
    bound: "One message per member of staff per publication, and one per day from the sweep.",
    verify: "The publish response reports notifiedStaff / notifiedShifts / sendFailures.",
    stop: "Switch off 'rota'. Auto-generation and the staff texts stop together.",
    // WHAT WAS HERE, AND WHY IT COULD NOT STAY. The single gap read: "The only
    // toggle read in the tree that happens INSIDE a loop (per client), which is
    // the pattern every other sweep should eventually follow." That is a note
    // from one build lane to another about the shape of our source, and `gaps` is
    // not a note field — src/lib/copilot/tools.ts hands it to the practice
    // verbatim as agent_status's `knownGaps`, exactly as the reactivation and
    // anomaly-alerts entries above already say against themselves. So an owner
    // asking "is there anything I should know before I switch the staff rota
    // texts on?" was answered with an observation about our loops that he can
    // neither act on nor tell apart from a warning ("the only ... in the tree"
    // reads as a defect). It was also untrue: the shared ten-row gate
    // (liveSwitch().stillOn(), src/lib/systems/live-switch.ts) re-reads its
    // switch inside the loop in eight sweeps, and it is THAT gate the rest of the
    // tree follows — this per-client read is the weaker pattern, which is why
    // runbook.test.ts section 6 files the 06:00 sweep under "once" and section 0
    // of the runbook lists `rota` among the sweeps that run their batch out.
    // The fact underneath it is real and does belong to the owner, so it is
    // restated below in his terms: the same remedy this file already used for
    // POSTOP_NEVER_PRIMES and MISSING_FROM_MIGRATIONS.
    gaps: [
      "Switching this off part-way through the 06:00 run does not stop that run: the switch is read " +
        "once for the practice and the staff still to be worked through are texted anyway. These go " +
        "out as they are drafted rather than waiting in a queue, so switching off takes hold from the " +
        "next morning's run. Publishing a rota is different — that is refused the moment you switch off.",
    ],
  },
] as const;

/** Roster entry by key. */
export const AGENT_BY_KEY: Map<string, AgentDef> = new Map(AGENTS.map((a) => [a.key, a]));

/** Every agent that can put a message in front of a PATIENT. */
export const PATIENT_FACING_AGENTS: readonly AgentDef[] = AGENTS.filter(
  (a) => a.audience === "patient" && a.sendPath !== "none",
);

/** Every agent whose messages the shared drain delivers. */
export const DRAIN_AGENTS: readonly AgentDef[] = AGENTS.filter((a) => a.drainSource !== null);
