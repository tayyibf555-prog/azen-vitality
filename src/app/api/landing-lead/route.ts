import { getClient } from "@/lib/mock/clients";
import { resolveEffectiveSite } from "@/lib/landing/site";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { getLivePageBySlug } from "@/lib/landing/repository";
import { consumeBudget } from "@/lib/rate-budget";
import { insertFunnelEvents, isValidSessionId } from "@/lib/funnel/events";
import {
  insertLead,
  findOpenLeadByAddress,
  findEarlierOpenLead,
  setLeadStage,
  countRecentByContact,
} from "@/lib/speed-to-lead/repository";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";

export const dynamic = "force-dynamic";

// PUBLIC lead-capture endpoint for the bespoke landing pages' embedded consultation
// form (Invisalign, composite bonding, and any future bespoke page). A visitor's
// enquiry POSTs JSON here; we record a Speed-to-lead lead (feeding the worklist) and
// emit the funnel `lead` event (feeding the A/B Leads column). The lead's treatment
// interest + source are derived from the resolved LIVE page, never hardcoded.
//
// ABUSE POSTURE (mirrors the smile-assessment + speed-to-lead intake routes): this
// is unauthenticated, so it validates hard, is bounded by the shared durable budget
// guard PER IP and per landing slug AND by a per-contact rate-limit, only ever
// records a lead for a LIVE landing page, and never throws to the client. It
// exposes no keys.
//
// NO SEND IN THE REQUEST PATH. An inbound HTTP request must never itself be able to
// cause a real outbound message: that is what turns an open form into a way to burn
// the practice's Twilio and model spend. First contact is done by the Speed-to-lead
// SLA sweep (/api/speed-to-lead/sweep), which sits behind cron auth, the owner kill
// switch and the same atomic 'new' -> 'contacting' claim, so the patient is still
// contacted exactly once.

const BUDGET_LIMIT = 60; // requests per window, per landing slug
const BUDGET_WINDOW_SECONDS = 60;
const IP_BUDGET_LIMIT = 20; // enquiries per window, per caller IP
const IP_BUDGET_WINDOW_SECONDS = 60 * 60;
const CONTACT_RATE_LIMIT = 5; // max leads from one phone/email per hour
const HOUR_MS = 60 * 60 * 1000;
const VALID_CHANNELS: LeadChannel[] = ["sms", "email", "whatsapp"];
const MAX_NAME = 120;
const MAX_MESSAGE = 1000;

function ok(): Response {
  return Response.json({ success: true }, { status: 200 });
}

