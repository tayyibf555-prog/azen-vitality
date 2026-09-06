// ===========================================================================
// THE PRE-VISIT TRIAGE CONTRACT.
//
// Types only. No logic, no I/O, and there is NO index.ts barrel in this
// directory — the same rule perio/types.ts and patient-medical/types.ts state: a
// barrel lets a client component reach a server-only repository, which builds
// green and then drags the service-role client into the client graph.
//
// WHAT THIS MODULE IS. A short questionnaire a patient answers on their phone
// before an appointment, plus a tick-grid of treatments they might want to hear
// more about. The answers are shown to the clinician before the visit ("this is
// what the patient shared"); the ticks accrue on per-treatment interest lists the
// practice can follow up.
//
// ---------------------------------------------------------------------------
// THE FORK, AND WHY IT IS NAMED "full" AND "brief" RATHER THAN AFTER A FUNDING
// REGIME.
// ---------------------------------------------------------------------------
//
// The practice asked for two question lists, and the split between them is
// CONTRACTUAL, not editorial. Under the NHS contract, a symptom a patient
// volunteers has to be treated under that contract. So an NHS-plan patient must
// never be ASKED a pain / symptom / treatment-need question before their visit:
// asking creates the obligation. Cosmetic interest is fine for everybody, and so
// is logistics.
//
// That fork is decided SERVER-SIDE from the patient's Dentally payment plan (see
// ./fork.ts) and is never, ever visible to the patient. PRODUCT.md's funding-jargon
// rule forbids the words NHS and private in anything a patient reads, in any agent,
// form or message — and the point of this module is that the patient cannot even
// infer which list they were given, because neither list explains itself.
//
// So the two banks are called `full` and `brief`:
//
//   1. The words are the honest description of what the patient was asked, which
//      is what a staff screen actually needs to say ("Full pre-visit questions" /
//      "Shorter pre-visit questions").
//   2. A funding word cannot leak from a field that never holds one. The fork is
//      persisted, projected into the public payload's shape, and rendered on staff
//      screens; naming the values "nhs"/"private" would put a funding word one
//      careless `JSON.stringify` away from a patient's browser. `no-funding-words`
//      in ./copy.test.ts crawls every patient-facing string in this module, and
//      this naming is what makes that crawl a proof rather than a habit.
//   3. If the practice later decides a third plan takes the shorter list, the
//      names still describe the thing. "nhs" would not.
//
// ===========================================================================

/**
 * Which of the two default question banks a patient is asked.
 *
 *   full   every question: the reason for the visit, the concern in their own
 *          words, how long, pain now, sensitivity, bleeding gums, chips and
 *          breaks, dental anxiety, the smile free text, and the interest grid.
 *   brief  interest and logistics ONLY: confirming they are coming, whether their
 *          medical history has changed, the smile free text, and the interest
 *          grid. NO pain, NO symptom, NO treatment-need question — see ./project.ts,
 *          where that is enforced structurally rather than by the default config.
 */
export type TriageFork = "full" | "brief";

export const TRIAGE_FORKS: readonly TriageFork[] = ["full", "brief"] as const;

/**
 * What KIND of thing a question asks. This is the load-bearing classification in
 * the whole module, because `symptom` is the class the brief bank may never
 * contain — and "may never contain" is enforced on the PROJECTION (./project.ts),
 * not on the default config, so an owner cannot enable one into the brief bank
 * from the editor and a corrupted config row cannot smuggle one in either.
 *
 *   symptom     pain, sensitivity, bleeding, breakage, duration, "what's wrong",
 *               and anything else that asks the patient to report a clinical
 *               problem or a treatment need. Full bank only.
 *   logistics   are you coming, has your medical history changed, is there
 *               anything that would make the visit easier. Both banks.
 *   cosmetic    "if you could change one thing about your smile" — an aspiration,
 *               not a complaint. Both banks. Not a symptom question and must not
 *               be written as one.
 *   interest    the treatment tick-grid. Both banks. Its own renderer.
 */
