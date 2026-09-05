import { clientIp } from "@/lib/http/client-ip";
import { consumeBudget } from "@/lib/rate-budget";
import { getSite } from "@/lib/mock/clients";
import { isSystemEnabledStrict } from "@/lib/systems/repository";
import { isKnownInterestKey, INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { isTriageLinkTokenShaped } from "@/lib/triage/link";
import { projectBank } from "@/lib/triage/project";
import { getBank, getTargetByLinkToken, recordResponse } from "@/lib/triage/repository";
import { SCALE_MAX, SCALE_MIN, TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import type {
  InterestAnswer,
  InterestTreatmentKey,
  TriageAnswer,
  TriageQuestionKind,
} from "@/lib/triage/types";

export const dynamic = "force-dynamic";

// ===========================================================================
// PUBLIC pre-visit submit. Nobody is signed in; a patient with a link is the
// caller.
//
// THE LINK IS THE IDENTITY, NEVER THE BODY. The token resolves to exactly one
// previsit_target row, and the site, the patient and the FORK all come off that
// row. The request body cannot name a patient, a site, or which question bank it
// wants — which is the load-bearing IDOR defence AND the load-bearing contractual
// one, because a caller who could name their own fork could ask to be given the
// symptom questions.
//
// ---------------------------------------------------------------------------
// THE ANSWER ALLOW-LIST IS THE PROJECTION, NOT A SEPARATE LIST.
// ---------------------------------------------------------------------------
// This route re-runs `projectBank(target.fork, savedConfig)` — the SAME pure
// function the public page rendered from — and accepts an answer only if its key
// is in the result. So the rendered form and the accepted answers cannot diverge,
// which is the arrangement onboarding's submit route has with resolveSteps and
// for the same reason. In particular: a symptom key posted against a `brief`
// target is not in the projection, so it is DROPPED. The contractual rule holds
// even against a caller who has read the bank and is posting keys by hand.
//
// ---------------------------------------------------------------------------
// ABUSE POSTURE.
// ---------------------------------------------------------------------------
// Unauthenticated and it writes rows. It sends no message, makes no model call,
// and touches no Dentally endpoint, so the blast radius is "junk rows against one
// appointment that must already exist". The guards, cheapest first: a payload cap
// before the body is read, a per-IP durable budget, a per-token durable budget
// (so a leaked link cannot be replayed thousands of times), a strict kill-switch
// check, and the single-use claim in `recordResponse`.
//
// KILL SWITCH: STRICT, i.e. fail CLOSED. Switching the module off must stop the
// form accepting answers, and an unreadable switch must too — a form still
// collecting answers after the owner turned it off is a stop with residue.
// ===========================================================================

/**
 * The payload cap. A full form is ~12 answers plus 4 interest rows; the two free
 * text fields are individually capped at MAX_TEXT below. 16KB is generous headroom
 * and still refuses anything trying to STORE something here rather than answer.
 */
const MAX_BODY = 16_384;
const MAX_TEXT = 2000;
const MAX_ANSWERS = 40;

const IP_BUDGET_LIMIT = 60; // submits per IP per hour
const IP_BUDGET_WINDOW_SECONDS = 60 * 60;
/**
 * PER-TOKEN, and it is the one that matters. A link is single-use, so an honest
 * caller posts once (twice with a retry). Twenty is generous for a flaky phone
 * and closes replay against one leaked link without depending on the IP key,
 * which a caller can vary.
 */
const TOKEN_BUDGET_LIMIT = 20;
const TOKEN_BUDGET_WINDOW_SECONDS = 60 * 60;

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

/**
 * The SAME refusal for a bad token, an unknown token, a spent link, a switched-off
 * system, AN APPOINTMENT THAT HAS ALREADY STARTED, and a target that is not in a
 * sendable state.
 *
 * One sentence for every one of them, so a caller holding a guessed token learns
 * nothing about whether it named a real appointment. The patient reading it is
 * told the only useful thing: this link will not work, ring us.
 */
function deadLink(): Response {
  return Response.json(
    {
      ok: false,
      error: "This link is no longer available. If you need to tell us something before your visit, please give us a ring.",
    },
    { status: 403 },
  );
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function POST(request: Request): Promise<Response> {
  try {
    // (1) Payload cap, twice. The header is a fast pre-guard and can be absent or
    // lied about, so the authoritative check is on the text actually read.
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY) return bad("That was too long to read.", 413);

    let body: Record<string, unknown>;
    try {
      const text = await request.text();
      if (text.length > MAX_BODY) return bad("That was too long to read.", 413);
      const parsed = JSON.parse(text);
      body = asRecord(parsed) ?? {};
    } catch {
      return bad("Your answers could not be read. Please try again.");
    }

    const token = typeof body.token === "string" ? body.token.trim() : "";
    // Shape first, so junk never reaches a query or spends a budget key.
    if (!isTriageLinkTokenShaped(token)) return deadLink();

    // (2) Per-IP, then (3) per-token. Both are the shared durable budget
    // (api_budget), so they hold across every serverless instance rather than
    // resetting on a cold start.
    if (!(await consumeBudget(`previsit-ip:${clientIp(request)}`, IP_BUDGET_LIMIT, IP_BUDGET_WINDOW_SECONDS))) {
      return bad("Too many attempts. Please try again shortly.", 429);
    }
    if (!(await consumeBudget(`previsit-token:${token}`, TOKEN_BUDGET_LIMIT, TOKEN_BUDGET_WINDOW_SECONDS))) {
      return bad("Too many attempts. Please try again shortly.", 429);
    }

    const target = await getTargetByLinkToken(token);
    if (!target) return deadLink();
    // A spent or stopped link. Same refusal, so a caller cannot probe the state.
    if (target.status !== "queued" && target.status !== "sent") return deadLink();

    // THE UPPER BOUND, AND STATUS ALONE CANNOT EXPRESS IT — the second public
    // door, closed with the same bound the page uses.
    //
    // Ruling W3/5 ("a queued pre-visit link is NEVER dispatched after its
    // appointment start ... fail closed") was implemented on the DRAIN
    // (repository.ts, dropRowsPastTheirAppointment), which can only retire a link
    // that has not gone out yet. `sent` has no terminal transition in this module,
    // so a delivered link sits live in a phone's message list for ever — and the
    // page fix alone would close only the browser door: a hand-rolled POST with an
    // expired token would still write a previsit_response plus its
    // treatment_interest rows.
    //
    // The answers are the harm, not the request. The first required question is
    // "are you still able to come to your appointment?", so answers submitted after
    // the visit are not late answers to this appointment, they are answers to a
    // DIFFERENT one — and `submitted_at = now` presents them to the clinician as
    // the summary standing in front of the NEXT visit (the record tab and the
    // co-pilot's previsit_summary both read the newest response).
    //
    // `now < start`, byte-for-byte the comparison on /pv/[token], in the drain's
    // dropRowsPastTheirAppointment and in decideSend's `past` drop, so all four
    // agree about which side of the appointment we are on. FAIL CLOSED on an
    // instant that cannot be parsed: an appointment we cannot date is not an
    // appointment we may assume is still ahead of us.
    //
    // `Date.now()` is correct here and `new Date()` was correct on the page: a
    // route handler is not a component, so the react-hooks purity rule that forced
    // the latter does not apply.
    //
    // PLACED AFTER THE BUDGETS AND BEFORE getSite / the kill switch / getBank, so
    // an expired token can never be used as a free oracle and costs no further
    // reads once it is refused.
    const startMs = Date.parse(target.appointmentAt);
    if (!Number.isFinite(startMs) || Date.now() >= startMs) return deadLink();

    const site = getSite(target.siteId);
    if (!site) return deadLink();

    // (4) The kill switch, STRICT. Off means no answers accepted, an unreadable
    // switch means no answers accepted, and the caller cannot tell either from a
    // bad token.
    if (!(await isSystemEnabledStrict(site.clientId, TRIAGE_SYSTEM_SLUG))) return deadLink();

    // The allow-list IS the projection the page rendered from. The fork comes from
    // the TARGET; nothing in the body can influence which bank applies.
    const saved = await getBank(site.clientId, target.fork);
    const bank = projectBank(target.fork, saved?.config ?? null);
    const allowed = new Map(bank.questions.map((q) => [q.key, q]));

    const answers = parseAnswers(body.answers, allowed);
    if (answers === null) return bad("Some of your answers could not be read. Please try again.");

    const interest = parseInterest(body.interest, allowed.has("interest-grid"));
    if (interest === null) return bad("Your answers could not be read. Please try again.");

    // REQUIRED MEANS REQUIRED, and it is checked on the SERVER as well as in the
    // form. A required question the caller omitted is refused rather than stored
    // as blank: a summary showing "No answer" where a patient was told they had
    // to answer is a summary a clinician would misread.
    const answered = new Set(answers.map((a) => a.key));
    const missing = bank.questions
      .filter((q) => q.required && q.key !== "interest-grid" && !answered.has(q.key))
      .map((q) => q.key);
    if (missing.length > 0) return bad("Please answer the questions marked as needed.");

    const result = await recordResponse({
      target,
      answers,
      interest,
      submittedAt: new Date().toISOString(),
    });

    // A DUPLICATE IS ANSWERED WITH THE SAME THANK YOU. The patient tapped twice,
    // or their phone retried; they have done nothing wrong and the practice
    // already has their answers. Telling them "this link has been used" would send
    // them to the phone for no reason.
    if (!result.ok) return Response.json({ ok: true, duplicate: true });

    // The row id is never returned: a public caller learns nothing it could
    // address later.
    return Response.json({ ok: true });
  } catch {
    // Never throw to the client, and never claim success on a failed write.
    return bad("We could not save your answers. Please try again.", 500);
  }
}

/**
 * Parse the answers, DROPPING any key the projection does not contain and
 * refusing a malformed value.
 *
 * Drop-not-fail for an unknown key, because the honest cause is a stale form (the
 * owner edited the bank between the send and the submit) and refusing the whole
 * submission would throw away every answer the patient did give. Refuse-not-drop
 * for a malformed VALUE, because that is not something an honest form produces.
 *
 * Constructed, never spread: no key the caller invented survives.
 */
function parseAnswers(
  raw: unknown,
  allowed: ReadonlyMap<
    string,
    { type: string; kind: TriageQuestionKind; options?: readonly { value: string }[] }
  >,
): TriageAnswer[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ANSWERS) return null;
  const out: TriageAnswer[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const obj = asRecord(entry);
    if (!obj) return null;
    const key = typeof obj.key === "string" ? obj.key : "";
    const q = allowed.get(key);
    if (!key || !q || seen.has(key) || q.type === "interest") continue; // drop, do not fail
    if (typeof obj.value !== "string") return null;
    const value = obj.value.trim();
    if (value.length > MAX_TEXT) return null;
    if (value === "") continue; // an empty optional answer is simply not an answer

    // Per-type validation. A CHOICE answer must be one of that question's own
    // option values, so a caller cannot store arbitrary text under a question the
    // summary will render as if the practice had offered it.
    if (q.type === "choice") {
      if (!q.options?.some((o) => o.value === value)) return null;
    } else if (q.type === "yesno") {
      if (value !== "yes" && value !== "no" && value !== "unknown") return null;
    } else if (q.type === "scale") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < SCALE_MIN || n > SCALE_MAX) return null;
    }

    seen.add(key);
    // THE KIND IS STAMPED HERE, from the projection — never from the body, which
    // cannot name one and would not be believed if it could. This is the only
    // moment at which a question the PRACTICE wrote can be classified at all: the
    // owner's config says what it is now, and the summary has to know what it was
    // even after the question is deleted. An unstamped answer resolves to `symptom`
    // downstream (src/lib/triage/kind.ts), so forgetting is safe but lossy —
    // hence `kind` being required on TriageAnswer rather than optional.
    out.push({ key, value, kind: q.kind });
  }
  return out;
}