function bad(error: string, status = 400): Response {
  return Response.json({ success: false, error }, { status });
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** The caller's IP as the edge reports it, or "unknown" when no header is present. */
function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    body = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return bad("Request body must be valid JSON");
  }

  try {
    const clientSlug = str(body.clientSlug) ?? "";
    const landingSlug = str(body.landingSlug) ?? "";

    // Durable, distributed ceiling PER CALLER first: the per-slug budget below bounds
    // one page, this bounds one caller across every page, so a script cannot simply
    // rotate slugs to keep spending. Same shared guard (api_budget) the smile-
    // assessment submit route uses, so it holds across every serverless instance
    // rather than per process, and cannot be reset by a cold start.
    const ip = clientIp(request);
    if (!(await consumeBudget(`landing-lead-ip:${ip}`, IP_BUDGET_LIMIT, IP_BUDGET_WINDOW_SECONDS))) {
      return bad("Too many requests, please try again shortly.", 429);
    }

    // Durable, distributed ceiling keyed per landing slug (bounds spam even for an
    // unknown slug). Fails OPEN on a DB blip so a transient outage degrades the cap
    // rather than the form.
    if (!(await consumeBudget(`landing-lead:${clientSlug}:${landingSlug}`, BUDGET_LIMIT, BUDGET_WINDOW_SECONDS))) {
      return bad("Too many requests, please try again shortly.", 429);
    }

    // ---- validate the enquiry ----
    const name = str(body.name);
    if (!name) return bad("Please enter your name.");
    if (name.length > MAX_NAME) return bad("Please shorten your name.");

    const rawPhone = str(body.phone);
    const rawEmail = str(body.email);
    // Canonicalise so the rate-limit key is per-handset, the lead:<phone> thread key
    // matches the inbound webhook, and only well-formed addresses reach the sender.
    const phone = toE164(rawPhone);
    const email = normaliseEmail(rawEmail);
    if (rawPhone && !phone) return bad("Please check your mobile number and try again.");
    if (rawEmail && !email) return bad("Please check your email address and try again.");
    if (!phone && !email) return bad("Please add a mobile number or an email address.");

    const channelRaw = str(body.channel);
    if (!channelRaw || !VALID_CHANNELS.includes(channelRaw as LeadChannel)) {
      return bad("Please choose how we should reach you.");
    }
    const channel = channelRaw as LeadChannel;
    // The chosen channel must have its deliverable address.
    if (channel === "email" && !email) return bad("Please add an email address for the email channel.");
    if ((channel === "sms" || channel === "whatsapp") && !phone) {
      return bad("Please add a mobile number for SMS or WhatsApp.");
    }

    const consent = body.consent === true;
    if (!consent) return bad("Please tick the box so we can contact you about your enquiry.");

    const message = str(body.message);
    if (message && message.length > MAX_MESSAGE) return bad("Please shorten your message.");

    const variant: "a" | "b" = str(body.variant) === "b" ? "b" : "a";
    const rawSession = body.sessionId;
    const sessionId = isValidSessionId(rawSession) ? rawSession : `lead_${Date.now().toString(36)}`;

    // ---- resolve the client + confirm a LIVE landing page ----
    const client = getClient(clientSlug);
    if (!client) return bad("Unknown practice.", 404);

    // Only a LIVE page captures leads: a draft/archived page (or an unknown slug)
    // must not accept enquiries. This also yields the site the lead belongs to.
    const found = await getLivePageBySlug(client.id, landingSlug);
    if (!found) return bad("This page is not accepting enquiries.", 404);

    // An explicit siteId in the POST body lets one published page route its lead
    // to a different practice site than the page's own configured site (mirrors
    // the /go page's ?site= override, and reuses the same validation policy).
    // Honoured ONLY when it names a site that belongs to THIS client — a forged
    // id from another client is rejected — otherwise the page's own configured
    // site stands.
    const requestedSiteId = str(body.siteId);
    const siteId = resolveEffectiveSite(client.id, requestedSiteId, found.page.siteId ?? "site-cc");

    // Durable per-contact rate-limit (a lead can trigger a real first contact).
    const contactKey = phone ?? email!;
    const sinceIso = new Date(Date.now() - HOUR_MS).toISOString();
    const recent = await countRecentByContact(contactKey, sinceIso);
    if (recent >= CONTACT_RATE_LIMIT) {
      return bad("We already have your enquiry. The team will be in touch shortly.", 429);
    }

    // Dedup: if an open lead for this contact already exists (e.g. a second submit),
    // reuse it rather than creating a duplicate lead + a second first-contact.
    const existing = await findOpenLeadByAddress(siteId, phone, email, sinceIso);
    if (existing) return ok();

    // Consent: the enquiry ticked the single consent box, so the chosen channel is
    // consented and the same tick is the marketing basis (per the intake convention).
    // Built so only the chosen channel key is set (plus marketing): { [channel]: true }.
    const leadConsent: LeadConsent = { marketing: consent };
    leadConsent[channel] = true;
    // WhatsApp reaches the same handset as SMS, and every other module records it
    // that way (see the intake route's consent block). Without sms:true a WhatsApp
    // lead gets its first message and then nothing: the nurture cadence requires
    // consent.sms and would retire it un-nurtured on the very next sweep.
    if (channel === "whatsapp") leadConsent.sms = true;

    // Derive the treatment interest + source from the resolved LIVE page rather than
    // hardcoding, so every landing page (bespoke or generic) records the right
    // interest. invisalign -> "Invisalign" / "landing:invisalign"; bonding ->
    // "Composite bonding" / "landing:bonding". An unknown treatment key falls back to
    // the key itself so the lead is never dropped.
    const treatmentInterest =
      TREATMENTS.find((t) => t.key === found.page.treatment)?.name ?? found.page.treatment;
    const source = `landing:${found.page.slug}`;

    const lead = await insertLead({
      siteId,
      name,
      email: email ?? null,
      phone: phone ?? null,
      channel,
      treatmentInterest,
      source,
      consent: leadConsent,
    });

    // Double-submit race guard (the same post-insert re-check the intake route uses).
    // There is no DB unique constraint on (site, contact), so two near-simultaneous
    // submits can BOTH pass the pre-insert dedup above and create two leads, which
    // the sweep would then first-contact separately: two texts to the same person.
    // Re-check for a STRICTLY-earlier open lead; if one exists ours lost the race, so
    // retire it and defer to the winner (which also keeps the A/B Leads count honest,
    // exactly as the dedup branch above does).
    const earlier = await findEarlierOpenLead(siteId, phone, email, sinceIso, lead.id, lead.createdAt);
    if (earlier) {
      await setLeadStage(lead.id, "lost");
      return ok();
    }

    // Emit the funnel `lead` event so the A/B Leads column reflects this conversion.
    // Best-effort: telemetry must never fail the enquiry (the lead is already saved).
    try {
      await insertFunnelEvents([
        { clientId: client.id, surface: "landing", sessionId, step: "lead", meta: { variant, landingSlug } },
      ]);
    } catch {
      /* telemetry only */
    }

    // First contact is DELIBERATELY not fired here. The lead is left at stage 'new'
    // with no first response, which is exactly what listUncontacted selects, so the
    // Speed-to-lead SLA sweep picks it up on its next tick and contacts it there:
    // behind cron auth, behind the owner kill switch (checked at the moment of the
    // send, which is stricter than checking it here) and behind the same atomic
    // 'new' -> 'contacting' claim, so there is still exactly one first contact.
    return ok();
  } catch {
    // Never throw to the client.
    return bad("Could not record your enquiry, please try again.", 500);
  }
}