export type TriageQuestionKind = "symptom" | "logistics" | "cosmetic" | "interest";

/**
 * The control a question renders as. Deliberately a SMALL closed set: every extra
 * type is another shape the public form, the validator and the summary all have
 * to agree about, and this module needs five.
 */
export type TriageFieldType =
  | "text"        // one line
  | "textarea"    // their own words
  | "choice"      // one of a fixed list
  | "yesno"       // yes / no / not sure
  | "scale"       // 0-10, and ONLY 0-10 (see SCALE_MIN / SCALE_MAX)
  | "interest";   // the treatment grid — rendered by its own component

export interface TriageOption {
  value: string;
  label: string;
}

/**
 * One question in the bank.
 *
 * `key` is the CONTRACT. The stored answers are keyed by it, the summary reads by
 * it, and the projection drops any answer whose key is not in the bank. A key that
 * has shipped never changes; questions are added, never renamed.
 */
export interface TriageQuestion {
  key: string;
  /** What the patient reads. British English. Never says NHS or private. */
  label: string;
  type: TriageFieldType;
  kind: TriageQuestionKind;
  /** Which default bank includes this question out of the box. */
  banks: readonly TriageFork[];
  options?: readonly TriageOption[];
  /** Sub-copy under the label. Patient-facing. */
  help?: string;
  /**
   * A note shown to the OWNER in the bank editor, never to a patient.
   *
   * It exists for the one question whose fork placement is a judgement the
   * practice has to make with its contract adviser rather than one this codebase
   * can make for them (`anxiety`). Because this string is owner-facing it MAY name
   * a funding regime, which is exactly why it is a separate field from `help`:
   * `help` is rendered to the patient and is crawled for funding words, this is
   * rendered only in the editor and is not. Keeping them in one field would have
   * meant either losing the note or weakening the crawl.
   */
  ownerNote?: string;
  /**
   * Whether the owner may mark this question required.
   *
   * A free-text question is NEVER requirable: forcing a patient to type something
   * about their mouth before they can confirm an appointment is how a form gets
   * abandoned, and an abandoned form tells the clinician nothing at all. The
   * interest grid is a different case — see INTEREST_QUESTION_KEY.
   */
  requirable: boolean;
}

/**
 * A question the practice wrote itself, in the owner editor.
 *
 * `kind` is chosen by the owner from the same closed set, and the projection
 * applies exactly the same rule to it as to a bank question: a custom question
 * classified `symptom` — or one whose LABEL reads like a symptom question,
 * whatever the owner classified it as — never reaches the brief bank. See
 * ./project.ts and FORBIDDEN_IN_BRIEF in ./forbidden.ts.
 */
export interface TriageCustomQuestion {
  /** Generated, always prefixed `custom-`, so it can never collide with a bank key. */
  key: string;
  label: string;
  type: TriageFieldType;
  kind: TriageQuestionKind;
  options?: readonly TriageOption[];
  required: boolean;
}

/**
 * One bank's saved configuration. The SAME shape as OnboardingConfig, deliberately:
 * the onboarding form builder already solved "a library plus overrides plus the
 * practice's own questions", it is tested, and an owner who has used one editor
 * should not have to learn a second.
 *
 * `enabledKeys` are bank keys the owner has switched on. An EMPTY config means
 * "use this fork's defaults" (see defaultConfigFor in ./bank.ts), which is what
 * makes the shipped banks defaults rather than a migration nobody can undo.
 */
export interface TriageBankConfig {
  enabledKeys: string[];
  required: Record<string, boolean>;
  custom: TriageCustomQuestion[];
}

/** A bank config as stored, with its provenance. */
export interface StoredTriageBank {
  clientId: string;
  fork: TriageFork;
  config: TriageBankConfig;
  updatedAt: string;
  updatedBy: string | null;
}

// ---------------------------------------------------------------------------
// The interest grid.
// ---------------------------------------------------------------------------

