import { getClient, getSites } from "@/lib/mock/clients";
import { scoreAssessment, type ScoreTuning } from "@/lib/smile-assessment/scoring";
import { QUIZ_QUESTION_IDS, Q_TREATMENT, questionById } from "@/lib/smile-assessment/quiz";
import { countRecent, insertResponse, setResponseLead } from "@/lib/smile-assessment/repository";
import type { AssessmentChannel } from "@/lib/smile-assessment/types";
import { contactLead } from "@/lib/speed-to-lead/contact";
import {
  insertLead,
  findOpenLeadByAddress,
  findEarlierOpenLead,
  setLeadStage,
  claimLeadForContact,
  releaseLeadClaim,
  stampLeadFunnelCapture,
} from "@/lib/speed-to-lead/repository";
import { randomUUID } from "node:crypto";
import { normaliseAndValidateFlow } from "@/lib/smile-assessment/flow-validate";
import { stepNumbering } from "@/lib/smile-assessment/step-numbering";
import {
  funnelCaptureStamp,
  type FunnelCaptureStamp,
} from "@/lib/smile-assessment/funnel-progress";
import { consumeBudget } from "@/lib/rate-budget";
import { clientIp } from "@/lib/http/client-ip";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { goalLabel } from "@/lib/smile-assessment/campaign";
import { followUpConfig, shouldFollowUp } from "@/lib/smile-assessment/follow-up";
import { verifySubmitToken } from "@/lib/smile-assessment/embed-token";
import { resolveMetaPixel } from "@/lib/assess/meta-pixel-repository";
import { sendAssessmentLeadEvent } from "@/lib/assess/meta-capi-send";
import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";
import { isSystemEnabled, isSystemEnabledForSend } from "@/lib/systems/repository";

export const dynamic = "force-dynamic";

// Public submit endpoint for the embeddable Smile Assessment quiz. An enquiry
// POSTs its answers here; we score it (intent/fit only), record the response, and
// — for a HIGH score with a contact channel — fast-track it into Speed-to-lead so
// the patient is contacted instantly.
//
// ABUSE SURFACE: like the speed-to-lead intake, a high score can trigger a real
// outbound SMS to a caller-supplied number, and that first contact is drafted by
// Claude, so every submission can cost real money. This is unauthenticated, so it
// validates hard, is bounded by the SHARED durable budget guard (per client +
// campaign and per IP, the real spend ceiling), rate-limits per contact (durable,
// in the DB) AND per IP (best-effort, in-process), and never throws to the client.

const CONTACT_RATE_LIMIT = 5; // max submissions from one phone/email per hour
const IP_RATE_LIMIT = 20; // max submissions from one IP per hour (best-effort, per-instance)
const BUDGET_LIMIT = 60; // submissions per window, per client + campaign
const BUDGET_WINDOW_SECONDS = 60;
const IP_BUDGET_LIMIT = 20; // submissions per window, per caller IP
const IP_BUDGET_WINDOW_SECONDS = 60 * 60;
const HOUR_MS = 60 * 60 * 1000;
const VALID_CHANNELS: AssessmentChannel[] = ["sms", "email", "whatsapp"];

// Best-effort per-IP cap. In-process and per-instance only (not distributed), so
// it blunts a single-instance flood; the durable per-contact cap lives in the DB.
const ipHits = new Map<string, number[]>();
function tooManyForIp(ip: string, now: number): boolean {
  const cutoff = now - HOUR_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  hits.push(now);
  ipHits.set(ip, hits);
  // Opportunistic cleanup so the map cannot grow unbounded across many IPs.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => t <= cutoff)) ipHits.delete(k);
    }
  }
  return hits.length > IP_RATE_LIMIT;
}

// The per-IP identity comes from the SHARED reader (@/lib/http/client-ip), not
// from a local copy. This route used to prefer the LEFTMOST x-forwarded-for hop —
// the one the caller writes — so both of this endpoint's per-IP ceilings could be
// reset by changing a header, on the one public route in this tree that can spend
// the practice's money (a HIGH band drafts with Claude and sends a real SMS). The
// shared reader takes x-real-ip first and otherwise the RIGHTMOST hop, so two
// spoofed prefixes from one client land on one key. Pinned by the spoof-variant
// tests in public-gates.test.ts.

