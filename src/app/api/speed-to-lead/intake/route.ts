import { getClient, getSites, getSite } from "@/lib/mock/clients";
import { contactLead } from "@/lib/speed-to-lead/contact";
import { countRecentByContact, findOpenLeadByAddress, findEarlierOpenLead, insertLead, setLeadStage, claimLeadForContact, releaseLeadClaim } from "@/lib/speed-to-lead/repository";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { isSystemEnabled } from "@/lib/systems/repository";
import type { LeadChannel, LeadConsent } from "@/lib/speed-to-lead/types";

export const dynamic = "force-dynamic";

// Public intake endpoint. A new enquiry (web form, Facebook Lead Ad, etc.) POSTs
// JSON here; we record the lead and fire first contact within the request so the
// patient hears back in seconds. Like the Twilio webhook this is unauthenticated,
// so it validates hard, rate-limits per contact, and never throws to the client.

const RATE_LIMIT = 5; // max enquiries from one phone/email per hour
const HOUR_MS = 60 * 60 * 1000;
const VALID_CHANNELS: LeadChannel[] = ["sms", "email", "whatsapp"];

function bad(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
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

  // Abuse gate: this endpoint sends a real SMS to a caller-supplied number, so on
  // a public deploy it must be tied to the practice's own forms. When
  // SPEED_TO_LEAD_INTAKE_KEY is set, every submission must carry it (x-intake-key
  // header or `intakeKey` in the body); otherwise an attacker could blast SMS to
  // arbitrary numbers. Unset (local/dev) leaves it open for convenience.
  const requiredKey = process.env.SPEED_TO_LEAD_INTAKE_KEY;
  if (requiredKey) {
    const provided = request.headers.get("x-intake-key") ?? str(body.intakeKey);
    if (provided !== requiredKey) return bad("unauthorized", 401);
  } else if (process.env.NODE_ENV === "production") {
    // Fail closed: an SMS-sending public endpoint must not ship un-gated in prod.
    return bad("intake not configured", 503);
  }

  try {
    const name = str(body.name);
    // Normalise to canonical forms so the rate-limit key is per-handset, the
    // lead:<phone> conversation key matches the inbound webhook, and only
    // well-formed addresses reach Twilio/Resend.
    const email = normaliseEmail(str(body.email));
    const phone = toE164(str(body.phone));
    const channel = str(body.channel) as LeadChannel | undefined;
    const treatmentInterest = str(body.treatmentInterest) ?? null;
    const source = str(body.source) ?? "web";

    if (!name) return bad("name is required");
    if (!channel || !VALID_CHANNELS.includes(channel)) {
      return bad("channel must be one of sms, email, whatsapp");
    }
    // The chosen channel must have a deliverable, well-formed address
    // (email/phone are null above if the submitted value didn't normalise).
    if (channel === "email" && !email) return bad("a valid email is required for the email channel");
    if ((channel === "sms" || channel === "whatsapp") && !phone) {
      return bad("a valid phone number is required for the sms or whatsapp channel");
    }

    // Resolve the site from the resolved CLIENT. Never trust a free-floating
    // siteId on this public write, which would let a caller attribute a lead (and
    // an outbound SMS) to another tenant's site they have no relationship with. An
    // explicit siteId is honoured only if it is one of the resolved client's own
    // sites; otherwise we fall back to the client's first site. This mirrors the
    // smile-assessment intake, which scopes the siteId the same way.
    const explicitSite = str(body.siteId);
    const clientSlug = str(body.clientSlug);
    const client = clientSlug ? getClient(clientSlug) : undefined;
    let siteId: string | undefined;
    if (client) {
      const clientSites = getSites(client.id);
      siteId =
        explicitSite && clientSites.some((s) => s.id === explicitSite)
          ? explicitSite
          : clientSites[0]?.id;
    } else if (explicitSite && getSite(explicitSite)) {
      // No clientSlug supplied: honour a bare siteId (legacy single-tenant forms).
      siteId = explicitSite;
    }
    if (!siteId) return bad("could not resolve a site from clientSlug or siteId");

    // Owner kill switch: if the practice has turned Speed to Lead off, record
    // nothing and fire no contact. Only reachable once a client is resolved.
    if (client && !(await isSystemEnabled(client.id, "speed-to-lead"))) {
      return Response.json({ ok: false, error: "unavailable" }, { status: 503 });
    }

    // Rate limit per contact (the normalised address on the chosen channel).
    const contactKey = channel === "email" ? email! : phone!;
    const sinceIso = new Date(Date.now() - HOUR_MS).toISOString();
    const recent = await countRecentByContact(contactKey, sinceIso);
    if (recent >= RATE_LIMIT) {
      return bad("too many enquiries from this contact, please try again later", 429);
    }

    // Dedup: if an open lead for this contact already exists (e.g. they did the
    // quiz then the callback form), reuse it instead of creating a second lead +
    // a second first-contact SMS.
    const existing = await findOpenLeadByAddress(siteId, phone, email, sinceIso);
    if (existing) {
      return Response.json({ ok: true, leadId: existing.id, deduped: true }, { status: 202 });
    }

    // Consent: they enquired, so the chosen channel is consented by default.
    const consent: LeadConsent = {
      sms: body.consentSms === true || channel === "sms" || channel === "whatsapp",
      email: body.consentEmail === true || channel === "email",
      whatsapp: channel === "whatsapp" || body.consentSms === true,
      marketing: body.consentMarketing === true,
    };

    const lead = await insertLead({
      siteId,
      name,
      email: email ?? null,
      phone: phone ?? null,
      channel,
      treatmentInterest,
      source,
      consent,
    });

    // Double-submit race guard: there is no DB unique constraint on (site, contact),
    // so two near-simultaneous submits can both pass the pre-insert dedup above. Re-
    // check for a STRICTLY-earlier open lead for this contact; if one exists, ours
    // lost the race, so retire it and defer to the winner rather than sending a
    // second first-contact text.
    const earlier = await findEarlierOpenLead(siteId, phone, email, sinceIso, lead.id, lead.createdAt);
    if (earlier) {
      await setLeadStage(lead.id, "lost");
      return Response.json({ ok: true, leadId: earlier.id, deduped: true }, { status: 202 });
    }

    // Fire first contact inside the request so the patient hears back instantly.
    // Claim the lead ('new' -> 'contacting') first, exactly as the SLA sweep does,
    // to close the double-send race: if the sweep picks this lead the instant it
    // crosses the SLA while this in-request contact is still in flight, ITS claim
    // fails and it skips, so the patient is never first-contacted twice. Our claim
    // always wins here (we just created the row), so a lost claim means a concurrent
    // path already owns the contact and we simply return the recorded lead.
    if (await claimLeadForContact(lead.id)) {
      try {
        await contactLead(lead);
      } catch {
        // First contact will be retried by the SLA sweep; the lead is recorded.
      } finally {
        // Release a stranded claim ('contacting' -> 'new') so the sweep can retry.
        // contactLead advances to 'contacted'/'lost' on success, so this is a no-op
        // then; it only matters on a throw or a silent early-return (no address).
        try { await releaseLeadClaim(lead.id); } catch { /* best effort */ }
      }
    }

    return Response.json({ ok: true, leadId: lead.id }, { status: 202 });
  } catch {
    return bad("could not record the enquiry", 500);
  }
}