/**
 * The four treatments the practice asks about, as their catalogue keys.
 *
 * These ARE `src/lib/treatments/catalog.ts` keys (whitening, invisalign, implant,
 * veneers) except the last, which pairs veneers with bonding because the practice
 * asks about them as one thing ("veneers and bonding") and a patient does not
 * distinguish them at this stage. INTEREST_TREATMENTS below carries the pairing.
 */
export type InterestTreatmentKey = "whitening" | "straightening" | "implants" | "veneers-bonding";

/**
 * A patient's answer to one row of the grid.
 *
 * TWO VALUES, AND "not_now" IS A REAL ANSWER, not the absence of one. The grid is
 * required-but-refusable: every row must be answered, and "Not right now" is
 * always offered, always one tap, and never disadvantaged in the layout. Storing
 * the refusal is what lets the practice see that a patient was asked and said no,
 * rather than re-asking them every six months because the row was blank.
 */
export type InterestAnswer = "yes" | "not_now";

export interface InterestTreatment {
  key: InterestTreatmentKey;
  /** What the patient reads. Plain, non-clinical, no price, no claim. */
  label: string;
  /** One line of orientation under the label. Patient-facing. */
  blurb: string;
  /** The catalogue keys this row covers, for anything that wants the real treatment. */
  catalogueKeys: readonly string[];
}