function ok(
  band: string,
  message: string,
  leadCreated: boolean,
  bookingUrl?: string,
  /**
   * The 0094 bearer, present ONLY when this request created a lead AND stamped its
   * funnel position on it. It is the browser's authorisation to report further
   * progress on that one lead and nothing else. Opaque and PII-free: a random UUID
   * minted here, meaningful only to the row it was written on.
   */
  funnelToken?: string,
): Response {
  return Response.json(
    {
      ok: true,
      band,
      message,
      leadCreated,
      ...(bookingUrl ? { bookingUrl } : {}),
      ...(funnelToken ? { funnelToken } : {}),
    },
    { status: 202 },
  );
}

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

const BAND_MESSAGE: Record<"high" | "medium" | "low", string> = {
  high: "Thanks. We'll be in touch in moments.",
  medium: "Thanks. A team member will reach out soon.",
  low: "Thanks. Here's what we'd suggest as your next step.",
};

/**
 * WHERE IN THE FUNNEL THIS PERSON WAS when they gave their details (0094), or null
 * when we cannot say honestly.
 *
 * SERVER-DERIVED, ALWAYS. The browser tells us ONE thing — which save of the funnel
 * it walked — and nothing else: not the step, not the length. Both numbers come
 * from re-deriving the canonical numbering (step-numbering.ts) off the campaign's
 * OWN stored graph, so a caller cannot put a fraction of their choosing on a
 * practice's worklist.
 *
 * AND THE VERSIONS MUST MATCH, which is the whole reason the browser sends one.
 * flow_version bumps on every save (0078) and only the CURRENT graph is stored, so
 * if the owner republished while this patient was answering, the funnel we can
 * measure is not the funnel they walked — its screens may have been added, removed
 * or reordered. There is no older graph to fall back to, so the honest answer is to
 * record nothing: "N of M" from two different versions is not a smaller truth, it
 * is a wrong one, and a blank is a statement the practice can read correctly.
 *
 * ONLY A PUBLISHED, VALID FUNNEL. This is exactly the gate the public page applies
 * before it serves the deterministic runtime at all (assess/[client]/[slug]), so a
 * campaign running the ADAPTIVE fallback stamps nothing — and it must not, because
 * an adaptive session's screens are the model's, so "step 3" would mean a different
 * question for every patient and the fraction would not add up.
 */
function captureStampFor(
  campaign: { flow: unknown; flowVersion: number; flowPublished: boolean } | null,
  declaredFlowVersion: unknown,
): FunnelCaptureStamp | null {
  if (!campaign || !campaign.flowPublished) return null;
  if (typeof declaredFlowVersion !== "number" || !Number.isInteger(declaredFlowVersion)) return null;
  if (declaredFlowVersion !== campaign.flowVersion) return null;
  const checked = normaliseAndValidateFlow(campaign.flow);
  if (!checked.graph || !checked.result.ok) return null;
  return funnelCaptureStamp(stepNumbering(checked.graph));
}

