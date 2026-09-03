// ===========================================================================
// EVERY AGENT IN THE PLATFORM, AND THE FIVE THINGS THAT HAVE TO BE TRUE OF ONE.
//
// The programme's mandate for this lane is "all AI agents working where they
// need to be". That sentence is not checkable until somebody writes down what
// "an agent" is, so this file does: a trigger, a guard, a drafter, an outbox (or
// an explicit statement that it sends directly), and a place on the patient's
// record. Sixteen of them, in one list, with the exact file that does each part.
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
    bound:
      "The sweep runs every minute and takes leads in age order; a lead that fails to deliver " +
      "is retried at most MAX_FAILED_CONTACT_ATTEMPTS (3) times before it needs a person.",
    verify: "Leads worklist → stage moves new → contacted, with an attempt row and a first-response time.",
    stop: "Switch off 'speed-to-lead'. Intake is rejected and nothing is auto-contacted.",
    gaps: [
      "contactLead itself reads no toggle: all four callers gate it, pinned by a source crawl " +
        "in roster.test.ts rather than by a guard inside the function.",
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
    key: "abandoned-booking-rescue",
    label: "Abandoned-booking rescue",
    slug: null,
    slugNote:
      "No switch of its own, and it needs TWO to run: 'speed-to-lead' (the machinery it feeds) AND " +
      "'online-booking' (the flow it invites the patient back into). Ruling W1-B/4, 3 Sep 2026 — an " +
      "owner who has switched online booking off has switched off the page this text points at.",
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
      "At most 25 holds converted per tick, and — because the host sweep now uses the shared " +
      "ten-row gate (ruling W1-B/5) — drafting stops within ten rows of the switch being turned " +
      "off mid-run, rather than at the end of the batch.",
    verify: "Leads → a lead with source 'booking' and an attempt row.",
    stop: "Switch off 'speed-to-lead'.",
    gaps: [
      "Its basis is narrow ON PURPOSE (ruling W1-B/4): one transactional follow-up about the booking " +
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
    bound: "Per-sender budget AGENT_SENDER_BUDGET_LIMIT per AGENT_SENDER_BUDGET_WINDOW.",
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
    bound: "The same per-sender budget as the SMS agent.",
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
    gaps: ["Post-op check-ins deliberately never prime the agent (POSTOP_NEVER_PRIMES)."],
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
    firstTick:
      "Up to RECALL_DAILY_CONTACT_LIMIT due patients are drafted, auto-approved and queued; the " +
      "drain sends them on its next five-minute tick.",
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
    gaps: [
      "Its four tables were created out-of-band and have no migration, so their real constraints are " +
        "invisible from the repo (see MISSING_FROM_MIGRATIONS in the fake).",
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
    firstTick:
      "Confirmations go out for appointments already inside their T-48/T-24/T-3 windows — which on " +
      "day one is a BACKLOG, not a trickle. The two-pass sweep settles unsendable targets first and " +
      "then sends at most NOSHOW_MAX_SENDS_PER_RUN, soonest appointment first.",
    bound: "NOSHOW_MAX_SENDS_PER_RUN per tick, every ten minutes.",
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
    bound: "CLOSER_DRAFT_BUDGET_LIMIT drafts per CLOSER_DRAFT_BUDGET_WINDOW; CLOSER_COOLDOWN_HOURS between chases.",
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
    bound: "COLLECTION_DRAFT_BUDGET_LIMIT per window; COLLECTION_COOLDOWN_HOURS between reminders.",
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
    needs: ["a cron registration for /api/previsit/sweep", "PUBLIC_BASE_URL, so the link the text carries resolves"],
    firstTick:
      "Patients with an appointment coming up are sent a link to a short questionnaire, " +
      "alongside the medical-history link the practice already sends.",
    bound: "One invite per upcoming appointment, bounded per site by the sweep's own page cap.",
    verify:
      "The patient's Correspondence tab shows the invite; a completed form appears as a " +
      "pre-visit summary on the appointment.",
    stop:
      "Switch off 'pre-visit-triage'. The sweep, the queue AND the public form all stop — a " +
      "link already sent stops opening, so the flip is a complete revert.",
    gaps: [
      "Owned by lane W1-C; this roster entry and its runbook section are a snapshot of the " +
        "code and should be confirmed by that lane before go-live.",
      "It drains as TRANSACTIONAL, so it is exempt from the once-per-day outreach cap.",
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
    firstTick:
      "Patients who attended more than REVIEW_DELAY_HOURS ago are asked for a review, inside the " +
      "REVIEW_MORNING_HOUR–REVIEW_CUTOFF_HOUR window only.",
    bound: "One request per attended appointment; the drain's daily cap yields to every lifecycle message.",
    verify: "The drain reports perSource.reviews.sent; the request rows move to sent.",
    stop: "Switch off 'reviews', or unset REVIEW_LINK_URL.",
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
    needs: ["the app-sweep-outreach cron REGISTERED (supabase/ops/register-outreach-cron.sql — NOT applied)"],
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
    needs: ["the app-sweep-anomaly cron REGISTERED (supabase/ops/register-anomaly-cron.sql — NOT applied)"],
    firstTick: "The first hourly pass raises alerts for takings dips, no-show clusters, SLA breaches and stuck queues.",
    bound: "Deduped per condition; an alert only resolves on evidence the condition ENDED.",
    verify: "Notifications → the alerts appear with their evidence.",
    stop: "Switch off 'anomaly-alerts'. The pass stops AND alerts already raised stop showing.",
    gaps: [
      "Its cron is unregistered.",
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
    gaps: [
      "The only toggle read in the tree that happens INSIDE a loop (per client), which is the pattern " +
        "every other sweep should eventually follow.",
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
