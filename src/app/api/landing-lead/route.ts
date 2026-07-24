import { getClient } from "@/lib/mock/clients";
import { resolveEffectiveSite } from "@/lib/landing/site";
import { TREATMENTS } from "@/lib/treatments/catalog";
import { getLivePageBySlug } from "@/lib/landing/repository";
import { consumeBudget } from "@/lib/rate-budget";
import { insertFunnelEvents, isValidSessionId } from "@/lib/funnel/events";
import { contactLead } from "@/lib/speed-to-lead/contact";
import {
  insertLead,
  findOpenLeadByAddress,
  claimLeadForContact,
  releaseLeadClaim,
  countRecentByContact,
} from "@/lib/speed-to-lead/repository";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { isSystemEnabledForSend } from "@/lib/systems/repository";
import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";

export const dynamic = "force-dynamic";

// PUBLIC lead-capture endpoint for the bespoke landing pages' embedded consultation
// form (Invisalign, composite bonding, and any future bespoke page). A visitor's
// enquiry POSTs JSON here; we record a Speed-to-lead lead (feeding the worklist),
// emit the funnel `lead` event (feeding the A/B Leads column), then best-effort
// first-contact the lead inside the request so they hear back quickly. The lead's
// treatment interest + source are derived from the resolved LIVE page, never hardcoded.
//
// ABUSE POSTURE (mirrors the smile-assessment + speed-to-lead intake routes): this
// is unauthenticated and a lead can trigger a real first contact to a caller-
// supplied number, so it validates hard, is bounded by the shared durable budget
// guard AND a per-contact rate-limit, only ever records a lead for a LIVE landing
// page, gates the outbound send behind the Speed-to-lead kill switch, and never
// throws to the client. It exposes no keys.

const BUDGET_LIMIT = 60; // requests per window, per landing slug
const BUDGET_WINDOW_SECONDS = 60;
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

    // Emit the funnel `lead` event so the A/B Leads column reflects this conversion.
    // Best-effort: telemetry must never fail the enquiry (the lead is already saved).
    try {
      await insertFunnelEvents([
        { clientId: client.id, surface: "landing", sessionId, step: "lead", meta: { variant, landingSlug } },
      ]);
    } catch {
      /* telemetry only */
    }

    // Owner kill switch: only auto-contact when Speed-to-lead is ON. When off, the
    // lead is still recorded (worklist + A/B) but no outbound send fires. Fail-closed
    // once messaging is live. Mirrors the smile-assessment bridge's guard.
    if (await isSystemEnabledForSend(client.id, "speed-to-lead")) {
      // Claim the lead ('new' -> 'contacting') first, exactly as the SLA sweep does,
      // so an in-flight sweep cannot first-contact the same brand-new lead twice.
      if (await claimLeadForContact(lead.id)) {
        try {
          await contactLead(lead);
        } catch {
          // First contact will be retried by the SLA sweep; the lead is recorded.
        } finally {
          // Release a stranded claim ('contacting' -> 'new') so the sweep can retry.
          try {
            await releaseLeadClaim(lead.id);
          } catch {
            /* best effort */
          }
        }
      }
    }

    return ok();
  } catch {
    // Never throw to the client.
    return bad("Could not record your enquiry, please try again.", 500);
  }
}