/** Coerce a raw responses object into a clean { questionId: optionValue } map. */
function parseResponses(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (QUIZ_QUESTION_IDS.includes(k) && typeof v === "string" && v.trim() !== "") {
      out[k] = v.trim();
    }
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  // Abuse posture: the quiz is genuinely public (anyone may fill it), so a
  // page-embedded key is not a real secret and we must NOT auto-send a real SMS
  // on an untrusted submit. We always RECORD the assessment, but only fire the
  // Speed-to-lead bridge (which sends a real SMS) when the request is TRUSTED:
  // it carried the practice's SMILE_ASSESSMENT_SUBMIT_KEY (server-to-server embed
  // / verified origin). With no key configured (local/dev) everything is trusted.
  // An untrusted high scorer is still recorded for staff to action from the
  // worklist. NOTE: a CAPTCHA/Turnstile is the proper gate before exposing the
  // auto-contact path to anonymous web traffic; tracked separately.
  const requiredKey = process.env.SMILE_ASSESSMENT_SUBMIT_KEY;
  const providedKey = request.headers.get("x-intake-key") ?? str(body.intakeKey);
  // "Trusted" submits may auto-send a real SMS. Two ways in with a key configured:
  // the raw key itself (server-to-server integrations), or the short-lived page
  // token our public funnel/embeds fetch from /api/smile-assessment/token (see
  // embed-token.ts for the threat model) — checked below once the client slug is
  // parsed. With NO key configured: trusted only outside production, so an
  // un-gated deploy can never be used as an open SMS relay.
  const keyTrusted = requiredKey
    ? providedKey === requiredKey
    : process.env.NODE_ENV !== "production";

  try {
    // Identify the funnel this submission came through before anything else: both
    // durable budget keys are derived from it.
    const clientSlug = str(body.clientSlug);
    const campaignSlug = str(body.campaignSlug);
    const ip = clientIp(request);

    // Durable, distributed spend ceiling FIRST, before any scoring, DB write or model
    // call. This endpoint is public and its Speed-to-lead bridge drafts the first
    // contact with Claude, so an unbounded flood costs real model and Twilio spend on
    // a live account. The in-process per-IP cap further down only bounds ONE
    // serverless instance and resets on every cold start; this is the shared guard
    // (api_budget, the same one the landing-lead route uses), so it holds across every
    // instance. Per caller first, then per client + campaign, so neither rotating IPs
    // nor rotating campaign slugs gets round it. Fails OPEN on a DB blip, so a
    // transient outage degrades the ceiling rather than breaking the quiz.
    if (!(await consumeBudget(`smile-submit-ip:${ip}`, IP_BUDGET_LIMIT, IP_BUDGET_WINDOW_SECONDS))) {
      return bad("too many submissions, please try again later", 429);
    }
    if (
      !(await consumeBudget(
        `smile-submit:${clientSlug ?? ""}:${campaignSlug ?? ""}`,
        BUDGET_LIMIT,
        BUDGET_WINDOW_SECONDS,
      ))
    ) {
      return bad("too many submissions, please try again later", 429);
    }

    const firstName = str(body.firstName);
    // Canonicalise so the rate-limit is per-handset, only valid addresses reach
    // Twilio/Resend, and the lead:<phone> key matches the inbound webhook.
    const rawEmail = str(body.email);
    const rawPhone = str(body.phone);
    const email = normaliseEmail(rawEmail);
    const phone = toE164(rawPhone);
    // If a contact detail was TYPED but is not deliverable, ask the patient to fix
    // it rather than silently recording an unreachable lead and then promising a
    // callback we can never make. Mirrors the client-side canSubmit requirement.
    if (rawPhone && !phone) return bad("Please check your mobile number and try again.");
    if (rawEmail && !email) return bad("Please check your email address and try again.");
    const channelRaw = str(body.channel);
    const channel =
      channelRaw && VALID_CHANNELS.includes(channelRaw as AssessmentChannel)
        ? (channelRaw as AssessmentChannel)
        : undefined;

    if (!firstName) return bad("firstName is required");

    const responses = parseResponses(body.responses);
    if (Object.keys(responses).length === 0) {
      return bad("at least one valid quiz answer is required");
    }

    // Resolve the campaign (if this came through a targeted /assess/<client>/<slug>
    // landing). It overrides the site, tunes the scoring to the campaign's goal +
    // budget, and is recorded against every response for attribution. A paused or
    // unknown slug resolves to null (we fall back to the generic quiz behaviour).
    const client = clientSlug ? getClient(clientSlug) : undefined;
    const campaign =
      client && campaignSlug ? await getActiveCampaignBySlug(client.id, campaignSlug) : null;

    // Trust resolution, part 2: the page token our own funnel (and the website
    // iframe embed) fetched just before submitting. Valid token = trusted, so a
    // qualified patient is contacted instantly without ever shipping the raw
    // submit key to a browser.
    const trusted = keyTrusted || verifySubmitToken(str(body.pageToken), clientSlug ?? "");

    // Resolve the site: the campaign's site wins; otherwise the site MUST belong to
    // the resolved client. Never trust a free-floating siteId on this public write,
    // which would let a caller attribute a response (and an outbound SMS) to a site
    // they have no relationship with. An explicit siteId is honoured only if it is
    // one of the resolved client's own sites; otherwise we use the client's first.
    const explicitSite = str(body.siteId);
    let siteId: string | undefined;
    if (campaign) {
      siteId = campaign.siteId;
    } else if (client) {
      const clientSites = getSites(client.id);
      siteId =
        explicitSite && clientSites.some((s) => s.id === explicitSite)
          ? explicitSite
          : clientSites[0]?.id;
    }
    if (!siteId) return bad("could not resolve a site from clientSlug or siteId");

    // Second per-IP cap (cheap, in-process) so a flood is blunted before any DB hit.
    if (tooManyForIp(ip, Date.now())) {
      return bad("too many submissions, please try again later", 429);
    }

    // Durable per-contact rate-limit (a high score can send an SMS).
    const contactKey = phone ?? email;
    if (contactKey) {
      const recent = await countRecent(contactKey, new Date(Date.now() - HOUR_MS).toISOString());
      if (recent >= CONTACT_RATE_LIMIT) {
        return bad("too many submissions from this contact, please try again later", 429);
      }
    }

    // Score (intent/fit only). A campaign tunes the score to its goal + budget band.
    const tuning: ScoreTuning | undefined = campaign
      ? { goal: campaign.goal, targetBudget: campaign.targetBudget }
      : undefined;
    const { rawScore, band } = scoreAssessment(responses, tuning);

    // Denormalise the treatment interest for the worklist: the patient's own answer
    // wins; if they didn't pick one, fall back to the campaign's goal label.
    const treatmentValue = responses[Q_TREATMENT];
    const treatmentInterest = treatmentValue
      ? questionById(Q_TREATMENT)?.options.find((o) => o.value === treatmentValue)?.label ?? null
      : campaign
        ? goalLabel(campaign.goal)
        : null;

    const source = campaign ? `smile:${campaign.slug}` : "quiz";

    const response = await insertResponse({
      siteId,
      firstName,
      email: email ?? null,
      phone: phone ?? null,
      channel: channel ?? null,
      treatmentInterest,
      responses,
      rawScore,
      band,
      source,
      campaignId: campaign?.id ?? null,
    });

    // Owner kill-switch: if the smile-assessment system is off, still record the
    // response above but skip the outbound Speed-to-lead bridge, returning the same
    // benign shape a skipped-bridge submission produces (never reveal it is off).
    const smileEnabled = await isSystemEnabledForSend(client?.id ?? "", "smile-assessment");

    // ------------------------------------------------------------------------
    // META CONVERSIONS API (0083): tell the practice's ad account that an enquiry
    // happened. Everything about this block is subordinate to one rule — IT CANNOT
    // AFFECT THIS SUBMISSION. `sendAssessmentLeadEvent` has no throwing path and
    // returns a result nobody reads; a practice with tracking off costs nothing at
    // all (no I/O, no environment read); and every failure — no token, no
    // migration, a Meta outage, a timeout — is a silent skip.
    //
    // WHAT LEAVES: event name, time, page URL, action source, and an opaque id
    // shared with the browser's own Lead event so Meta counts one conversion
    // rather than two. The patient's hashed email/phone ride along ONLY when THIS
    // DEVICE consented to the pixel (body.metaConsent, sent by the quiz and never
    // inferred here) AND the practice switched advanced matching on. Neither key
    // alone opens it. No IP, no user agent, no name, no answers, no score.
    //
    // BEHIND THE KILL SWITCH, because a call to Facebook about a patient is an
    // outbound act, and switching the system off has to shut that door too.
    //
    // AWAITED IN PLACE rather than fired and forgotten: an unawaited promise in a
    // serverless function is a promise that may simply be killed when the response
    // is returned, and an event that reports conversions only sometimes is worse
    // than one that reports none. The call is time-boxed at 2.5s inside the sender.
    //
    // AND IT IS WRAPPED HERE AS WELL AS INSIDE THE SENDER. That is not belt and
    // braces for its own sake: this whole handler sits in one big try whose catch
    // answers 500 "could not record your assessment" — a sentence that would be a
    // lie, because the assessment IS recorded by this point. Anything thrown by
    // the Meta block would take that path. The sender has no throwing path today
    // (pinned in meta-pixel-wiring.test.ts); this makes that a property of the
    // CALL SITE rather than a fact about the callee that a future edit could undo.
    try {
      if (smileEnabled && client) {
        const metaPixel = await resolveMetaPixel(client.id);
        if (metaPixel.enabled) {
          // Built from OUR OWN resolved records, never from the caller's strings:
          // the origin is this request's, and the slugs are the ones the server
          // matched. The sender strips any query string before sending it on.
          const origin = new URL(request.url).origin;
          const path = campaign
            ? `/assess/${client.slug}/${campaign.slug}`
            : `/assess/${client.slug}`;
          await sendAssessmentLeadEvent({
            clientId: client.id,
            config: metaPixel,
            nowMs: Date.now(),
            sourceUrl: `${origin}${path}`,
            eventId: str(body.metaEventId),
            // THE VISITOR'S OWN ANSWER, and the only thing that can unlock a hash.
            // `=== true` rather than a truthiness check: a missing field, a string,
            // or anything else at all means "not consented".
            consented: body.metaConsent === true,
            email,
            phone,
          });
        }
      }
    } catch {
      // A conversion Meta will not hear about. The patient's submission is
      // already recorded and is not affected in any way.
    }
    // ------------------------------------------------------------------------

    // Owner kill-switch, second half: the bridge below creates a Speed-to-lead lead
    // and first-contacts the patient, so it is a SPEED-TO-LEAD send and the
    // Speed-to-lead switch must hold here as well. Without this check an assessment
    // submission still reached the patient after the owner had explicitly switched
    // Speed-to-lead off, which is exactly what that switch is for. Send-path variant,
    // so it fails CLOSED once messaging is live. With it off we record the response
    // and create no lead at all (the intake route takes the same line), so nothing is
    // left at stage 'new' for the sweep to text later.
    const speedToLeadEnabled = await isSystemEnabledForSend(client?.id ?? "", "speed-to-lead");

    // Online-booking link-up: EVERY band may book (finishing the assessment is
    // the invitation), so the success response carries the public booking page
    // URL whenever the client+site resolved and the online-booking system is on.
    const bookingEnabled = client ? await isSystemEnabled(client.id, "online-booking") : false;
    const bookingUrl =
      client && bookingEnabled ? `/book/${client.slug}?site=${siteId}` : undefined;

    // BRIDGE: a qualifying submission with a reachable contact becomes a
    // Speed-to-lead lead and is contacted instantly. Consent is implied by
    // submitting the quiz; the chosen channel must have a deliverable address. If
    // neither phone nor email is present we simply record the response and skip
    // the bridge.
    //
    // WHO QUALIFIES IS NOW THE CAMPAIGN'S DECISION (0082), and it is the ONLY
    // thing this feature changes here. `shouldFollowUp` with the OFF config —
    // which is what every campaign has until an owner switches one on, and what a
    // campaign-less submission gets by construction — returns exactly
    // `band === "high"`, the expression this replaced. An owner who chooses "every
    // submission" widens the band and nothing else: the four conditions beside it,
    // the consent record built below, the suppression check, the deliverability
    // check, the guardrail and both kill switches are untouched and still decide
    // whether a single character reaches anybody.
    let leadCreated = false;
    /**
     * 0094. Set only when THIS request created a lead and successfully stamped its
     * funnel position, so it is returned to exactly the browser that earned it.
     * Deliberately NOT set on either dedup path below: those link the response to a
     * lead that already existed (from the website form, a missed call, an earlier
     * submit), and writing this funnel's screens onto somebody else's enquiry would
     * put a sentence on the worklist about a journey that lead did not take.
     */
    let funnelToken: string | undefined;
    const hasContact = Boolean(phone || email);
    const followUp = followUpConfig(campaign);
    if (shouldFollowUp(followUp, band) && hasContact && trusted && smileEnabled && speedToLeadEnabled) {
      // DEMO DECISION (owner): first contact goes by SMS whenever a phone exists.
      // A "whatsapp" preference never reaches here (it is not in VALID_CHANNELS,
      // so it parses to undefined and falls through to SMS) — the WhatsApp sender
      // is not live yet (practice's Meta login pending). Revisit when connected.
      const requestedChannel: "sms" | "email" | undefined =
        channel === "whatsapp" ? "sms" : channel;
      const leadChannel: LeadChannel =
        requestedChannel ?? (phone ? "sms" : "email");
      // Guard: the chosen/derived channel must have its address, else fall back.
      const safeChannel: LeadChannel =
        leadChannel === "email" && !email
          ? "sms"
          : leadChannel === "sms" && !phone
            ? "email"
            : leadChannel;
      const consent: LeadConsent = {
        sms: !!phone,
        email: !!email,
        whatsapp: false,
        marketing: false,
      };
      try {
        // Dedup: if an open lead for this contact already exists (e.g. they did
        // the intake form too), link to it and skip a second first-contact SMS.
        const sinceIso = new Date(Date.now() - HOUR_MS).toISOString();
        const existing = await findOpenLeadByAddress(siteId, phone, email, sinceIso);
        if (existing) {
          await setResponseLead(response.id, existing.id);
          return ok(band, BAND_MESSAGE[band], true, bookingUrl);
        }
        const lead = await insertLead({
          siteId,
          name: firstName,
          email: email ?? null,
          phone: phone ?? null,
          channel: safeChannel,
          treatmentInterest,
          source: campaign ? `smile:${campaign.slug}` : "smile-assessment",
          score: rawScore,
          consent,
        });

        // Double-submit race guard (the same post-insert re-check the intake route
        // uses). There is no DB unique constraint on (site, contact), so two
        // near-simultaneous submits can BOTH pass the pre-insert dedup above and
        // create two leads, which means two first-contact texts to the same person.
        // Re-check for a STRICTLY-earlier open lead; if one exists ours lost the
        // race, so retire it, point the response at the winner and send nothing.
        const earlier = await findEarlierOpenLead(
          siteId,
          phone,
          email,
          sinceIso,
          lead.id,
          lead.createdAt,
        );
        if (earlier) {
          await setLeadStage(lead.id, "lost");
          await setResponseLead(response.id, earlier.id);
          return ok(band, BAND_MESSAGE[band], true, bookingUrl);
        }

        await setResponseLead(response.id, lead.id);
        leadCreated = true;

        // ------------------------------------------------------------------
        // WHERE IN THE FUNNEL THEY WERE (0094). Its own statement, its own
        // try/catch, and nothing above depends on it:
        //
        //   IT CANNOT COST AN ENQUIRY. The lead is already committed. On a
        //   database where 0094 has not been applied the update is rejected and
        //   caught here, the lead and the first contact below are untouched, and
        //   the worklist simply says nothing about this person's funnel — which is
        //   exactly what it says about every lead today. Folding these columns into
        //   the insert would have made an un-migrated database lose the enquiry.
        //
        //   THE TOKEN IS ONLY RETURNED IF THE ROW REALLY HOLDS IT. A token the
        //   database never stored is one every later post is dropped for, and the
        //   browser would spend the session posting into a bin.
        //
        //   MINTED HERE, NOT ACCEPTED FROM THE CALLER. randomUUID is unguessable
        //   whatever the patient's browser has, cannot collide with a token already
        //   in the table, and — being a different mint from the anonymous step
        //   beacon's nonce — can never make assessment_step_event joinable to this
        //   named person. See supabase/migrations/0094.
        // ------------------------------------------------------------------
        const stamp = captureStampFor(campaign, body.flowVersion);
        if (stamp && campaign) {
          const token = randomUUID();
          try {
            const stamped = await stampLeadFunnelCapture({
              leadId: lead.id,
              lastStep: stamp.lastStep,
              totalSteps: stamp.totalSteps,
              flowVersion: campaign.flowVersion,
              nonce: token,
            });
            if (stamped) funnelToken = token;
          } catch {
            // No progress recorded for this lead. Nothing else changes.
          }
        }
        // Fire first contact in-request so the patient hears back instantly — but
        // CLAIM the lead first (mirrors the intake route): without the atomic
        // 'new' -> 'contacting' flip, the SLA sweep can pick the same brand-new
        // lead mid-request and the patient gets texted TWICE.
        if (await claimLeadForContact(lead.id)) {
          try {
            await contactLead(
              lead,
              campaign
                ? { goal: goalLabel(campaign.goal), idealCustomer: campaign.idealCustomer }
                : undefined,
            );
          } catch {
            // The SLA sweep on the speed-to-lead side will retry; the lead is recorded.
          } finally {
            // Release a stranded claim ('contacting' -> 'new') so the sweep can retry.
            // contactLead advances to 'contacted'/'lost' on success, so this is a
            // no-op then; it only matters on a throw or a silent early-return.
            try {
              await releaseLeadClaim(lead.id);
            } catch {
              /* best effort */
            }
          }
        }
      } catch {
        // Bridging failed (e.g. DB hiccup). The assessment is already recorded;
        // never fail the patient's submission over the fast-track.
      }
    }

    // A high scorer we didn't auto-contact (untrusted submit) gets the softer
    // "a team member will reach out" message, not "in moments".
    const message = band === "high" && !leadCreated ? BAND_MESSAGE.medium : BAND_MESSAGE[band];
    return ok(band, message, leadCreated, bookingUrl, funnelToken);
  } catch {
    // Never throw to the client.
    return bad("could not record your assessment", 500);
  }
}
