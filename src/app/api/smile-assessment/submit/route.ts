import { getClient, getSites } from "@/lib/mock/clients";
import { scoreAssessment, type ScoreTuning } from "@/lib/smile-assessment/scoring";
import { QUIZ_QUESTION_IDS, Q_TREATMENT, questionById } from "@/lib/smile-assessment/quiz";
import { countRecent, insertResponse, setResponseLead } from "@/lib/smile-assessment/repository";
import type { AssessmentChannel } from "@/lib/smile-assessment/types";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { insertLead, findOpenLeadByAddress } from "@/lib/speed-to-lead/repository";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { getActiveCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { goalLabel } from "@/lib/smile-assessment/campaign";
import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";

export const dynamic = "force-dynamic";

// Public submit endpoint for the embeddable Smile Assessment quiz. An enquiry
// POSTs its answers here; we score it (intent/fit only), record the response, and
// — for a HIGH score with a contact channel — fast-track it into Speed-to-lead so
// the patient is contacted instantly.
//
// ABUSE SURFACE: like the speed-to-lead intake, a high score can trigger a real
// outbound SMS to a caller-supplied number. This is unauthenticated, so it
// validates hard, rate-limits per contact (durable, in the DB) AND per IP
// (best-effort, in-process), and never throws to the client.

const CONTACT_RATE_LIMIT = 5; // max submissions from one phone/email per hour
const IP_RATE_LIMIT = 20; // max submissions from one IP per hour (best-effort, per-instance)
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

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function ok(band: string, message: string, leadCreated: boolean): Response {
  return Response.json({ ok: true, band, message, leadCreated }, { status: 202 });
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
  // "Trusted" submits may auto-send a real SMS. With a key configured, require it.
  // With NO key configured: trusted only outside production. In production an unset
  // key fails closed (record + score, never auto-SMS) so an un-gated deploy can
  // never be used as an open SMS relay.
  const trusted = requiredKey
    ? providedKey === requiredKey
    : process.env.NODE_ENV !== "production";

  try {
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
    const clientSlug = str(body.clientSlug);
    const campaignSlug = str(body.campaignSlug);
    const client = clientSlug ? getClient(clientSlug) : undefined;
    const campaign =
      client && campaignSlug ? await getActiveCampaignBySlug(client.id, campaignSlug) : null;

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

    // Per-IP cap first (cheap, in-process) so a flood is blunted before any DB hit.
    const ip = clientIp(request);
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

    // BRIDGE: a high score with a reachable contact becomes a Speed-to-lead lead
    // and is contacted instantly. Consent is implied by submitting the quiz; the
    // chosen channel must have a deliverable address. If neither phone nor email
    // is present we simply record the response and skip the bridge.
    let leadCreated = false;
    const hasContact = Boolean(phone || email);
    if (band === "high" && hasContact && trusted) {
      const leadChannel: LeadChannel =
        channel ?? (phone ? "sms" : "email");
      // Guard: the chosen/derived channel must have its address, else fall back.
      const safeChannel: LeadChannel =
        leadChannel === "email" && !email
          ? "sms"
          : (leadChannel === "sms" || leadChannel === "whatsapp") && !phone
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
          return ok(band, BAND_MESSAGE[band], true);
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
        await setResponseLead(response.id, lead.id);
        leadCreated = true;
        // Fire first contact in-request so the patient hears back instantly. For a
        // campaign, pass its goal + ideal customer so the opener is tailored (never
        // quote internal targeting/funding terms — contactLead/draft enforce that).
        try {
          await contactLead(
            lead,
            campaign
              ? { goal: goalLabel(campaign.goal), idealCustomer: campaign.idealCustomer }
              : undefined,
          );
        } catch {
          // The SLA sweep on the speed-to-lead side will retry; the lead is recorded.
        }
      } catch {
        // Bridging failed (e.g. DB hiccup). The assessment is already recorded;
        // never fail the patient's submission over the fast-track.
      }
    }

    // A high scorer we didn't auto-contact (untrusted submit) gets the softer
    // "a team member will reach out" message, not "in moments".
    const message = band === "high" && !leadCreated ? BAND_MESSAGE.medium : BAND_MESSAGE[band];
    return ok(band, message, leadCreated);
  } catch {
    // Never throw to the client.
    return bad("could not record your assessment", 500);
  }
}