/**
 * Parse the interest grid.
 *
 * REQUIRED-BUT-REFUSABLE, enforced here and not only in the form: when the grid
 * is on the bank, EVERY treatment row must carry an answer, and "not_now" is one
 * of exactly two accepted values. So a caller cannot submit a partial grid, and a
 * caller who wants to decline everything can — which is the whole meaning of
 * "required but refusable" and is why refusing is a VALUE rather than an omission.
 *
 * Returns null (a hard refusal) on a partial or malformed grid, and [] when the
 * grid is not on this bank at all.
 */
function parseInterest(
  raw: unknown,
  gridIsOnBank: boolean,
): Array<{ treatment: InterestTreatmentKey; answer: InterestAnswer }> | null {
  if (!gridIsOnBank) return [];
  if (!Array.isArray(raw)) return null;
  const byKey = new Map<string, InterestAnswer>();
  for (const entry of raw) {
    const obj = asRecord(entry);
    if (!obj) return null;
    const treatment = typeof obj.treatment === "string" ? obj.treatment : "";
    const answer = obj.answer;
    if (!isKnownInterestKey(treatment)) return null;
    if (answer !== "yes" && answer !== "not_now") return null;
    byKey.set(treatment, answer);
  }
  // Every row, or none of it. A grid missing a row is a form that was not
  // completed, and storing three of four would silently record a fourth patient
  // as "not asked" when they were.
  if (byKey.size !== INTEREST_TREATMENTS.length) return null;
  return INTEREST_TREATMENTS.map((t) => ({
    treatment: t.key,
    answer: byKey.get(t.key) as InterestAnswer,
  }));
}