/** One stored interest row: a patient said yes (or not now) to one treatment. */
export interface InterestRecord {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  patientName: string;
  treatment: InterestTreatmentKey;
  answer: InterestAnswer;
  responseId: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Targets, responses, and the send pipeline.
// ---------------------------------------------------------------------------

/**
 *   pending    the appointment is flagged; nothing composed yet
 *   queued     an outbox row exists; the shared drain owns it now
 *   sent       the link went out
 *   answered   the patient submitted; the link is spent
 *   stopped    terminal without a send (no consent / opted out / stale / off)
 */
export type TriageTargetStatus = "pending" | "queued" | "sent" | "answered" | "stopped";

export type TriageStopReason =
  | "no_consent"
  | "opted_out"
  | "excluded"
  | "stale"
  /**
   * The appointment started before the queued link reached the drain, so it was
   * retired unsent (ruling W3/5). Distinct from `stale`, which is the SWEEP's
   * word for a target it never composed: this one had a message written and
   * waiting, and the visit overtook it.
   */
  | "expired"
  | "undeliverable"
  /**
   * THE SHARED DRAIN BLOCKED THE SEND, AND DID NOT SAY WHY.
   *
   * `OutboxSource.markBlocked(id)` takes an id and nothing else, yet the drain
   * calls it from four different places: an opt-out on the ref or the resolved
   * address, the output guardrail, an undeliverable address, and the
   * cross-module once-per-day cap. Only the first of those is the patient
   * asking us to stop.
   *
   * This module used to record every one of them as `opted_out`, which is a
   * statement about CONSENT the platform had no evidence for: a number Twilio
   * Lookup calls a landline would have been written into the patient's record
   * as a person who opted out of being contacted. The closer and the collection
   * agent both refuse the same reuse in their own comments, for the same reason
   * ("reusing `opted_out` would claim the patient asked"). So the reason we
   * record is the one thing we actually know — the drain would not send it —
   * until the drain's contract carries a reason of its own.
   */
  | "blocked"
  | "no_link"
  | "staff_stopped";

export type TriageChannel = "sms" | "whatsapp" | "email";

export interface TriageTarget {
  id: string;
  siteId: string;
  dentallyPatientId: string;
  appointmentId: string;
  patientName: string;
  /** Which bank this patient is asked. Resolved server-side, never from a request. */
  fork: TriageFork;
  /** ISO. The appointment this is ahead of. */
  appointmentAt: string;
  /** ISO. Earliest the link may be sent (appointment minus the lead, quiet-hours clamped). */
  dueAt: string;
  status: TriageTargetStatus;
  stopReason: TriageStopReason | null;
  consentSms: boolean;
  /**
   * The opaque link id. 22 base64url characters of CSPRNG randomness, minted on
   * the row. NOT a signed token — see ./link.ts for why a database-backed id is
   * both shorter (one SMS credit) and revocable, which an HMAC token is not.
   */
  linkToken: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One answer as stored. `value` is always a string; the summary formats it.
 *
 * `kind` TRAVELS WITH THE ANSWER, and it is REQUIRED rather than optional.
 *
 * The summary splits the answers on their kind — `symptom` is the half the
 * practice manager may not read (ruling W1-C/2) — so the projection has to know
 * every answer's real kind, including for a question the PRACTICE wrote in the
 * owner editor and which no shipped bank can name. Stamping it here, from the same
 * projection that rendered the form, is what makes that classification survive
 * into the summary and keep surviving after the owner has deleted the question.
 *
 * Required at the type level ON PURPOSE: a caller that stores an answer without
 * saying what kind of question it was is a compile error, not a row that later
 * defaults to the unrestricted class. What is stored can still be missing or junk
 * (it is a jsonb column), which is the OTHER half of the rule — see
 * `readStoredAnswers` and `UNKNOWN_ANSWER_KIND` in ./kind.ts, where an unknown
 * kind resolves to `symptom` and never to `logistics`.
 */
export interface TriageAnswer {
  key: string;
  value: string;
  kind: TriageQuestionKind;
}

/** One completed pre-visit questionnaire. */
export interface TriageResponse {
  id: string;
  targetId: string;
  siteId: string;
  dentallyPatientId: string;
  /** The fork the patient was actually asked, copied from the target at submit. */
  fork: TriageFork;
  answers: TriageAnswer[];
  /** The interest grid, as answered. Every row the patient saw appears. */
  interest: Array<{ treatment: InterestTreatmentKey; answer: InterestAnswer }>;
  submittedAt: string;
}

export type TriageTouchStatus = "queued" | "sending" | "sent" | "failed";

export interface TriageOutboxItem {
  id: string;
  touchId: string;
  siteId: string;
  channel: TriageChannel;
  toRef: string;
  body: string;
  status: string;
  createdAt: string;
  sentAt: string | null;
}

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------

export interface TriageConfig {
  /** How far ahead of the appointment the link is sent. */
  leadHours: number;
  /**
   * How far past `dueAt` a target may still be sent. Past this it is retired
   * unsent: a "before your visit" link that arrives after the visit is worse than
   * none, and the appointment itself is the deadline.
   */
  stalenessHours: number;
  /** Quiet hours, Europe/London. Nothing is queued to leave outside them. */
  quietStartHour: number;
  quietEndHour: number;
  /** Bounds on one sweep run. */
  maxExaminedPerRun: number;
  maxQueuedPerRun: number;
}

/**
 * The shipped defaults.
 *
 * 24 hours ahead is the number the practice named on the call and the number the
 * medical-history link's own comment assumes ("the link 24h before"), so the two
 * pre-visit asks land in the same part of the patient's day.
 *
 * The staleness ceiling is 22 hours rather than 24 so that a target which has sat
 * unsent through a whole outage is retired BEFORE the appointment it refers to,
 * never after it.
 */
export function triageConfig(): TriageConfig {
  return {
    leadHours: numberEnv("PREVISIT_LEAD_HOURS", 24, 2, 168),
    stalenessHours: numberEnv("PREVISIT_STALENESS_HOURS", 22, 1, 72),
    quietStartHour: 8,
    quietEndHour: 20,
    maxExaminedPerRun: numberEnv("PREVISIT_MAX_EXAMINED", 400, 1, 5000),
    maxQueuedPerRun: numberEnv("PREVISIT_MAX_QUEUED", 60, 1, 500),
  };
}

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

/** The 0-10 pain scale, stated once. */
export const SCALE_MIN = 0;
export const SCALE_MAX = 10;

/** The kill-switch slug. Named once so nothing can misspell it into a no-op. */
export const TRIAGE_SYSTEM_SLUG = "pre-visit-triage";

/** The drain source name. Must match the entry in DRAIN_SOURCE_TO_SLUG. */
export const TRIAGE_DRAIN_SOURCE = "previsit";
