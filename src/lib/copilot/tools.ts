import Anthropic from "@anthropic-ai/sdk";
import { getSite } from "@/lib/mock";
import { getSites, getClient, dentallySiteId } from "@/lib/mock/clients";
import { SONNET, NO_THINKING } from "@/lib/ai/models";
import { londonDayKey } from "@/lib/time/london";
import { TREATMENTS, findTreatment } from "@/lib/treatments/catalog";
import type { CtaTarget, LandingPageContent } from "@/lib/landing/content";
import { generateBothVariants, type CallModel } from "@/lib/landing/generate-run";
import { deriveSlug } from "@/lib/landing/slug";
import {
  insertPageWithVariants,
  getPageById,
  getPageBySlug,
  setPageStatus,
  SlugTakenError,
} from "@/lib/landing/repository";
import { mintPreviewToken } from "@/lib/landing/preview-token";
import { scanBannedText } from "@/lib/landing/compliance";
import { buildCopyPrompt, cleanCopy } from "@/lib/meta-ads/ai";
import { CAMPAIGN_TEMPLATES } from "@/lib/meta-ads/knowledge";
import type { CampaignObjective } from "@/lib/meta-ads/types";
import { createMetaCampaign, getMetaCampaign, recordPublishResult, type MetaCampaignCopy } from "@/lib/meta-ads/repository";
import { isMetaConnected, metaConnection } from "@/lib/meta-ads/connection";
import { publishCampaign } from "@/lib/meta-ads/publish";
import {
  listPatients,
  searchPatients,
  listAppointments,
  listOutstanding,
  getPatientDetail,
  listSitePractitioners,
  dentallyReadKey,
  dentallyFromEnv,
  type PatientRecord,
} from "@/lib/dentally/read";
import { dentallyAgentClient, isDentallyWriteEnabled } from "@/lib/dentally/write";
import { DentallyError } from "@/lib/dentally/client";
import { normaliseGender, ageFromDob } from "@/lib/patient/demographics";
// The ONE live-calibrated derivation of a new Dentally patient, shared with the
// booking funnel, the 24/7 agent and the onboarding worklist. See patient-payload.ts.
import {
  TITLES,
  knownTitle,
  canonicalDob,
  knownPaymentPlanId,
  genderFromTitle,
  buildPatientRegistration,
} from "@/lib/dentally/patient-payload";
import { readPlanId } from "@/lib/calendar/funding";
// LEAD SIGHT. The co-pilot could describe every patient already in the book and
// nothing at all about the people trying to become one, so these four tools read
// the acquisition pipeline (assessment submissions, the leads worklist, funnel
// drop-off) and re-fire ONE existing send. The rules they apply are pure and live
// in lead-sight.ts; nothing here invents a send path.
import {
  OPEN_LEAD_STAGES,
  countByLondonDay,
  inDayWindow,
  londonDayWindow,
  looksTruncated,
  nudgeRefusal,
  parseBand,
  parseLimit,
  parseWindowDays,
  summariseAttempts,
  waitingMinutes,
  wasSupplied,
} from "./lead-sight";
import { listResponses } from "@/lib/smile-assessment/repository";
import { getCampaignBySlug } from "@/lib/smile-assessment/campaign-repository";
import { normaliseFlow } from "@/lib/smile-assessment/flow";
import { aggregateStepEvents, MAX_FLOW_VERSION } from "@/lib/smile-assessment/step-events";
import { stepNumbering } from "@/lib/smile-assessment/step-numbering";
import { stepLabels } from "@/lib/smile-assessment/step-labels";
import { readStepEvents, StepEventTableMissingError } from "@/lib/smile-assessment/step-events-repository";
import { answerLines } from "@/lib/smile-assessment/summary";
import {
  claimLeadFromStage,
  getLead,
  listAttemptsForLeads,
  listLeads,
  listLeadsByIds,
  setLeadStage,
} from "@/lib/speed-to-lead/repository";
import { channelConsented, contactLead, toAddress } from "@/lib/speed-to-lead/contact";
import { sourceLabel } from "@/lib/speed-to-lead/source-label";
import type { SpeedToLeadLead } from "@/lib/speed-to-lead/types";
import { listTargets } from "@/lib/reactivation/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { getAgentAnalytics } from "@/lib/agent/repository";
import { searchKnowledge } from "@/lib/practice-brain/retrieval";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { wasContactedToday, recordContacted } from "@/lib/messaging/frequency";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { checkAgentReply } from "@/lib/agent/guardrail";
import { isDryRun, type MessageChannel } from "@/lib/messaging/types";
import {
  createCampaign,
  getCampaign,
  updateCampaign,
  campaignStatusCounts,
  campaignVariantCounts,
} from "@/lib/outreach/repository";
import { runOutreachBuildTick } from "@/lib/outreach/build";
import { parseFilters, parseDailyCap, describeSegment } from "@/lib/outreach/validate";
import type { OutreachFilters } from "@/lib/outreach/types";
import { isSystemEnabled } from "@/lib/systems/repository";
import { logCopilotAction } from "./actions";

// The co-pilot's "today" must be the REAL current day in the practice's timezone,
// not the frozen mock clock: once live against real Dentally, a hardcoded date
// would query the wrong day's diary. (Mock fixtures anchored to NOW are a demo
// convenience; production correctness wins.)
const todayIso = () => londonDayKey(new Date());
const siteName = (id: string) => getSite(id)?.name ?? id;

export const COPILOT_TOOLS: Anthropic.Tool[] = [
  {
    name: "patient_record",
    description:
      "Look up a patient by name or phone and return their full record: profile, contact, status, last visit, recall, consent, notes, treatment plans with balances, lifetime spend, and complete appointment history. Use this whenever asked about a specific patient. If several patients match, it returns the list so you can ask which one.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", description: "Patient name or phone number" } },
      required: ["query"],
    },
  },
  {
    name: "search_patients",
    description: "Search patients by name or phone and return brief matches (no full record). Use for 'who are my...' style questions.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "appointments",
    description:
      "List appointments from the diary. With no date, returns today. Pass a date (YYYY-MM-DD) for another day. Returns time, patient, reason, practitioner, site and state.",
    input_schema: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD, optional (defaults to today)" } },
    },
  },
  {
    name: "outstanding_balances",
    description: "List treatment plans with money still owed, ranked by amount, with the practice total outstanding.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "practice_overview",
    description:
      "A high level snapshot of the whole practice right now: patient counts, today's diary, total outstanding, reactivation (dormant patients and recoverable value), treatment recovery, and the AI booking agent's activity.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_knowledge",
    description:
      "Search the practice's knowledge base (the self-learning brain): pricing, USPs, SOPs, scripts, protocols, workflows, marketing and team knowledge the practice has captured. Use for any 'how do we...', 'what is our...', policy, pricing or script question. Returns matching knowledge with a snippet. Answer only from what it returns, cite the titles you use, and if nothing comes back say it is not in the brain yet.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "send_sms",
    description:
      "Send a text message (SMS) to a patient. TWO STEPS: call first WITHOUT confirm to PREVIEW (it checks the patient and consent and returns what would be sent, but does NOT send); then, only after the owner says yes, call again with confirm true to actually send. It only sends if the patient has consented to SMS and has not opted out. Messages currently go out in test mode (recorded, not delivered) until the practice goes live.",
    input_schema: {
      type: "object",
      properties: {
        patient: { type: "string", description: "Patient name or phone number, to identify exactly one patient" },
        message: { type: "string", description: "The exact SMS text to send" },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to preview without sending." },
        override: { type: "boolean", description: "Set true ONLY to deliberately send a SECOND message to a patient already contacted today, after the owner has explicitly said to override the one-per-day limit. Omit otherwise." },
      },
      required: ["patient", "message"],
    },
  },
  {
    name: "send_email",
    description:
      "Send an email to a patient. TWO STEPS: call first WITHOUT confirm to PREVIEW, then call again with confirm true after the owner says yes. It only sends if the patient has consented to email and has not opted out. Test mode applies as with SMS.",
    input_schema: {
      type: "object",
      properties: {
        patient: { type: "string", description: "Patient name or email, to identify exactly one patient" },
        subject: { type: "string" },
        message: { type: "string", description: "The email body" },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to preview without sending." },
        override: { type: "boolean", description: "Set true ONLY to deliberately send a SECOND message to a patient already contacted today, after the owner has explicitly said to override the one-per-day limit. Omit otherwise." },
      },
      required: ["patient", "subject", "message"],
    },
  },
  {
    name: "create_outreach_campaign",
    description:
      "Create a DRAFT segment outreach campaign (or just build a patient list to see how many match) and start scanning the patient base. It NEVER launches or sends anything: it defines the segment, kicks off the scan, and returns the campaign id, a plain-English read-back of the segment, the current matched count, and how many records were skipped for having no recorded age/gender when those filters are used. Use ONLY filter values the owner actually stated; do not invent dates, treatments, ages, gender or a practitioner. A message angle (what the invite is about, e.g. 'a hygiene visit') is OPTIONAL here, so the owner can build a list first; it is required later to launch. You may OPTIONALLY give a SECOND angle (messageAngleB) to test two different messages against each other: each patient is consistently sent one of the two, and the campaign then reports sent/replies/booked for each message so the owner can see which converts. Only set a second angle if the owner asks to try two messages. The build may take a moment; the matched count updates shortly.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for the campaign (optional; one is derived from the angle if omitted)." },
        siteId: { type: "string", description: "Which site's patients to target (optional; defaults to the site currently in view)." },
        treatmentContains: {
          type: "array",
          items: { type: "string" },
          description: "Keywords matched against a patient's past appointment reasons, e.g. ['hygiene','scale & polish']. Only include what the owner asked for.",
        },
        lastVisitAfter: { type: "string", description: "ISO date; include only patients last seen on or after this date." },
        lastVisitBefore: { type: "string", description: "ISO date; include only patients last seen on or before this date." },
        excludeSeenSinceDays: { type: "number", description: "Exclude anyone seen or booked within this many days (so already-engaged patients are left alone)." },
        ageMin: { type: "number", description: "Youngest age to include (inclusive whole years). Only set what the owner stated; for a vague age like 'around 30', pick a range and say so in your read-back." },
        ageMax: { type: "number", description: "Oldest age to include (inclusive whole years)." },
        gender: { type: "string", enum: ["female", "male"], description: "Restrict to female or male patients. Only set it if the owner said so; never guess." },
        practitionerName: { type: "string", description: "The clinician to invite patients to see (optional). Matched to the site's practitioners." },
        messageAngle: { type: "string", description: "What the invite is about, in plain words, e.g. 'a hygiene visit' or 'a check-up'. Optional at this stage (needed before launch)." },
        messageAngleB: { type: "string", description: "OPTIONAL second message angle to A/B test against the first, e.g. a warmer 'we would love to see you again' vs a benefit-led 'time for your hygiene visit'. Only set it if the owner explicitly wants to try two messages. Leave unset for a single message." },
        dailyCap: { type: "number", description: "Max patients contacted per day for this campaign (1 to 100; defaults to 25)." },
      },
      required: [],
    },
  },
  {
    name: "launch_outreach_campaign",
    description:
      "Launch a built outreach campaign so it starts sending on its daily cadence. TWO STEPS, exactly like send_sms: call first WITHOUT confirm (or confirm false) to read back the campaign (name, who it targets in plain English, the matched count, the clinician and the daily cap) and check nothing is sent; then, ONLY after the owner clearly says yes in a later reply, call again with confirm true. It refuses if the campaign is not fully built, and refuses if the Segment outreach system is switched off (telling the owner where to switch it on). Never set confirm true in the same turn as the owner's original request.",
    input_schema: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "The id of the campaign to launch (from create_outreach_campaign or the list)." },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed launch in their own reply. Omit or false to read back without launching." },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "create_landing_page",
    description:
      "Create a campaign LANDING PAGE for a treatment: it generates TWO A/B content variants, runs them through the built-in compliance checks (real catalogue prices only, no testimonials, guarantees, pain-free claims, superlatives, awards, reviews or NHS/private wording), and saves them as a DRAFT page. It NEVER publishes: it returns the page id, the two preview links and a one-line summary of each variant. Use ONLY a treatment the owner named and, if they gave one, their angle; never invent prices, claims, testimonials or awards (the copy is written and compliance-checked automatically). Publishing the page live is a separate confirmed step (launch_landing_page).",
    input_schema: {
      type: "object",
      properties: {
        treatment: { type: "string", description: "The treatment the page is for: a catalogue key (e.g. 'invisalign') or a plain label (e.g. 'teeth straightening') that maps to one." },
        angle: { type: "string", description: "Optional angle or audience note the owner gave, e.g. 'aimed at nervous patients' or 'focus on finance'. Only pass what the owner stated." },
        ctaTarget: { type: "string", enum: ["assessment", "booking"], description: "Where the page's call to action sends visitors: the Smile Assessment funnel ('assessment', the default) or the booking page ('booking')." },
      },
      required: ["treatment"],
    },
  },
  {
    name: "launch_landing_page",
    description:
      "Publish a DRAFT landing page live at its public URL. TWO STEPS, exactly like launch_outreach_campaign: call first WITHOUT confirm to read back the page (its treatment, slug and the URL that will go live) and check nothing is published; then, ONLY after the owner clearly says yes in a later reply, call again with confirm true. It refuses if the page is already live or archived. Never set confirm true in the same turn as the owner's original request.",
    input_schema: {
      type: "object",
      properties: {
        pageId: { type: "string", description: "The id of the landing page to publish (from create_landing_page)." },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to read back without publishing." },
      },
      required: ["pageId"],
    },
  },
  {
    name: "create_meta_campaign",
    description:
      "Assemble a Meta (Facebook and Instagram) ad campaign DRAFT from the owner's stated details and save it, READY to publish. It writes UK-compliant ad copy automatically and pulls real 'from' prices from the price list when the owner wants pricing shown. It does NOT go live: publishing to Meta needs the practice's Meta account connected, so this always returns a ready, not-published campaign. Use ONLY the details the owner gave; never invent an audience, budget, radius or price. Returns the campaign id, a read-back of everything assembled (objective, radius, budget, audience, negatives, the generated headline and primary text, any linked landing page) and the honest not-live status.",
    input_schema: {
      type: "object",
      properties: {
        objective: { type: "string", enum: ["awareness", "leads", "traffic", "engagement", "retargeting"], description: "The campaign objective. Most dental campaigns are 'leads' (the default if unstated)." },
        treatment: { type: "string", description: "The treatment or focus of the campaign (a catalogue key/label like 'implant', or a plain focus like 'new patients')." },
        radiusMiles: { type: "number", description: "The targeting radius in miles around the practice the owner asked for." },
        dailyBudgetGBP: { type: "number", description: "The daily budget in GBP the owner set." },
        audienceNotes: { type: "string", description: "Plain-English audience notes the owner gave, e.g. 'adults 30 to 55 who have thought about implants'." },
        transparentPricing: { type: "boolean", description: "Set true if the owner wants the real 'from' price shown in the ad. The price is pulled from the catalogue, never invented." },
        negativeKeywords: { type: "array", items: { type: "string" }, description: "Words/phrases the owner wants to exclude from targeting or copy." },
        attachLandingSlug: { type: "string", description: "Optional: the slug of a landing page (created with create_landing_page) to send this campaign's clicks to." },
      },
      required: ["treatment"],
    },
  },
  {
    name: "publish_meta_campaign",
    description:
      "The confirmed step to take an assembled Meta campaign live. TWO STEPS like launch_outreach_campaign: call first WITHOUT confirm to read the campaign back, then only after the owner clearly says yes call again with confirm true. It will REFUSE to go live until the practice's Meta account is connected (in Growth, Meta Ads), and it never claims a campaign is running when it is not. Never set confirm true in the same turn as the owner's request.",
    input_schema: {
      type: "object",
      properties: {
        campaignId: { type: "string", description: "The id of the Meta campaign to publish (from create_meta_campaign)." },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to read back without publishing." },
      },
      required: ["campaignId"],
    },
  },
  {
    name: "create_patient",
    description:
      "Create a NEW patient record in Dentally, the practice's real management system. TWO STEPS, exactly like send_sms: call first WITHOUT confirm to CHECK FOR AN EXISTING MATCH and read back every detail that would be saved; then, ONLY after the owner clearly says yes in a later reply, call again with confirm true to actually create them. REQUIRES first name, last name, a title (Mr, Mrs, Miss, Ms or Master), a date of birth (ISO YYYY-MM-DD), how the patient is to be seen (NHS or private) AND at least one of a mobile number or an email — Dentally refuses to create a patient without the title, the date of birth and the funding, so ask the owner for any of them you do not have. NEVER invent or guess any detail: if a name spelling, the title, the date of birth, the funding, a contact number/email or the gender is missing, return without creating and ask the owner for it. On the first call it first searches Dentally for a likely existing patient (same mobile, same email, or same name and date of birth); if one is found it reports that record and creates nothing. Real creation only happens against the live practice system once the Dentally write key is enabled. Any Dentally error (including a key that is not permitted to create patients) is reported honestly and never retried.",
    input_schema: {
      type: "object",
      properties: {
        firstName: { type: "string", description: "The patient's first name, exactly as the owner gave it. Never invented." },
        lastName: { type: "string", description: "The patient's last name, exactly as the owner gave it. Never invented." },
        title: { type: "string", enum: ["Mr", "Mrs", "Miss", "Ms", "Master"], description: "The patient's title. Dentally requires one and also uses it to set the patient's sex when the owner has not stated it, so ask the owner rather than guessing." },
        dateOfBirth: { type: "string", description: "Date of birth as an ISO date, YYYY-MM-DD. Must be a real past date. Never guess it; ask the owner if unknown." },
        funding: { type: "string", enum: ["NHS", "Private"], description: "How this patient is to be seen at the practice. Dentally requires a payment plan on every new patient. Ask the owner; never assume one." },
        phone: { type: "string", description: "Mobile number in any common format. Required unless an email is given. Never invented." },
        email: { type: "string", description: "Email address. Required unless a mobile number is given. Never invented." },
        gender: { type: "string", enum: ["female", "male"], description: "Optional. Only set it if the owner stated it; otherwise it is taken from the title. Never guess." },
        confirm: { type: "boolean", description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to check for an existing match and read back without creating." },
      },
      required: ["firstName", "lastName", "title", "dateOfBirth", "funding"],
    },
  },
  {
    name: "list_recent_assessment_leads",
    description:
      "Who has filled in the Smile Assessment recently. Returns each person, when they submitted (with the practice's calendar day), their intent band (high, medium or low), what they said they were interested in, their answers, and whether the practice has contacted them yet. Use this for any 'who filled in the smile assessment', 'any new enquiries today', 'who came in this week', 'has anyone been in touch' question. It only covers the site or sites currently in view.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description:
            "How many of the practice's calendar days to cover, counting today as day 1. Use 1 for 'today', 2 for 'today and yesterday', 7 for 'this past week'. Defaults to 7; the maximum is 90.",
        },
        band: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Optional: only this intent band. Leave it out to get every band.",
        },
      },
    },
  },
  {
    name: "list_speed_to_lead",
    description:
      "The Leads worklist: enquiries in the speed-to-lead pipeline. For each one it returns the stage, where they came from in plain English (Smile Assessment, website form, missed call, abandoned booking, a landing page), how long they have been waiting if nobody has contacted them yet, whether first contact went out, and how many contact attempts were recorded and whether any failed. Use this for 'who has not been contacted', 'what leads are open', 'did anyone abandon a booking', 'is anything stuck'. It only covers the site or sites currently in view. Each lead's id is returned so you can nudge one with nudge_lead.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["open", "all"],
          description:
            "'open' (the default) returns only enquiries still live: waiting for first contact, being contacted, contacted, or being qualified. 'all' also includes leads that are booked, closed as lost, or have finished their nurture sequence.",
        },
        days: {
          type: "number",
          description:
            "Optional: only leads that arrived within this many of the practice's calendar days, counting today as day 1. Leave it out to see every open lead however old, which is usually what the owner wants. The maximum is 90.",
        },
        limit: {
          type: "number",
          description: "How many leads to return, newest first (1 to 100; defaults to 50).",
        },
      },
    },
  },
  {
    name: "assessment_dropoff_summary",
    description:
      "Where people give up on a Smile Assessment funnel: the per-step drop-off for ONE assessment campaign. Give the assessment's URL slug (the last part of its public link, e.g. 'invisalign-2026'); if the owner names it another way, ask them for the link or the slug rather than guessing. Returns, for each screen in order, how many people reached it, what share of the previous screen was lost there, and the overall completion rate, with the screens' own question wording when it is available. Use this for 'where are people dropping off', 'why is my assessment not converting', 'how is the funnel doing'.",
    input_schema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "The assessment's URL slug, exactly as it appears in its public link." },
        days: { type: "number", description: "How many days of history to include. Defaults to 30; the maximum is 365." },
        flowVersion: {
          type: "number",
          description:
            "Optional: an older version of the funnel, to compare against the current one. Leave it out for the version that is live now.",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "nudge_lead",
    description:
      "Re-send first contact to an open lead who has gone quiet, using the practice's normal first-contact message. This is exactly the 'Resend' action on the Leads worklist: it does not write anything new, it re-fires the existing pipeline, which drafts the message and applies the practice's consent, opt-out and delivery rules. TWO STEPS, exactly like send_sms: call first WITHOUT confirm to read the lead back (who they are, where they came from, their stage, how long they have waited, what has already been tried) while sending nothing; then, ONLY after the owner clearly says yes in a later reply, call again with confirm true. It refuses a lead who is already booked or was closed as lost, a lead who never consented to be contacted, a lead with no number or email on file, a lead outside the site currently in view, and it refuses when the Speed-to-lead system is switched off. Get the lead's id from list_speed_to_lead; never invent one.",
    input_schema: {
      type: "object",
      properties: {
        leadId: { type: "string", description: "The id of the lead to nudge, from list_speed_to_lead." },
        confirm: {
          type: "boolean",
          description: "Set true ONLY after the owner has confirmed in their own reply. Omit or false to read the lead back without sending anything.",
        },
      },
      required: ["leadId"],
    },
  },
];

function patientSummary(p: PatientRecord) {
  return {
    id: p.id,
    name: p.name,
    phone: p.phone,
    site: siteName(p.siteId),
    status: p.active ? "active" : p.archivedReason ?? "inactive",
    lastVisit: p.lastVisitAt,
    recallDue: p.recallDueAt,
  };
}

interface LikelyMatch {
  id: string;
  name: string;
  dateOfBirth: string | null;
  siteId: string;
  matchedOn: string;
}

// (E2) A dedupe search that could not complete must never read as "nobody found": the
// caller has to be able to tell "genuinely no match" apart from "the search itself
// failed" so it can fail CLOSED. searchPatients() (src/lib/dentally/read.ts) swallows a
// per-site Dentally error and silently returns [] for that site, which is right for a
// display list but wrong here, so create_patient's dedupe goes straight to the raw
// per-site Dentally read (dentallyFromEnv) and lets any error propagate.
const DEDUPE_SEARCH_MAX_PAGES = 3;
const DEDUPE_SEARCH_PER_PAGE = 100;

/**
 * One site's raw Dentally patient search for a query, paged like searchPatients, but
 * NEVER swallowing a failure: a thrown error here is left to propagate to the caller.
 */
async function rawPatientSearch(siteId: string, query: string): Promise<PatientRecord[]> {
  const client = dentallyFromEnv();
  const dentallyId = dentallySiteId(siteId);
  const out: PatientRecord[] = [];
  for (let page = 1; page <= DEDUPE_SEARCH_MAX_PAGES; page += 1) {
    const res = await client.listPatients({ siteId: dentallyId, query, page, perPage: DEDUPE_SEARCH_PER_PAGE });
    const rows = Array.isArray(res.patients) ? res.patients : [];
    for (const raw of rows) {
      const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      const first = typeof r.first_name === "string" ? r.first_name : "";
      const last = typeof r.last_name === "string" ? r.last_name : "";
      out.push({
        id: String(r.id ?? ""),
        name: `${first} ${last}`.trim() || "Unknown",
        email: typeof r.email_address === "string" && r.email_address ? r.email_address : null,
        phone: typeof r.mobile_phone === "string" && r.mobile_phone ? r.mobile_phone : null,
        // The site we queried, not a value parsed from the response: we already know
        // which of THIS client's sites this row came from.
        siteId,
        active: r.active !== false,
        archivedReason: null,
        // This projection exists ONLY to dedupe a create against existing records, so
        // it deliberately reads the few fields the dedupe compares and leaves the rest
        // null rather than parsing a payload nobody here looks at. Title and the two
        // recall dates join that set.
        title: null,
        recallDueAt: null,
        dentistRecallAt: null,
        hygienistRecallAt: null,
        lastVisitAt: null,
        dateOfBirth: typeof r.date_of_birth === "string" && r.date_of_birth ? r.date_of_birth : null,
        gender: null,
        smsConsent: false,
        emailConsent: false,
        // Part of the "rest, left null" set above: this dedupe projection does not
        // read Dentally's medical_alert, so false/null here is not a claim about it.
        medicalAlert: false,
        medicalAlertText: null,
        // Read from the row rather than defaulted: this IS a real Dentally patient
        // payload, and a hard-coded null here would report "no plan on file" for a
        // patient who has one.
        paymentPlanId: readPlanId(r),
      });
    }
    if (rows.length < DEDUPE_SEARCH_PER_PAGE) break; // short page => last page for this site
  }
  return out;
}

/**
 * DEDUPE for create_patient. Searches EVERY site passed in (E3: the caller supplies
 * every site belonging to the client, not just the one currently in view, so a patient
 * already registered at a sister site is found), fanned out over the phone, the email
 * and the name, then applies a STRICT match test so a broad text hit never wrongly
 * blocks a genuinely new patient:
 *   - exact mobile (normalised both sides; Dentally stores national format), OR
 *   - exact email (normalised both sides), OR
 *   - identical full name AND identical date of birth.
 * Returns { ok: false } (E2: fail CLOSED) the moment any site's search fails, without
 * reporting a match either way, so the caller refuses to create rather than risk a
 * duplicate. Returns { ok: true, match } (possibly null) only once every site has been
 * searched successfully.
 */
async function findLikelyExistingPatient(
  siteIds: string[],
  cand: { name: string; dob: string; phone: string | null; email: string | null },
): Promise<{ ok: true; match: LikelyMatch | null } | { ok: false }> {
  const seen = new Map<string, PatientRecord>();
  const queries: string[] = [];
  if (cand.phone) queries.push(cand.phone);
  if (cand.email) queries.push(cand.email);
  queries.push(cand.name);
  for (const siteId of siteIds) {
    for (const q of queries) {
      // Dentally's query search is inert under 2 chars; mirrors searchPatients.
      if (q.trim().length < 2) continue;
      try {
        const rows = await rawPatientSearch(siteId, q);
        for (const r of rows) seen.set(r.id, r);
      } catch (err) {
        console.error(`[copilot] create_patient dedupe search failed for site ${siteId}`, err);
        return { ok: false };
      }
    }
  }
  const nameLc = cand.name.toLowerCase();
  for (const p of seen.values()) {
    if (cand.phone && p.phone && toE164(p.phone) === cand.phone) {
      return { ok: true, match: { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same mobile number" } };
    }
    if (cand.email && p.email && normaliseEmail(p.email) === cand.email) {
      return { ok: true, match: { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same email address" } };
    }
    if (p.name.toLowerCase() === nameLc && p.dateOfBirth && p.dateOfBirth.slice(0, 10) === cand.dob) {
      return { ok: true, match: { id: p.id, name: p.name, dateOfBirth: p.dateOfBirth, siteId: p.siteId, matchedOn: "the same name and date of birth" } };
    }
  }
  return { ok: true, match: null };
}

export function makeCopilotDispatch(siteIds: string[], clientId: string, actor = "owner") {
  return async function dispatch(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case "search_patients": {
          const q = String(input.query ?? "").trim();
          // Server-side search (Dentally `query=`), never a full-book scan: the scan is
          // bounded to ~10k rows/site, so a patient past that would be invisible to the
          // owner co-pilot. An empty query returns a bounded first-page sample.
          const matches = q.length >= 2 ? await searchPatients(siteIds, q) : await listPatients(siteIds, { maxPages: 3 });
          return JSON.stringify({ count: matches.length, patients: matches.slice(0, 25).map(patientSummary) });
        }

        case "patient_record": {
          const q = String(input.query ?? "").trim();
          // Server-side search so a patient who sorts past the ~10k full-scan bound is
          // still found (otherwise the co-pilot wrongly reports they do not exist).
          const matches = await searchPatients(siteIds, q);
          if (matches.length === 0) return JSON.stringify({ found: false, message: "No patient matches that." });
          if (matches.length > 1) {
            return JSON.stringify({ multiple: true, matches: matches.slice(0, 10).map(patientSummary) });
          }
          const p = matches[0];
          const detail = await getPatientDetail(p.id, p.siteId);
          return JSON.stringify({
            found: true,
            patient: {
              ...patientSummary(p),
              email: p.email,
              dateOfBirth: p.dateOfBirth,
              gender: p.gender,
              smsConsent: p.smsConsent,
              emailConsent: p.emailConsent,
            },
            lifetimeSpend: detail.lifetimeSpend,
            notes: detail.notes,
            treatmentPlans: detail.plans,
            // getPatientDetail now opts INTO cancelled and did-not-attend rows and
            // PAGES the read (it was a single unpaged 100-row call that excluded
            // both). Two knock-ons, handled here rather than assumed away:
            //   - the co-pilot can now see and reason about a patient's DNAs and
            //     cancellations, which is the point of the change; each row already
            //     carries `state`, so it can tell them from attended visits.
            //   - a long-standing patient can now return many hundreds of rows, so
            //     the history is bounded before it reaches the model and the true
            //     count is stated rather than silently truncated.
            appointmentHistoryCount: detail.appointments.length,
            appointmentHistory: detail.appointments.slice(0, 40), // newest first
            // So a failed Dentally read is never reported to the user as "none".
            reads: detail.reads,
          });
        }

        case "appointments": {
          const date = typeof input.date === "string" && input.date ? input.date : todayIso();
          const appts = await listAppointments(siteIds, { from: date, to: date });
          return JSON.stringify({
            date,
            count: appts.length,
            appointments: appts.map((a) => ({
              time: a.start,
              durationMin: a.durationMin,
              patient: a.patientName,
              reason: a.reason,
              practitioner: a.practitioner,
              site: siteName(a.siteId),
              state: a.state,
            })),
          });
        }

        case "outstanding_balances": {
          const rows = await listOutstanding(siteIds);
          const total = rows.reduce((s, r) => s + r.outstanding, 0);
          return JSON.stringify({
            totalOutstanding: total,
            count: rows.length,
            plans: rows.slice(0, 25).map((r) => ({
              patient: r.patientName,
              plan: r.planName,
              outstanding: r.outstanding,
              planned: r.planned,
              site: siteName(r.siteId),
            })),
          });
        }

        case "practice_overview": {
          const [patients, today, outstanding, targets, opportunities, agent] = await Promise.all([
            listPatients(siteIds),
            listAppointments(siteIds, { from: todayIso(), to: todayIso() }),
            listOutstanding(siteIds),
            listTargets({ siteIds }).catch(() => []),
            listOpportunities({ siteIds }).catch(() => []),
            getAgentAnalytics(siteIds).catch(() => ({ total: 0, active: 0, booked: 0, needsHuman: 0 })),
          ]);
          const dormant = targets.filter((t) => t.status === "dormant" || t.status === "in_cadence");
          const openOpps = opportunities.filter((o) => o.status !== "completed");
          return JSON.stringify({
            today: todayIso(),
            patients: { total: patients.length, active: patients.filter((p) => p.active).length },
            appointmentsToday: today.length,
            outstanding: { total: outstanding.reduce((s, r) => s + r.outstanding, 0), plans: outstanding.length },
            reactivation: {
              dormantPatients: dormant.length,
              recoverableValue: dormant.reduce((s, t) => s + t.recoverableValue, 0),
            },
            treatmentRecovery: {
              openPlans: openOpps.length,
              recoverableValue: openOpps.reduce((s, o) => s + o.amountOutstanding, 0),
            },
            bookingAgent: agent,
          });
        }

        case "search_knowledge": {
          const q = String(input.query ?? "").trim();
          // Owner co-pilot has full clearance (tier 4); employee scoping is handled later.
          const results = await searchKnowledge(clientId, q, 4);
          return JSON.stringify({
            count: results.length,
            knowledge: results.map((r) => ({
              id: r.node.id,
              title: r.node.title,
              snippet: r.snippet,
              body: r.node.body,
              tier: r.node.tier,
              tags: r.node.tags,
            })),
          });
        }

        case "send_sms":
        case "send_email": {
          const channel: MessageChannel = name === "send_sms" ? "sms" : "email";
          const q = String(input.patient ?? "").trim();
          const message = String(input.message ?? "").trim();
          const subject = String(input.subject ?? "").trim();
          if (!q || !message) {
            return JSON.stringify({ sent: false, error: "Need a patient and a message." });
          }
          if (channel === "email" && !subject) {
            return JSON.stringify({ sent: false, error: "An email needs a subject." });
          }

          // Resolve the recipient by server-side search, not a truncatable full scan:
          // a real patient past the ~10k scan bound must never read as "no patient
          // matches" (which would silently drop an owner-directed send).
          const matches = await searchPatients(siteIds, q);
          if (matches.length === 0) return JSON.stringify({ sent: false, error: "No patient matches that." });
          if (matches.length > 1) {
            return JSON.stringify({
              sent: false,
              multiple: true,
              matches: matches.slice(0, 10).map(patientSummary),
              note: "Several patients match. Ask the owner which one before sending.",
            });
          }

          const p = matches[0];
          const targetRef = `patient:${p.id}`;
          const audit = {
            clientId,
            siteId: p.siteId,
            actor,
            action: name,
            targetRef,
            targetName: p.name,
            channel,
            // Capture the subject too, so the audit row reflects exactly what was sent.
            body: channel === "email" ? `Subject: ${subject}\n\n${message}` : message,
          };

          const consented = channel === "sms" ? p.smsConsent : p.emailConsent;
          if (!consented) {
            await logCopilotAction({ ...audit, status: "blocked:no_consent" });
            return JSON.stringify({ sent: false, reason: "no_consent", message: `${p.name} has not consented to ${channel}, so nothing was sent.` });
          }

          const to = channel === "sms" ? p.phone : p.email;
          if (!to) {
            await logCopilotAction({ ...audit, status: "blocked:no_destination" });
            return JSON.stringify({ sent: false, reason: "no_destination", message: `${p.name} has no ${channel === "sms" ? "mobile number" : "email"} on file.` });
          }

          // The co-pilot dispatches directly (not via the shared drain), so it must
          // honour BOTH suppression forms itself: patient:<id> AND the raw address
          // (a STOP from a number we could not identify is recorded by address).
          if (
            (await isSuppressed(p.siteId, channel, targetRef)) ||
            (await isSuppressed(p.siteId, channel, to))
          ) {
            await logCopilotAction({ ...audit, status: "blocked:suppressed" });
            return JSON.stringify({ sent: false, reason: "opted_out", message: `${p.name} has opted out of ${channel}, so nothing was sent.` });
          }

          // Deterministic output guardrail, identical to the drain and every other
          // patient-facing path: never let funding/NHS-private jargon or clinical
          // advice reach a patient, even from an owner-directed co-pilot send. Price
          // is allowed (the owner may legitimately quote a figure). A hit blocks the
          // send at preview AND confirm, and tells the owner why so they can reword.
          const guard = checkAgentReply(message, { includePrice: false });
          if (!guard.ok) {
            await logCopilotAction({ ...audit, status: "blocked:guardrail" });
            return JSON.stringify({
              sent: false,
              reason: "guardrail",
              matched: guard.matched,
              message: `That message can't go out as written: it contains ${guard.category} wording we never send to patients. Please reword it.`,
            });
          }

          // Cross-module one-per-patient-per-day ledger. The co-pilot dispatches directly
          // (not via the shared drain), so, like the drain, it must key on the CANONICAL
          // address (E.164 / lowercased email) so the co-pilot and the automated modules
          // stamp/read the SAME row for one handset. Falls back to the raw destination if
          // normalisation fails (implausible number), so a send is still recorded.
          const today = londonDayKey(new Date());
          const ledgerAddress = (channel === "sms" ? toE164(to) : normaliseEmail(to)) ?? to;
          const alreadyContactedToday = await wasContactedToday(p.siteId, ledgerAddress, today);

          // Two-step gate: without an explicit confirm this is a PREVIEW only. It
          // has verified the patient and consent but sends nothing. The owner must
          // confirm before a real send (this is enforced here, not just in the
          // prompt, so a model that skips the confirmation cannot dispatch). Surface an
          // already-contacted-today state here too, so the owner sees the stacking risk
          // in the read-back rather than being surprised at confirm.
          if (input.confirm !== true) {
            return JSON.stringify({
              sent: false,
              preview: true,
              patient: p.name,
              channel,
              ...(channel === "email" ? { subject } : {}),
              message,
              alreadyContactedToday,
              note:
                (alreadyContactedToday
                  ? `Heads up: ${p.name} has already had a message today, and the platform sends at most one a day. Sending this would be a second. Only proceed if the owner explicitly wants to override that; if they do, call ${name} again with confirm true AND override true. `
                  : "") +
                `Ready to send to ${p.name} (consent is in place, nothing sent yet). Show this to the owner and, only once they confirm, call ${name} again with confirm true.`,
            });
          }

          // Confirmed. The one-per-day cap is a fatigue guard, not a safety gate, so a
          // human-confirmed owner send MAY override it (mirroring how the Inbox human
          // takeover bypasses the module kill switches), but only as a DELIBERATE,
          // surfaced choice. Without an explicit override, a patient already contacted
          // today is NOT silently stacked on top of an automated same-day send.
          if (alreadyContactedToday && input.override !== true) {
            await logCopilotAction({ ...audit, status: "blocked:already_contacted_today" });
            return JSON.stringify({
              sent: false,
              reason: "already_contacted_today",
              requiresOverride: true,
              patient: p.name,
              channel,
              message: `${p.name} has already been sent a message today. Across the whole platform a patient gets at most one message a day, so I have not sent a second. If you definitely want to text them again anyway, tell me to override and I will send it just this once.`,
            });
          }

          const result = await sendMessage({
            channel,
            to,
            body: message,
            subject: channel === "email" ? subject : undefined,
          });
          const dryRun = result.provider === "dry-run";
          await logCopilotAction({ ...audit, status: dryRun ? "dry_run" : result.status });
          // Stamp the cross-module daily ledger so the automated systems (recall,
          // reactivation, no-show, outreach, nurture, all draining through the shared
          // drain) treat this patient as contacted today and do not add a second message.
          // Best-effort, exactly like the drain: a ledger-write failure never unsends the
          // message that already went out. Recorded even in dry-run so the cap is honoured
          // during the supervised test phase, matching the drain.
          await recordContacted(p.siteId, ledgerAddress, today, "copilot");
          return JSON.stringify({
            sent: true,
            patient: p.name,
            channel,
            dryRun,
            ...(alreadyContactedToday ? { overrode: true } : {}),
            status: result.status,
            note:
              (alreadyContactedToday
                ? "This is a deliberate second message today (you asked me to override the one-a-day limit). "
                : "") +
              (dryRun
                ? "Recorded in test mode (dry run); it was not delivered to the patient. It will go out for real once the practice switches messaging live."
                : "Sent."),
          });
        }

        case "create_outreach_campaign": {
          // messageAngle is OPTIONAL here: an owner can build a list to see how many
          // patients match without any send intent. It becomes required at launch.
          const messageAngle = String(input.messageAngle ?? "").trim() || null;
          // Optional SECOND angle turns this into a two-message A/B test. Only honoured
          // alongside a primary angle (a second message needs a first); ignored otherwise.
          const messageAngleBRaw = String(input.messageAngleB ?? "").trim() || null;
          const messageAngleB = messageAngle && messageAngleBRaw ? messageAngleBRaw : null;

          // Resolve the target site WITHIN the co-pilot's view scope (siteIds), never
          // across every client site: a campaign must not be built or launched against
          // a site outside the selected scope. An explicit in-scope site wins; otherwise
          // default to the site in view (the first scoped site). A requested site that is
          // real but out of scope is refused with a clear pointer to the site selector,
          // mirroring how the other co-pilot tools stay bounded to siteIds.
          const requestedSite = String(input.siteId ?? "").trim();
          if (requestedSite && !siteIds.includes(requestedSite)) {
            const knownButUnscoped = getSites(clientId).some((s) => s.id === requestedSite);
            return JSON.stringify({
              created: false,
              error: knownButUnscoped
                ? "That site is outside the site you have in view. Switch the site selector to it first, then create the campaign there."
                : "I could not find that site for your practice.",
            });
          }
          const siteId = requestedSite || siteIds[0];
          if (!siteId) return JSON.stringify({ created: false, error: "No site is in scope to target." });

          // Build + validate the segment from ONLY the stated fields (never invent a
          // filter the owner did not give). requiresMobile stays on: an SMS campaign
          // needs a mobile.
          const rawFilters: OutreachFilters = { requiresMobile: true };
          if (Array.isArray(input.treatmentContains)) {
            rawFilters.treatmentContains = (input.treatmentContains as unknown[]).filter(
              (x): x is string => typeof x === "string",
            );
          }
          if (typeof input.lastVisitAfter === "string" && input.lastVisitAfter.trim()) {
            rawFilters.lastVisitAfter = input.lastVisitAfter.trim();
          }
          if (typeof input.lastVisitBefore === "string" && input.lastVisitBefore.trim()) {
            rawFilters.lastVisitBefore = input.lastVisitBefore.trim();
          }
          if (typeof input.excludeSeenSinceDays === "number") {
            rawFilters.excludeSeenSinceDays = input.excludeSeenSinceDays;
          }
          if (typeof input.ageMin === "number") rawFilters.ageMin = input.ageMin;
          if (typeof input.ageMax === "number") rawFilters.ageMax = input.ageMax;
          if (typeof input.gender === "string" && input.gender.trim()) {
            rawFilters.gender = input.gender.trim().toLowerCase() as OutreachFilters["gender"];
          }
          const filtersParse = parseFilters(rawFilters);
          if (!filtersParse.ok) return JSON.stringify({ created: false, error: filtersParse.error });

          const capParse = parseDailyCap(input.dailyCap);
          if (!capParse.ok) return JSON.stringify({ created: false, error: capParse.error });

          // Optional clinician: match the stated name to a real practitioner for the
          // site so the booking agent can target their diary; keep the display name
          // regardless of whether an id was found.
          const practitionerName = String(input.practitionerName ?? "").trim() || null;
          let practitionerId: string | null = null;
          if (practitionerName) {
            try {
              const pracs = await listSitePractitioners(siteId);
              const needle = practitionerName.toLowerCase();
              const hit = pracs.find(
                (p) => p.name.toLowerCase().includes(needle) || needle.includes(p.name.toLowerCase()),
              );
              practitionerId = hit?.id ?? null;
            } catch {
              // Best-effort: leave the id null; the invite still names the clinician.
            }
          }

          const name = (
            String(input.name ?? "").trim() ||
            (messageAngle ? `${messageAngle} invite` : "Patient list")
          ).slice(0, 80);
          const campaign = await createCampaign({
            clientId,
            siteId,
            name,
            filters: filtersParse.filters,
            practitionerId,
            practitionerName,
            messageAngle: messageAngle ? messageAngle.slice(0, 120) : null,
            messageAngleB: messageAngleB ? messageAngleB.slice(0, 120) : null,
            dailyCap: capParse.dailyCap,
            createdBy: actor,
          });

          await logCopilotAction({
            clientId,
            siteId,
            actor,
            action: "create_outreach_campaign",
            targetRef: `campaign:${campaign.id}`,
            targetName: campaign.name,
            channel: null,
            body: describeSegment(campaign.filters),
            status: "created",
          });

          // Kick ONE bounded build tick (the same machinery the builder route runs). A
          // large base finishes over several ticks; report 'building' so the owner knows
          // the count will climb, or 'ready' if it completed in one pass. NEVER launches.
          let matched = 0;
          let contactable = 0;
          let contactableKnown = false;
          let excludedMissingData = 0;
          let buildStatus: "ready" | "building" | "paused" | "unavailable" = "building";
          let pauseReason: "rate-limit" | "error" | null = null;
          if (!dentallyReadKey()) {
            buildStatus = "unavailable";
          } else {
            const tick = await runOutreachBuildTick(campaign);
            matched = tick.counts.matched ?? 0;
            if (typeof tick.counts.contactable === "number") {
              contactable = tick.counts.contactable;
              contactableKnown = true;
            }
            excludedMissingData = tick.counts.excludedMissingData ?? 0;
            // Report honestly. A Dentally 403/429 stop (tick.stopped) or a failed tick
            // (!tick.ok) means the scan PAUSED before finishing: the cursor is preserved
            // and it resumes where it left off, so we must NOT tell the owner the count
            // is currently climbing. Only a clean, still-running tick keeps 'building'.
            if (tick.stopped) {
              buildStatus = "paused";
              pauseReason = "rate-limit";
            } else if (!tick.ok) {
              buildStatus = "paused";
              pauseReason = "error";
            } else {
              buildStatus = tick.done ? "ready" : "building";
            }
          }

          const usesDemographics =
            campaign.filters.gender !== undefined ||
            campaign.filters.ageMin !== undefined ||
            campaign.filters.ageMax !== undefined;

          return JSON.stringify({
            created: true,
            launched: false,
            listPreview: !messageAngle, // no send angle yet: this is a list, not a send
            campaignId: campaign.id,
            name: campaign.name,
            site: siteName(siteId),
            segment: describeSegment(campaign.filters),
            messageAngle: campaign.messageAngle,
            // Present only for a two-message test, so the read-back can name both angles.
            ...(campaign.messageAngleB ? { messageAngleB: campaign.messageAngleB, abTest: true } : {}),
            practitioner: practitionerName,
            dailyCap: campaign.dailyCap,
            matchedSoFar: matched,
            // Honesty: matching a patient is not the same as reaching them. Consent is
            // applied at send time, so surface how many of the matches actually have SMS
            // consent (contactable) and are the real reachable audience.
            ...(contactableKnown ? { contactableSoFar: contactable } : {}),
            // Honesty: how many records were dropped for missing age/gender when those
            // filters are in play, so the read-back can state it.
            ...(usesDemographics ? { excludedForMissingAgeOrGender: excludedMissingData } : {}),
            buildStatus,
            note:
              (buildStatus === "ready"
                ? "The segment is fully built. Read the segment and matched count back to the owner. "
                : buildStatus === "unavailable"
                  ? "The list is saved but the patient scan could not run here. "
                  : buildStatus === "paused"
                    ? pauseReason === "rate-limit"
                      ? "The patient scan paused on a Dentally rate limit before it finished. The matched count so far is saved and the scan resumes from where it left off when the build next runs. Tell the owner it paused and will continue automatically, not that the count is rising right now. "
                      : "The patient scan hit a temporary problem before it finished. The matched count so far is saved and the scan resumes from where it left off when the build next runs. "
                    : "The build is still running; the matched count will keep climbing, so tell the owner it updates shortly. ") +
              (contactableKnown && contactable < matched
                ? `Of the ${matched} matched, ${contactable} have SMS consent and can be contacted; the rest are counted but are not texted (no SMS consent). `
                : "") +
              (usesDemographics && excludedMissingData > 0
                ? `${excludedMissingData} record(s) had no recorded age or gender on file and were not included. `
                : "") +
              (campaign.messageAngleB
                ? "This is a two-message test: patients are split evenly between the two angles and each patient always gets the same one. Once it is live, the campaign reports how many were sent, replied and booked for each message, so the owner can see which converts. This is honest counting only, not automatic optimisation. "
                : "") +
              (messageAngle
                ? "Nothing has been launched; to go live, use launch_outreach_campaign after the owner confirms."
                : "This is a patient list only (no message angle set), so nothing can be sent yet; the owner can add an angle and launch later."),
          });
        }

        case "launch_outreach_campaign": {
          const campaignId = String(input.campaignId ?? "").trim();
          if (!campaignId) return JSON.stringify({ launched: false, error: "I need the campaign id to launch." });
          const campaign = await getCampaign(campaignId);
          if (!campaign) return JSON.stringify({ launched: false, error: "No campaign matches that id." });
          // IDOR guard: the co-pilot only ever acts on THIS client's campaigns.
          if (campaign.clientId !== clientId) {
            return JSON.stringify({ launched: false, error: "That campaign belongs to another practice." });
          }

          const counts = await campaignStatusCounts(campaign.id).catch(() => ({
            built: 0,
            contacted: 0,
            replied: 0,
            booked: 0,
          }));
          // Contactable = matched targets WITH SMS consent (from the build). Matching a
          // patient is not reaching them: consent is applied at send time, so surface the
          // reachable reality rather than letting 'matched' read as 'will be texted'.
          const contactable =
            typeof campaign.counts?.contactable === "number" ? campaign.counts.contactable : null;
          // Two-message A/B: read back both angles and the honest per-message counts
          // (assigned/sent/replied/booked). Counting only, never a claim of learning.
          const variantBreakdown =
            campaign.messageAngleB && campaign.messageAngleB.trim()
              ? await campaignVariantCounts(campaign.id).catch(() => null)
              : null;
          const readback = {
            campaignId: campaign.id,
            name: campaign.name,
            segment: describeSegment(campaign.filters),
            matched: counts.built,
            ...(contactable !== null ? { contactable } : {}),
            practitioner: campaign.practitionerName,
            dailyCap: campaign.dailyCap,
            status: campaign.status,
            messageAngle: campaign.messageAngle,
            ...(campaign.messageAngleB ? { messageAngleB: campaign.messageAngleB } : {}),
            ...(variantBreakdown
              ? {
                  messagePerformance: {
                    note: "Honest per-message counts, not automatic optimisation.",
                    messageA: { angle: campaign.messageAngle, ...variantBreakdown.a },
                    messageB: { angle: campaign.messageAngleB, ...variantBreakdown.b },
                  },
                }
              : {}),
          };
          const consentCaveat =
            contactable !== null && contactable < counts.built
              ? ` Of the ${counts.built} matched, ${contactable} have SMS consent and will be contacted; the rest are not texted.`
              : "";
          const abCaveat = campaign.messageAngleB
            ? " This campaign tests two messages: patients are split evenly and each always gets the same one; results are reported per message as plain counts."
            : "";

          // Two-step gate, identical to send_sms: without an explicit confirm this is a
          // READ-BACK only, nothing is launched. The prompt forbids setting confirm true
          // in the same turn as the request; this gate makes a missing confirm inert
          // regardless, so a model that skips the read-back cannot launch.
          if (input.confirm !== true) {
            return JSON.stringify({
              launched: false,
              preview: true,
              ...readback,
              note: `Read this back to the owner (segment, matched count, clinician, daily cap${campaign.messageAngleB ? ", and both message angles" : ""}).${consentCaveat}${abCaveat} Nothing launched yet. Only once they confirm, call launch_outreach_campaign again with confirm true.`,
            });
          }

          // Confirmed: a campaign can only go live once fully built...
          if (campaign.status !== "ready") {
            return JSON.stringify({
              launched: false,
              ...readback,
              reason: "not_ready",
              message:
                campaign.status === "running"
                  ? "That campaign is already running."
                  : `That campaign is ${campaign.status}, so it is not ready to launch yet. It needs to finish building first.`,
            });
          }
          // ...must have a message angle (what the invite is about) before it can send...
          if (!campaign.messageAngle || !campaign.messageAngle.trim()) {
            return JSON.stringify({
              launched: false,
              ...readback,
              reason: "no_angle",
              message:
                "This is a patient list with no message angle yet, so I can't launch it. Tell me what the invite should be about first.",
            });
          }
          // ...and never while the Segment outreach system is switched off.
          if (!(await isSystemEnabled(clientId, "outreach"))) {
            await logCopilotAction({
              clientId,
              siteId: campaign.siteId,
              actor,
              action: "launch_outreach_campaign",
              targetRef: `campaign:${campaign.id}`,
              targetName: campaign.name,
              channel: null,
              body: null,
              status: "blocked:outreach_off",
            });
            return JSON.stringify({
              launched: false,
              ...readback,
              reason: "outreach_off",
              message:
                "Segment outreach is switched off, so I can't launch it. Switch it on in Operations, System controls, then ask me again.",
            });
          }

          await updateCampaign(campaign.id, { status: "running" });
          await logCopilotAction({
            clientId,
            siteId: campaign.siteId,
            actor,
            action: "launch_outreach_campaign",
            targetRef: `campaign:${campaign.id}`,
            targetName: campaign.name,
            channel: null,
            body: null,
            status: "launched",
          });
          return JSON.stringify({
            launched: true,
            ...readback,
            status: "running",
            note: `${campaign.name} is now live. It will contact up to ${campaign.dailyCap} patients a day, honouring consent, opt-outs and the one-message-per-patient-per-day cap.`,
          });
        }

        case "create_landing_page": {
          // WRAP the exact machinery the Landing pages tab uses (POST /api/landing-pages):
          // generate BOTH variants -> validateContent -> the deterministic compliance lint
          // (invented prices/testimonials/awards already rejected there; real prices come
          // from the catalogue) -> persist a DRAFT page + its two variants. We do NOT
          // reimplement or duplicate any of that; only the model call is provided here,
          // identical to the route (Sonnet, thinking disabled per house rule).
          const treatmentInput = String(input.treatment ?? "").trim();
          if (!treatmentInput) return JSON.stringify({ created: false, error: "I need a treatment for the landing page." });
          const treatment = TREATMENTS.find((t) => t.key === treatmentInput) ?? findTreatment(treatmentInput);
          if (!treatment) {
            return JSON.stringify({
              created: false,
              error: `I could not match "${treatmentInput}" to a treatment in the catalogue. Tell me which treatment the page is for.`,
            });
          }

          const ctaRaw = String(input.ctaTarget ?? "").trim().toLowerCase();
          const ctaTarget: CtaTarget = ctaRaw === "booking" ? "booking" : "assessment";
          const angle = String(input.angle ?? "").trim() || undefined;

          const client = getClient(clientId);
          if (!client) return JSON.stringify({ created: false, error: "I could not resolve your practice." });
          // View-scoped site: the page belongs to the site currently in view (the first
          // scoped site), never across every client site, mirroring create_outreach_campaign.
          const siteId = siteIds[0] ?? null;

          const anthropic = new Anthropic({ maxRetries: 1 });
          const callModel: CallModel = async (system, user) => {
            const msg = await anthropic.messages.create(
              { model: SONNET, thinking: NO_THINKING, max_tokens: 1500, system, messages: [{ role: "user", content: user }] },
              { timeout: 25000 },
            );
            return msg.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("");
          };

          let variants;
          try {
            variants = await generateBothVariants({
              treatment,
              practiceName: client.name,
              ctaTarget,
              ctaTargetSlug: null,
              angle,
              callModel,
            });
          } catch {
            return JSON.stringify({ created: false, error: "I could not generate the landing page just now. Please try again." });
          }

          // Persist as a DRAFT, retrying a fresh slug suffix on the rare collision
          // (mirrors the route's 3-attempt loop). insertPageWithVariants forces status draft.
          let stored: Awaited<ReturnType<typeof insertPageWithVariants>> | null = null;
          for (let attempt = 0; attempt < 3 && !stored; attempt++) {
            try {
              stored = await insertPageWithVariants({
                clientId,
                siteId,
                slug: deriveSlug(treatment.name),
                treatment: treatment.key,
                campaignRef: null,
                autoPromote: true,
                createdBy: actor,
                variantA: variants.a.content,
                variantB: variants.b.content,
              });
            } catch (e) {
              if (e instanceof SlugTakenError) continue; // collision, try a new suffix
              return JSON.stringify({ created: false, error: "I could not save the landing page just now." });
            }
          }
          if (!stored) return JSON.stringify({ created: false, error: "I could not allocate a unique URL for the page. Please try again." });

          await logCopilotAction({
            clientId,
            siteId,
            actor,
            action: "create_landing_page",
            targetRef: `landing:${stored.page.id}`,
            targetName: stored.page.slug,
            channel: null,
            body: `${treatment.name} landing page (draft), CTA to ${ctaTarget}`,
            status: "created",
          });

          // Preview links: a DRAFT is only servable with a valid preview token, and the
          // /go route honours ?v=a|b to show each variant. The token is null when no
          // server key is configured, in which case the draft cannot be previewed until
          // it is published.
          const token = mintPreviewToken(stored.page.id);
          const base = `/go/${client.slug}/${stored.page.slug}`;
          const previewLinks = token
            ? { a: `${base}?preview=${token}&v=a`, b: `${base}?preview=${token}&v=b` }
            : null;

          const summarise = (c: LandingPageContent) =>
            `${c.hero.headline}: ${c.hero.subhead}`.replace(/\s+/g, " ").slice(0, 160);

          return JSON.stringify({
            created: true,
            published: false,
            status: "draft",
            pageId: stored.page.id,
            slug: stored.page.slug,
            treatment: treatment.name,
            ctaTarget,
            site: siteId ? siteName(siteId) : null,
            previewLinks,
            variants: { a: summarise(variants.a.content), b: summarise(variants.b.content) },
            note:
              (token
                ? "The page is saved as a DRAFT with two A/B variants. Give the owner both preview links so they can see each variant. "
                : "The page is saved as a DRAFT with two A/B variants. A live preview link needs the preview key configured, so show the owner the two variant summaries for now. ") +
              "Nothing is public yet. To publish it live, use launch_landing_page after the owner confirms.",
          });
        }

        case "launch_landing_page": {
          const pageId = String(input.pageId ?? "").trim();
          if (!pageId) return JSON.stringify({ published: false, error: "I need the landing page id to publish it." });
          // IDOR: getPageById scopes to THIS client, so another practice's page reads as
          // not found.
          const found = await getPageById(pageId, clientId);
          if (!found) return JSON.stringify({ published: false, error: "No landing page of yours matches that id." });
          // View-scope guard: never publish a page for a site outside the current view
          // selection (mirrors the outreach scope discipline).
          if (found.page.siteId && !siteIds.includes(found.page.siteId)) {
            return JSON.stringify({
              published: false,
              error: "That page belongs to a site outside the one you have in view. Switch the site selector to it first, then publish.",
            });
          }

          const client = getClient(clientId);
          const clientSlug = client?.slug ?? clientId;
          const publicUrl = `/go/${clientSlug}/${found.page.slug}`;
          const readback = {
            pageId: found.page.id,
            slug: found.page.slug,
            treatment: found.page.treatment,
            status: found.page.status,
            url: publicUrl,
          };

          // Two-step gate, identical to launch_outreach_campaign. The deterministic run.ts
          // commit gate (launch_landing_page is in CONFIRM_COMMIT_TOOLS) ALSO makes a
          // same-turn confirm inert; this per-tool preview is belt-and-braces.
          if (input.confirm !== true) {
            return JSON.stringify({
              published: false,
              preview: true,
              ...readback,
              note: `This will publish the ${found.page.treatment} landing page live at ${publicUrl}, visible to anyone with the link. Read that back to the owner. Nothing is live yet. Only once they clearly say yes, call launch_landing_page again with confirm true.`,
            });
          }

          if (found.page.status === "live") {
            return JSON.stringify({ published: false, ...readback, reason: "already_live", message: "That page is already live." });
          }
          if (found.page.status === "archived") {
            return JSON.stringify({
              published: false,
              ...readback,
              reason: "archived",
              message: "That page is archived, so I have not published it. Create a fresh page if you want to run it again.",
            });
          }

          await setPageStatus(found.page.id, clientId, "live");
          await logCopilotAction({
            clientId,
            siteId: found.page.siteId,
            actor,
            action: "launch_landing_page",
            targetRef: `landing:${found.page.id}`,
            targetName: found.page.slug,
            channel: null,
            body: null,
            status: "published",
          });
          return JSON.stringify({
            published: true,
            ...readback,
            status: "live",
            note: `The ${found.page.treatment} landing page is now live at ${publicUrl}. It serves an even A/B split until a winner is promoted.`,
          });
        }

        case "create_meta_campaign": {
          const treatmentInput = String(input.treatment ?? "").trim();
          if (!treatmentInput) return JSON.stringify({ created: false, error: "I need the treatment or focus for the campaign." });
          // A Meta campaign focus may be a catalogue treatment OR a free-text focus (e.g.
          // "new patients"); keep the label, and only pull a real price when it maps to a
          // catalogue treatment.
          const treatment = TREATMENTS.find((t) => t.key === treatmentInput) ?? findTreatment(treatmentInput);
          const treatmentLabel = treatment ? treatment.name : treatmentInput;

          const objectiveRaw = String(input.objective ?? "").trim().toLowerCase();
          const OBJECTIVES: readonly CampaignObjective[] = ["awareness", "leads", "traffic", "engagement", "retargeting"];
          const objective: CampaignObjective = (OBJECTIVES as readonly string[]).includes(objectiveRaw)
            ? (objectiveRaw as CampaignObjective)
            : "leads";

          const transparentPricing = input.transparentPricing === true;
          // Real price from the catalogue ONLY (never invented). Null when pricing is off
          // or the focus is not a single catalogue treatment.
          const fromPriceGbp = transparentPricing && treatment ? treatment.priceFrom : null;

          const radiusMiles = typeof input.radiusMiles === "number" && input.radiusMiles > 0 ? input.radiusMiles : null;
          const dailyBudgetGbp = typeof input.dailyBudgetGBP === "number" && input.dailyBudgetGBP > 0 ? input.dailyBudgetGBP : null;
          const audienceNotes = String(input.audienceNotes ?? "").trim() || null;
          const negativeKeywords = Array.isArray(input.negativeKeywords)
            ? (input.negativeKeywords as unknown[])
                .filter((x): x is string => typeof x === "string")
                .map((s) => s.trim())
                .filter(Boolean)
                .slice(0, 50)
            : [];

          const client = getClient(clientId);
          if (!client) return JSON.stringify({ created: false, error: "I could not resolve your practice." });
          const siteId = siteIds[0] ?? null;

          // Optionally attach a landing page created by create_landing_page (same client
          // AND within the current view scope).
          let landingSlug: string | null = null;
          let landingUrl: string | null = null;
          const attach = String(input.attachLandingSlug ?? "").trim();
          if (attach) {
            const page = await getPageBySlug(clientId, attach).catch(() => null);
            if (page && (!page.page.siteId || siteIds.includes(page.page.siteId))) {
              landingSlug = page.page.slug;
              landingUrl = `/go/${client.slug}/${page.page.slug}`;
            }
          }

          // WRAP the existing ad-copy generation: the SAME compliant prompt the Meta Ads
          // tab uses (buildCopyPrompt bakes in GDC/ASA rules), a Sonnet call (thinking
          // disabled), cleanCopy to strip dashes, then the SAME banned-word scanner the
          // landing lint uses (scanBannedText) as a deterministic compliance gate. On a
          // banned hit, regenerate once; if still non-compliant, fall back to the hand-
          // written, known-compliant template copy for the treatment.
          const offer = fromPriceGbp !== null ? `From £${fromPriceGbp}. Treatment is subject to a consultation.` : undefined;
          const { system, user } = buildCopyPrompt({ treatment: treatmentLabel, offer, angle: audienceNotes ?? undefined, practiceName: client.name });
          const anthropic = new Anthropic({ maxRetries: 1 });
          const genOnce = async (): Promise<MetaCampaignCopy | null> => {
            const msg = await anthropic.messages.create(
              { model: SONNET, thinking: NO_THINKING, max_tokens: 600, system, messages: [{ role: "user", content: user }] },
              { timeout: 25000 },
            );
            const text = msg.content
              .filter((b): b is Anthropic.TextBlock => b.type === "text")
              .map((b) => b.text)
              .join("");
            const m = text.match(/\{[\s\S]*\}/);
            if (!m) return null;
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(m[0]) as Record<string, unknown>;
            } catch {
              return null;
            }
            const copy: MetaCampaignCopy = {
              headline: cleanCopy(String(parsed.headline ?? "")),
              primaryText: cleanCopy(String(parsed.primaryText ?? "")),
              description: cleanCopy(String(parsed.description ?? "")),
              cta: cleanCopy(String(parsed.cta ?? "")),
              complianceNote: cleanCopy(String(parsed.complianceNote ?? "")),
            };
            if (!copy.headline || !copy.primaryText) return null;
            // Deterministic compliance gate, reusing the landing lint's banned-pattern
            // scanner: reject copy carrying any banned wording (testimonials, guarantees,
            // pain-free/superlative claims, funding wording, banned symbols).
            if (scanBannedText([copy.headline, copy.primaryText, copy.description, copy.cta].join("\n")).length > 0) {
              return null;
            }
            return copy;
          };

          let copy: MetaCampaignCopy | null = null;
          try {
            copy = (await genOnce()) ?? (await genOnce());
          } catch {
            copy = null;
          }
          if (!copy) {
            // Fallback to hand-written, UK-compliant template copy (guaranteed clean), so
            // we never store non-compliant or empty copy.
            const tpl =
              (treatment && CAMPAIGN_TEMPLATES.find((t) => t.treatment.toLowerCase().includes(treatment.name.toLowerCase()))) ||
              CAMPAIGN_TEMPLATES[0];
            copy = {
              headline: cleanCopy(tpl.copy.headline),
              primaryText: cleanCopy(tpl.copy.primaryText),
              description: cleanCopy(tpl.copy.description),
              cta: cleanCopy(tpl.cta),
              complianceNote: cleanCopy(tpl.complianceNote),
            };
          }

          const campaignName = `${treatmentLabel} (${objective})`.slice(0, 80);
          let campaign;
          try {
            campaign = await createMetaCampaign({
              clientId,
              siteId,
              name: campaignName,
              treatment: treatment?.key ?? treatmentLabel,
              objective,
              status: "draft",
              radiusMiles,
              dailyBudgetGbp,
              audienceNotes,
              transparentPricing,
              fromPriceGbp,
              negativeKeywords,
              landingSlug,
              copy,
              createdBy: actor,
            });
          } catch {
            return JSON.stringify({ created: false, error: "I could not save the campaign just now. Please try again." });
          }

          await logCopilotAction({
            clientId,
            siteId,
            actor,
            action: "create_meta_campaign",
            targetRef: `meta_campaign:${campaign.id}`,
            targetName: campaign.name,
            channel: null,
            body: `${treatmentLabel} / ${objective}${fromPriceGbp !== null ? ` / from £${fromPriceGbp}` : ""}`,
            status: "created",
          });

          return JSON.stringify({
            created: true,
            published: false,
            status: "ready_not_published",
            campaignId: campaign.id,
            name: campaign.name,
            objective,
            treatment: treatmentLabel,
            site: siteId ? siteName(siteId) : null,
            radiusMiles,
            dailyBudgetGBP: dailyBudgetGbp,
            audienceNotes,
            negativeKeywords,
            ...(fromPriceGbp !== null ? { fromPriceGBP: fromPriceGbp } : {}),
            ...(landingSlug ? { landingPage: landingUrl } : {}),
            adCopy: { headline: copy.headline, primaryText: copy.primaryText, description: copy.description, cta: copy.cta },
            complianceNote: copy.complianceNote,
            metaConnected: isMetaConnected(clientId),
            note:
              `The campaign is assembled and saved as a draft, READY to publish. Read the objective, radius, daily budget, audience, negative keywords and the generated headline and primary text back to the owner${fromPriceGbp !== null ? `, including the real from-price of £${fromPriceGbp} pulled from your price list` : ""}. ` +
              (attach && !landingSlug ? "I could not find that landing page to attach, so none is linked; create one first if you want a custom destination. " : "") +
              "IMPORTANT: it is NOT live. Going live needs the practice's Meta account connected in Growth, Meta Ads, and is a separate confirmed step (publish_meta_campaign). Never tell the owner it is running or live.",
          });
        }

        case "publish_meta_campaign": {
          const campaignId = String(input.campaignId ?? "").trim();
          if (!campaignId) return JSON.stringify({ published: false, error: "I need the campaign id to publish it." });
          const campaign = await getMetaCampaign(campaignId);
          if (!campaign) return JSON.stringify({ published: false, error: "No campaign matches that id." });
          // IDOR guard: only ever act on THIS client's campaigns.
          if (campaign.clientId !== clientId) {
            return JSON.stringify({ published: false, error: "That campaign belongs to another practice." });
          }
          // View-scope guard, mirroring the outreach launch discipline.
          if (campaign.siteId && !siteIds.includes(campaign.siteId)) {
            return JSON.stringify({
              published: false,
              error: "That campaign belongs to a site outside the one you have in view. Switch the site selector to it first.",
            });
          }

          const readback = {
            campaignId: campaign.id,
            name: campaign.name,
            objective: campaign.objective,
            treatment: campaign.treatment,
            dailyBudgetGBP: campaign.dailyBudgetGbp,
            status: campaign.status,
          };

          // Two-step gate (publish_meta_campaign is in CONFIRM_COMMIT_TOOLS): without an
          // explicit confirm this is a READ-BACK only.
          if (input.confirm !== true) {
            return JSON.stringify({
              published: false,
              preview: true,
              ...readback,
              note: "This would take the campaign live on Meta. Read it back to the owner. Nothing is published yet, and going live also needs the practice's Meta account connected. Only once the owner clearly says yes, call publish_meta_campaign again with confirm true.",
            });
          }

          // HONESTY GATE: publishing to Meta needs the client's Meta account connected AND
          // its credentials present. Until then this refuses and NEVER claims it went live.
          const connection = metaConnection(clientId);
          if (!connection.connected) {
            await logCopilotAction({
              clientId,
              siteId: campaign.siteId,
              actor,
              action: "publish_meta_campaign",
              targetRef: `meta_campaign:${campaign.id}`,
              targetName: campaign.name,
              channel: null,
              body: null,
              status: "blocked:meta_not_connected",
            });
            return JSON.stringify({
              published: false,
              ready: true,
              reason: "meta_not_connected",
              ...readback,
              message:
                "This campaign is ready, but I can't publish it to Meta yet: the practice's Meta account is not connected. Connect it in Growth, Meta Ads, then ask me again. Nothing has gone live.",
            });
          }

          // Connected: create the campaign, ad set, creative and ad on Meta, ALL in PAUSED
          // status (budget safety). The owner reviews and activates it in Ads Manager; the
          // platform never sets a campaign live-spending.
          const result = await publishCampaign(campaign, connection);
          await recordPublishResult(campaign.id, {
            ok: result.ok,
            metaCampaignRef: result.metaCampaignRef,
            metaAdsetRef: result.metaAdsetRef,
            metaAdRef: result.metaAdRef,
            error: result.error,
            note: result.note,
          });

          if (!result.ok) {
            // Honest failure: Meta rejected a step. Nothing is live; the campaign stays ready.
            await logCopilotAction({
              clientId,
              siteId: campaign.siteId,
              actor,
              action: "publish_meta_campaign",
              targetRef: `meta_campaign:${campaign.id}`,
              targetName: campaign.name,
              channel: null,
              body: null,
              status: "error:publish_failed",
            });
            return JSON.stringify({
              published: false,
              ready: true,
              reason: "publish_failed",
              ...readback,
              error: result.error,
              message: `I tried to publish it to Meta but got an error: ${result.error} Nothing is live, and the campaign is still ready to retry.`,
            });
          }

          await logCopilotAction({
            clientId,
            siteId: campaign.siteId,
            actor,
            action: "publish_meta_campaign",
            targetRef: `meta_campaign:${campaign.id}`,
            targetName: campaign.name,
            channel: null,
            body: null,
            status: "published:paused_on_meta",
          });
          return JSON.stringify({
            published: true,
            ...readback,
            status: "paused_on_meta",
            metaCampaignRef: result.metaCampaignRef,
            notes: result.notes,
            message:
              "Created on Meta in PAUSED status. Tell the owner to review and activate it in Meta Ads Manager, and that nothing is spending until they do." +
              (result.notes.length > 0 ? ` Also read these honestly to the owner: ${result.notes.join(" ")}` : ""),
          });
        }

        case "create_patient": {
          // A HIGH-STAKES write: this creates a real person in the practice's real
          // Dentally book (51k+ real patients). Mirrors send_sms's discipline, strict
          // validation, a dedupe short-circuit, a two-step confirm, audit logging and an
          // honest error read-back, and the booking-create write posture (the gated
          // dentallyAgentClient + internal->Dentally site mapping).

          // (0) THE WRITE GATE, FIRST, BEFORE ANY VALIDATION OR NETWORK CALL. Every
          // appointment route in this codebase (booking/create, coordinator, reactivation,
          // recall) refuses outright on !isDentallyWriteEnabled() before touching Dentally
          // at all; create_patient previously fell through to dentallyAgentClient(), which
          // defaults to the READ key/URL when writes are disabled and still issues a real
          // POST, then reported the result as "test mode" regardless of what actually
          // happened. Refuse honestly here instead: no dedupe search, no create attempt.
          if (!isDentallyWriteEnabled()) {
            return JSON.stringify({
              created: false,
              reason: "writes_disabled",
              message:
                "Patient creation is currently switched off for this practice, so I have not looked anyone up or created anyone. Tell the owner that creating patients needs the Dentally write key enabled first.",
            });
          }

          // (1) REQUIRED identity fields. NEVER invent a missing detail: an absent or bad
          // field returns an error that tells the model to ASK the owner, not guess.
          const firstName = String(input.firstName ?? "").trim();
          const lastName = String(input.lastName ?? "").trim();
          const dobRaw = String(input.dateOfBirth ?? "").trim();
          if (!firstName || !lastName) {
            return JSON.stringify({
              created: false,
              error: "I need the patient's first and last name. Ask the owner for the missing name; never guess it.",
            });
          }
          if (!dobRaw) {
            return JSON.stringify({
              created: false,
              error: "I need the patient's date of birth (YYYY-MM-DD). Ask the owner for it; never guess it.",
            });
          }

          // (2) DOB must be a REAL, PAST calendar date. canonicalDob rejects impossible
          // dates (2001-13-40, 31 Feb); ageFromDob returns null for a future/unparseable
          // date, and a whole-year age otherwise, so both a future DOB and an absurdly old
          // one (age > 120) are refused.
          const dob = canonicalDob(dobRaw);
          const age = dob ? ageFromDob(dob, new Date()) : null;
          if (!dob || age === null || age > 120) {
            return JSON.stringify({
              created: false,
              error: `"${dobRaw}" is not a valid date of birth. It must be a real, past date in YYYY-MM-DD form. Ask the owner to confirm it; never guess.`,
            });
          }

          // (3) At least one contact method, each validated with the SAME canonicalisers
          // the send path uses. A supplied-but-invalid value is an error (never silently
          // dropped or guessed); a missing pair is an error (never invented).
          const phoneRaw = String(input.phone ?? "").trim();
          const emailRaw = String(input.email ?? "").trim();
          const phone = phoneRaw ? toE164(phoneRaw) : null;
          const email = emailRaw ? normaliseEmail(emailRaw) : null;
          if (phoneRaw && !phone) {
            return JSON.stringify({
              created: false,
              error: `"${phoneRaw}" does not look like a valid mobile number. Ask the owner to check it; never guess.`,
            });
          }
          if (emailRaw && !email) {
            return JSON.stringify({
              created: false,
              error: `"${emailRaw}" does not look like a valid email address. Ask the owner to check it; never guess.`,
            });
          }
          if (!phone && !email) {
            return JSON.stringify({
              created: false,
              error: "A new patient needs at least a mobile number or an email address. Ask the owner for one; never invent contact details.",
            });
          }

          // (4) Optional gender: only honoured if the owner stated a recognised value.
          // Never guessed. An unrecognised value is an error rather than a silent drop.
          // When the owner did NOT state one it is derived from the title below, which
          // is what live Dentally needs and what the booking funnel already does.
          const genderInput = String(input.gender ?? "").trim();
          const gender = genderInput ? normaliseGender(genderInput) : null;
          if (genderInput && !gender) {
            return JSON.stringify({
              created: false,
              error: `I did not recognise the gender "${genderInput}". Use female or male, or leave it out; never guess.`,
            });
          }

          // (4b) THE TWO FIELDS LIVE DENTALLY REFUSES A REGISTRATION WITHOUT, and which
          // this tool used to omit entirely: a title and a payment plan. Every create it
          // made would have 422'd against the real practice (DENTALLY.md; memory
          // dentally-createpatient-422) while the local mock accepted it, so the tool
          // looked finished and was not.
          //
          // The owner is the RIGHT person to ask for both — they are the practice, they
          // know whether this patient is NHS or private, and nothing here is said to a
          // patient (the no-funding-jargon rule is about patient-facing messages). So an
          // absent or unrecognised value is refused with a sentence that tells the model
          // to go and ask, exactly like every other field on this tool.
          const titleInput = String(input.title ?? "").trim();
          const title = knownTitle(titleInput);
          if (!title) {
            return JSON.stringify({
              created: false,
              error: titleInput
                ? `I did not recognise the title "${titleInput}". Dentally accepts ${TITLES.join(", ")}. Ask the owner which one applies; never guess.`
                : `I need the patient's title (${TITLES.join(", ")}). Dentally will not create a patient without one. Ask the owner; never guess.`,
            });
          }
          const fundingInput = String(input.funding ?? "").trim();
          const paymentPlanId = knownPaymentPlanId(fundingInput);
          if (paymentPlanId === undefined) {
            return JSON.stringify({
              created: false,
              error: fundingInput
                ? `I did not recognise "${fundingInput}" as a way of being seen. Use NHS or private. Ask the owner which applies to this patient; never assume one.`
                : "I need to know whether this patient is being seen on the NHS or privately. Dentally will not create a patient without a payment plan. Ask the owner; never assume one.",
            });
          }

          // (5) Target site WITHIN the co-pilot's view scope, exactly like the other write
          // tools: the site currently in view (the first scoped site). An all-sites scope
          // resolves to that same primary site (siteIds[0]). CREATION happens here, but the
          // dedupe search below (E3) covers every site of the client, not just this one, so
          // someone already registered at a sister site is still found.
          const siteId = siteIds[0];
          if (!siteId) return JSON.stringify({ created: false, error: "No site is in scope to create the patient in." });

          const client = getClient(clientId);
          if (!client) return JSON.stringify({ created: false, error: "I could not resolve your practice." });
          const allSiteIds = getSites(client.id).map((s) => s.id);

          const name = `${firstName} ${lastName}`.trim();
          const readback = {
            firstName,
            lastName,
            title,
            dateOfBirth: dob,
            funding: fundingInput,
            phone: phone ?? null,
            email: email ?? null,
            // What will actually be SAVED, not merely what the owner typed: with no
            // stated gender this is the title derivation, and the owner reads it back
            // before confirming so a wrong derivation is caught by a person.
            gender: gender ?? (genderFromTitle(title) ? "male" : "female"),
            site: siteName(siteId),
          };

          // (6) DEDUPE FIRST (both steps), across EVERY site belonging to this client (E3),
          // so a patient already registered at a sister site is found rather than
          // duplicated. A plausible existing record short-circuits creation entirely: we
          // never create a second record for someone already there.
          const dedupe = await findLikelyExistingPatient(allSiteIds, { name, dob, phone, email });
          if (!dedupe.ok) {
            // (E2) FAIL CLOSED: the search itself did not complete, so we cannot say
            // whether this person already exists. Refuse rather than risk a duplicate in
            // a live 51k-patient book; a refused create is always recoverable, a duplicate
            // record is not.
            await logCopilotAction({
              clientId,
              siteId,
              actor,
              action: "create_patient",
              targetRef: null,
              targetName: name,
              channel: null,
              body: `DOB ${dob}${phone ? `, mobile ${phone}` : ""}${email ? `, email ${email}` : ""}`,
              status: "blocked:dedupe_check_failed",
            });
            return JSON.stringify({
              created: false,
              reason: "dedupe_check_failed",
              message:
                "I could not fully check Dentally for an existing match just now, so I have not created anyone (to avoid risking a duplicate record). Please try again in a moment.",
            });
          }
          const likely = dedupe.match;
          if (likely) {
            if (input.confirm === true) {
              // The re-check at confirm caught an existing record: log the block so the
              // audit trail shows a duplicate was prevented at the commit step.
              await logCopilotAction({
                clientId,
                siteId,
                actor,
                action: "create_patient",
                targetRef: `patient:${likely.id}`,
                targetName: name,
                channel: null,
                body: `DOB ${dob}${phone ? `, mobile ${phone}` : ""}${email ? `, email ${email}` : ""}`,
                status: "blocked:duplicate",
              });
            }
            return JSON.stringify({
              created: false,
              duplicate: true,
              match: {
                id: likely.id,
                name: likely.name,
                dateOfBirth: likely.dateOfBirth,
                site: siteName(likely.siteId),
                matchedOn: likely.matchedOn,
              },
              note:
                `A patient who looks like this already exists: ${likely.name}${likely.dateOfBirth ? ` (born ${likely.dateOfBirth})` : ""} at ${siteName(likely.siteId)}, matched on ${likely.matchedOn}. ` +
                "I have NOT created anyone. Tell the owner about the existing record. Only create a new patient if the owner explicitly confirms this is a DIFFERENT person.",
            });
          }

          // (7) STEP 1 gate: without an explicit confirm this is a PREVIEW only. Nothing
          // is written. Enforced here (not just in the prompt) so a model that skips the
          // confirmation cannot create a patient; the run.ts commit gate (create_patient
          // is in CONFIRM_COMMIT_TOOLS) ALSO makes a same-turn confirm inert.
          if (input.confirm !== true) {
            return JSON.stringify({
              created: false,
              preview: true,
              ...readback,
              note:
                `Ready to create this patient in Dentally (nothing saved yet). Read every detail back to the owner: ${title} ${firstName} ${lastName}, born ${dob}, ${fundingInput}` +
                // The sex is read back WHETHER OR NOT the owner stated one, because
                // when they did not it is derived from the title — a ~2%-wrong
                // default that only a person can catch, and only if they are shown it.
                `${phone ? `, mobile ${phone}` : ""}${email ? `, email ${email}` : ""}, ${readback.gender}, at ${siteName(siteId)}. ` +
                "Only once they clearly say yes, call create_patient again with confirm true.",
            });
          }

          // (8) STEP 2: confirmed. Create via the gated write client, mirroring the
          // booking-create write path: dentallyAgentClient() targets the dedicated write
          // instance (the write gate at the top of this case already guarantees writes
          // are enabled, so this always reaches the real/sandbox write instance, never the
          // default read-only client). The internal site id is mapped to Dentally's own
          // UUID exactly as booking-create and register_patient do.
          //
          // THE PAYLOAD IS BUILT BY THE SHARED, LIVE-CALIBRATED DERIVATION
          // (lib/dentally/patient-payload.ts), which is the whole point of the fix. What
          // this call used to send was `gender: "Male"` — a STRING, to an API that
          // carries sex as a boolean and answers "gender: must be male or female" to
          // anything else — and no title and no payment plan at all. Three of the four
          // fields live demanded, missing, on a tool whose entire job is creating a real
          // person in a book of 51,000.
          const audit = {
            clientId,
            siteId,
            actor,
            action: "create_patient",
            targetName: name,
            channel: null,
            body: `${title} ${name}, DOB ${dob}, ${fundingInput}${phone ? `, mobile ${phone}` : ""}${email ? `, email ${email}` : ""}${gender ? `, ${gender}` : ""}`,
          };

          const built = buildPatientRegistration({
            firstName,
            lastName,
            title,
            dateOfBirth: dob,
            paymentPlanId,
            // The owner's own word when they gave one; otherwise the title derivation.
            gender,
            email,
            phone,
            // Dentally knows its own site UUIDs, not our internal ids ("site-cc").
            dentallySiteId: dentallySiteId(siteId),
            useSms: Boolean(phone),
            useEmail: Boolean(email),
          });
          if (!built.ok) {
            // Unreachable while the guards above stand, and handled anyway: the one thing
            // this tool must never do is send Dentally a registration it will refuse and
            // then report the refusal as something the owner did wrong.
            await logCopilotAction({ ...audit, targetRef: null, status: "blocked:incomplete" });
            return JSON.stringify({
              created: false,
              reason: "incomplete",
              ...readback,
              message: `I could not create ${name}: ${built.reason} Ask the owner for the missing detail; never guess it.`,
            });
          }

          let newId: string;
          try {
            const client = dentallyAgentClient();
            const { patient } = await client.createPatient(built.payload);
            newId = String(patient.id);
          } catch (err) {
            // ANY Dentally failure is surfaced HONESTLY and NEVER auto-retried. A 403 most
            // likely means the write key is not permitted to create patients; a 422 means
            // Dentally rejected the details. The raw error body is never relayed verbatim.
            await logCopilotAction({ ...audit, targetRef: null, status: "error:create_failed" });
            const status = err instanceof DentallyError ? err.status : 0;
            const reason =
              status === 403
                ? "the Dentally key does not allow creating patients (403), so nothing was created."
                : status === 422
                  ? "Dentally rejected the details (422), so nothing was created. Check the date of birth and contact details with the owner."
                  : "I hit an error creating them in Dentally, so nothing was created.";
            return JSON.stringify({
              created: false,
              reason: "dentally_error",
              status,
              ...readback,
              message: `I could not create ${name}: ${reason}`,
            });
          }

          await logCopilotAction({ ...audit, targetRef: `patient:${newId}`, status: "created" });
          return JSON.stringify({
            created: true,
            patientId: newId,
            ...readback,
            dryRun: false,
            note: `Created ${name} in Dentally (id ${newId}). Confirm to the owner that they have been added.`,
          });
        }

        // -------------------------------------------------------------------
        // LEAD SIGHT (3 reads + 1 act).
        //
        // NOT AUDITED, THE THREE READS. logCopilotAction is this file's record of
        // what the assistant DID on the practice's behalf — every call site is a
        // send, a launch, a publish or a write, and every read tool above
        // (patient_record, appointments, outstanding_balances) logs nothing. A read
        // of the enquiry pipeline is the same kind of thing as a read of a patient
        // record, so it follows the same rule; nudge_lead, which sends, audits like
        // send_sms does.
        // -------------------------------------------------------------------

        case "list_recent_assessment_leads": {
          const days = parseWindowDays(input.days, { def: 7, max: 90 });
          if (!days.ok) return JSON.stringify({ error: days.error });
          const band = parseBand(input.band);
          if (!band.ok) return JSON.stringify({ error: band.error });

          const now = new Date();
          const window = londonDayWindow(now, days.days);
          // The read is bounded and the bound is REPORTED (below), rather than a
          // partial day being handed over as a whole one.
          const LIMIT = 100;
          const fetched = await listResponses({
            siteIds,
            ...(band.bands ? { bands: band.bands } : {}),
            // The QUERY carries the window, so a day busier than LIMIT loses its
            // OLDEST rows to the bound rather than losing the whole day to a
            // newest-N fetch that never reached back far enough.
            sinceIso: window.sinceIso,
            limit: LIMIT,
          });
          // sinceIso deliberately over-fetches by a day (londonDayWindow explains
          // why); this is the authority on what is actually in the window.
          const rows = fetched.filter((r) => inDayWindow(r.createdAt, window));

          // WHETHER EACH ONE HAS BEEN CONTACTED, which is the half of the question
          // the assessment table cannot answer: a response carries a lead_id once
          // it was bridged into Speed-to-lead, and the CONTACT state lives on that
          // lead. One batched, site-scoped read rather than one per row.
          const leadIds = [...new Set(rows.map((r) => r.leadId).filter((v): v is string => typeof v === "string" && v !== ""))];
          const leads = await listLeadsByIds({ siteIds, ids: leadIds });
          const leadById = new Map(leads.map((l) => [l.id, l]));

          return JSON.stringify({
            window: { days: days.days, from: window.keys[window.keys.length - 1], to: window.keys[0] },
            ...(band.bands ? { band: band.bands[0] } : {}),
            total: rows.length,
            // Every day of the window, including the empty ones: "nobody enquired
            // yesterday" is an answer, and a missing key would read as missing data.
            byDay: countByLondonDay(rows, (r) => r.createdAt, window),
            truncated: looksTruncated(fetched.length, LIMIT),
            leads: rows.map((r) => {
              const lead = r.leadId ? leadById.get(r.leadId) : undefined;
              return {
                name: r.firstName,
                submittedAt: r.createdAt,
                day: londonDayKey(new Date(r.createdAt)),
                band: r.band,
                score: r.rawScore,
                treatmentInterest: r.treatmentInterest,
                phone: r.phone,
                email: r.email,
                preferredChannel: r.channel,
                source: sourceLabel(r.source),
                site: siteName(r.siteId),
                answers: answerLines(r.responses),
                // Three genuinely different states, never collapsed into one:
                //   - no lead at all: recorded for nurture, nobody was contacted;
                //   - a lead we can see: its real stage and first-contact time;
                //   - a lead id we cannot see under this scope: say so rather than
                //     reporting "not contacted", which would be a guess.
                ...(lead
                  ? {
                      inLeadsPipeline: true,
                      leadId: lead.id,
                      stage: lead.stage,
                      contacted: lead.firstResponseAt !== null,
                      contactedAt: lead.firstResponseAt,
                      waitingMinutes: waitingMinutes(lead, now),
                    }
                  : r.leadId
                    ? { inLeadsPipeline: true, leadId: r.leadId, stage: null, contacted: null, note: "This enquiry is linked to a lead outside the site you have in view, so I cannot see its contact state." }
                    : { inLeadsPipeline: false, contacted: false, note: "Recorded for nurture; this one was not fast-tracked into the leads pipeline, so nobody has been contacted automatically." }),
              };
            }),
            note:
              "These are Smile Assessment submissions for the site(s) currently in view. 'contacted' means the platform's first-contact message went out, not that a person spoke to them.",
          });
        }

        case "list_speed_to_lead": {
          const filterRaw = String(input.filter ?? "open").trim().toLowerCase();
          if (filterRaw !== "open" && filterRaw !== "all") {
            return JSON.stringify({ error: `I did not recognise the filter "${String(input.filter)}". Use open or all.` });
          }
          const limit = parseLimit(input.limit, { def: 50, max: 100 });
          if (!limit.ok) return JSON.stringify({ error: limit.error });

          const now = new Date();
          // days is OPTIONAL HERE with no default, unlike the assessment tool: the
          // oldest untouched lead is the most urgent one, so "show me the open
          // leads" must not quietly mean "the recent ones".
          let window: ReturnType<typeof londonDayWindow> | null = null;
          if (wasSupplied(input.days)) {
            const days = parseWindowDays(input.days, { def: 7, max: 90 });
            if (!days.ok) return JSON.stringify({ error: days.error });
            window = londonDayWindow(now, days.days);
          }

          const fetched = await listLeads({
            siteIds,
            ...(filterRaw === "open" ? { stages: OPEN_LEAD_STAGES } : {}),
            ...(window ? { sinceIso: window.sinceIso } : {}),
            limit: limit.limit,
          });
          const rows = window ? fetched.filter((l) => inDayWindow(l.createdAt, window)) : fetched;

          // One batched attempts read for the whole page of leads, not one per lead.
          // The ids come from a site-scoped read, which is the contract
          // listAttemptsForLeads states it relies on.
          const attempts = await listAttemptsForLeads(rows.map((l) => l.id));
          const attemptsByLead = new Map<string, typeof attempts>();
          for (const a of attempts) {
            const bucket = attemptsByLead.get(a.leadId);
            if (bucket) bucket.push(a);
            else attemptsByLead.set(a.leadId, [a]);
          }

          return JSON.stringify({
            filter: filterRaw,
            ...(window ? { window: { from: window.keys[window.keys.length - 1], to: window.keys[0] } } : {}),
            total: rows.length,
            truncated: looksTruncated(fetched.length, limit.limit),
            leads: rows.map((l) => {
              const summary = summariseAttempts(attemptsByLead.get(l.id) ?? []);
              const address = toAddress(l);
              return {
                // The id is the handle nudge_lead takes; it is returned so the model
                // never has to construct or guess one.
                id: l.id,
                name: l.name,
                stage: l.stage,
                source: sourceLabel(l.source),
                sourceRaw: l.source,
                channel: l.channel,
                treatmentInterest: l.treatmentInterest,
                score: l.score,
                site: siteName(l.siteId),
                enquiredAt: l.createdAt,
                day: londonDayKey(new Date(l.createdAt)),
                contacted: l.firstResponseAt !== null,
                contactedAt: l.firstResponseAt,
                // Null once contacted, so "waiting" only ever describes someone who is.
                waitingMinutes: waitingMinutes(l, now),
                nurtureTouchesSent: l.nurtureStep,
                attempts: summary,
                // Surfaced BEFORE the owner asks for a nudge, because these are the
                // two things that make one refuse. An owner should not have to try
                // it to be told the person never consented.
                contactable: Boolean(address) && channelConsented(l),
                hasContactDetails: Boolean(address),
                consentedOnChannel: channelConsented(l),
              };
            }),
            note:
              "Leads for the site(s) currently in view. 'contacted' means the platform's first-contact message went out. Use nudge_lead with a lead's id to re-send first contact, and always read it back before confirming.",
          });
        }

        case "assessment_dropoff_summary": {
          const slug = String(input.slug ?? "").trim();
          if (!slug) {
            return JSON.stringify({
              error: "I need the assessment's URL slug (the last part of its public link). Ask the owner for the link rather than guessing a slug.",
            });
          }
          if (!clientId) return JSON.stringify({ error: "I could not resolve your practice." });

          const days = parseWindowDays(input.days, { def: 30, max: 365 });
          if (!days.ok) return JSON.stringify({ error: days.error });

          // CLIENT-SCOPED, which is the boundary the Smile Assessment module itself
          // uses for campaigns: the campaigns page lists them with listCampaigns
          // (client) and only the RESPONSES are site-scoped. So an assessment
          // belonging to a sister site is reported rather than hidden — an owner
          // looking at their own campaigns page would be told "I cannot see that"
          // about an assessment plainly in front of them — and the site it belongs
          // to is NAMED in the answer so the scope is never ambiguous.
          const campaign = await getCampaignBySlug(clientId, slug);
          if (!campaign) {
            return JSON.stringify({
              found: false,
              message: `I could not find an assessment with the URL slug "${slug}" for this practice. Ask the owner for the exact link; never guess a slug.`,
            });
          }

          let flowVersion = campaign.flowVersion;
          if (wasSupplied(input.flowVersion)) {
            const n = typeof input.flowVersion === "number" ? input.flowVersion : Number(input.flowVersion);
            // Bounded ABOVE by the same constant the public write side uses:
            // flow_version is an int4 column, so an unbounded integer is not a
            // "no rows" answer, it is a database error handed to the owner.
            if (!Number.isInteger(n) || n < 0 || n > MAX_FLOW_VERSION) {
              return JSON.stringify({ error: `flowVersion must be a whole number between 0 and ${MAX_FLOW_VERSION}.` });
            }
            flowVersion = n;
          }

          // A ROLLING window here, NOT the London-day window the two list tools
          // use, and deliberately: this is the same report the drop-off panel on
          // screen draws, computed the same way, so an owner comparing the two sees
          // one number rather than two that disagree by a few hours.
          const to = new Date();
          const from = new Date(to.getTime() - days.days * 24 * 60 * 60 * 1000);

          let scan: Awaited<ReturnType<typeof readStepEvents>>;
          try {
            scan = await readStepEvents({
              campaignId: campaign.id,
              flowVersion,
              fromIso: from.toISOString(),
              toIso: to.toISOString(),
            });
          } catch (e) {
            // Named, not swallowed: answering "0 sessions" would tell an owner
            // nobody uses their funnel, when the truth is the table is not there.
            if (e instanceof StepEventTableMissingError) {
              return JSON.stringify({ error: e.message, note: "Say this plainly to the owner; do not report it as zero traffic." });
            }
            throw e;
          }

          // Labels and length ONLY for the version that is live: a campaign row
          // stores one funnel, so numbering an older version with today's graph
          // would put today's questions on bars those events never came from.
          let stepCount: number | undefined;
          let labels: Record<number, string> | undefined;
          if (flowVersion === campaign.flowVersion) {
            const graph = normaliseFlow(campaign.flow);
            if (graph) {
              const numbering = stepNumbering(graph);
              if (numbering.stepCount > 0) {
                stepCount = numbering.stepCount;
                labels = stepLabels(graph, numbering, { headline: campaign.headline, intro: campaign.intro });
              }
            }
          }

          const funnel = aggregateStepEvents(scan.rows, stepCount === undefined ? undefined : { stepCount });

          return JSON.stringify({
            found: true,
            assessment: { slug: campaign.slug, name: campaign.name, site: siteName(campaign.siteId) },
            flowVersion,
            isCurrentVersion: flowVersion === campaign.flowVersion,
            from: from.toISOString(),
            to: to.toISOString(),
            days: days.days,
            // Said out loud rather than a partial tally passed off as a whole one.
            truncated: scan.truncated,
            sessions: funnel.sessions,
            completionPct: funnel.completionPct,
            steps: funnel.steps.map((s) => ({
              ...s,
              // The SAME fallback wording the on-screen chart uses for an unlabelled
              // bar, so the co-pilot and the panel name the same step the same way.
              label: labels?.[s.stepIndex]?.trim() || `Step ${s.stepIndex + 1}`,
            })),
            note:
              "dropOffPct is the share of the PREVIOUS step's sessions that did not reach this one; it is null on the first step and whenever the previous step had nobody. A step with no sessions at all is a screen nobody reached.",
          });
        }

        case "nudge_lead": {
          // Re-fires the EXISTING first-contact path (contactLead), with the SAME
          // claim/restore dance as /api/speed-to-lead/[action] resend. No new send
          // machinery: consent, opt-out, deliverability, the retry cap, the drafting
          // and the attempt record all stay inside contactLead, where they already
          // are, so the co-pilot and the worklist button cannot drift apart.
          const leadId = String(input.leadId ?? "").trim();
          if (!leadId) {
            return JSON.stringify({ sent: false, error: "I need the lead's id. Use list_speed_to_lead to find it; never invent one." });
          }

          const lead = await getLead(leadId);
          // TENANCY FIRST, before anything about this lead is spoken aloud.
          //
          // getLead is keyed on the id ALONE, so the two checks below are the whole
          // boundary. A lead belonging to ANOTHER PRACTICE is reported exactly as a
          // lead that does not exist: an id typed at this co-pilot must never be
          // able to tell the difference, or the tool becomes an oracle for whether a
          // given id exists somewhere in the platform.
          const owningClientId = lead ? getSite(lead.siteId)?.clientId : undefined;
          if (!lead || !owningClientId || owningClientId !== clientId) {
            if (lead) {
              // A cross-tenant attempt is worth a record, but the row must not carry
              // the other practice's site or the person's name into this client's
              // audit trail.
              await logCopilotAction({
                clientId,
                siteId: null,
                actor,
                action: "nudge_lead",
                targetRef: `lead:${leadId}`,
                targetName: null,
                channel: null,
                body: null,
                status: "blocked:out_of_tenant",
              });
            }
            return JSON.stringify({ sent: false, error: "I could not find a lead with that id." });
          }

          // Same client, different site: the site IS nameable here, and naming it is
          // the useful answer (the owner switches the selector and asks again).
          if (!siteIds.includes(lead.siteId)) {
            return JSON.stringify({
              sent: false,
              reason: "out_of_scope",
              message: `That lead is at ${siteName(lead.siteId)}, which is not the site you have in view, so I have not messaged them. Switch the site selector at the top of the dashboard (or pick "All sites") and ask me again.`,
            });
          }

          const audit = {
            clientId,
            siteId: lead.siteId,
            actor,
            action: "nudge_lead",
            targetRef: `lead:${lead.id}`,
            targetName: lead.name,
            channel: lead.channel as string,
            body: null,
          };

          // The kill switch, exactly where the route checks it.
          if (!(await isSystemEnabled(clientId, "speed-to-lead"))) {
            await logCopilotAction({ ...audit, status: "blocked:system_off" });
            return JSON.stringify({
              sent: false,
              reason: "system_off",
              message: "Speed-to-lead is switched off for this practice, so I have not messaged anyone. The owner can switch it on in Operations, System controls, then ask me again.",
            });
          }

          // The route's own two refusals, inherited rather than re-decided.
          const refusal = nudgeRefusal(lead.stage);
          if (refusal) {
            await logCopilotAction({ ...audit, status: `blocked:stage_${lead.stage}` });
            return JSON.stringify({ sent: false, reason: "stage", stage: lead.stage, message: refusal });
          }

          // THE ONE PLACE THIS IS STRICTER THAN THE WORKLIST BUTTON, and it is the
          // send_sms pattern applied honestly. contactLead's answer to "no address"
          // is to do nothing, and its answer to "no consent" is to RETIRE the lead
          // to the terminal 'lost' stage. Neither is a message, and the second is a
          // state change an owner who said "yes, text them" did not ask for and
          // cannot undo from here. So both are refused with the reason, exactly as
          // send_sms refuses no_destination and no_consent, and the lead is left
          // where the worklist can still see it.
          const address = toAddress(lead);
          if (!address) {
            await logCopilotAction({ ...audit, status: "blocked:no_destination" });
            return JSON.stringify({
              sent: false,
              reason: "no_destination",
              message: `${lead.name} has no ${lead.channel === "email" ? "email address" : "mobile number"} on file, so there is nothing to re-send to.`,
            });
          }
          if (!channelConsented(lead)) {
            await logCopilotAction({ ...audit, status: "blocked:no_consent" });
            return JSON.stringify({
              sent: false,
              reason: "no_consent",
              message: `${lead.name} did not consent to be contacted by ${lead.channel === "email" ? "email" : lead.channel === "whatsapp" ? "WhatsApp" : "text"}, so nothing was sent.`,
            });
          }

          const attemptsSoFar = summariseAttempts(await listAttemptsForLeads([lead.id]));
          const readback = {
            leadId: lead.id,
            patient: lead.name,
            stage: lead.stage,
            source: sourceLabel(lead.source),
            channel: lead.channel,
            treatmentInterest: lead.treatmentInterest,
            site: siteName(lead.siteId),
            enquiredAt: lead.createdAt,
            waitingMinutes: waitingMinutes(lead, new Date()),
            alreadyContactedAt: lead.firstResponseAt,
            attempts: attemptsSoFar,
          };

          // Two-step gate, enforced here and not only in the prompt (run.ts also
          // holds nudge_lead in CONFIRM_COMMIT_TOOLS, so a same-turn confirm is
          // inert as well).
          if (input.confirm !== true) {
            return JSON.stringify({
              sent: false,
              preview: true,
              ...readback,
              note:
                `Ready to re-send first contact to ${lead.name} (nothing sent yet). Read it back to the owner: who they are, where the enquiry came from, and that ${attemptsSoFar.total === 0 ? "no message has gone out yet" : `${attemptsSoFar.total} message${attemptsSoFar.total === 1 ? " has" : "s have"} already been attempted${attemptsSoFar.failed > 0 ? `, ${attemptsSoFar.failed} of which failed to send` : ""}`}. The platform writes the message itself. Only once they clearly say yes, call nudge_lead again with confirm true.`,
            });
          }

          // CONFIRMED. The atomic claim is what stops two nudges (or a nudge racing
          // the SLA sweep) both texting the same person; a lost claim means another
          // contact is already in flight, which is not an error.
          const fromStage = lead.stage;
          if (!(await claimLeadFromStage(lead.id, fromStage))) {
            await logCopilotAction({ ...audit, status: "skipped:in_progress" });
            return JSON.stringify({
              sent: false,
              reason: "in_progress",
              message: `A contact to ${lead.name} is already in progress, so I have not sent a second one.`,
            });
          }

          let failed = false;
          let after: SpeedToLeadLead | null = null;
          try {
            await contactLead(lead);
          } catch (err) {
            failed = true;
            console.error(`[copilot] nudge_lead: contactLead threw for lead ${lead.id}`, err);
          } finally {
            // If contactLead did not move the lead off 'contacting' (a silent
            // early-return, or the throw above), restore its ORIGINAL stage so it is
            // not stranded — identical to the route's finally block.
            after = await getLead(lead.id).catch(() => null);
            if (after && after.stage === "contacting") {
              await setLeadStage(lead.id, fromStage).catch(() => {});
              after = { ...after, stage: fromStage };
            }
          }

          // WHAT ACTUALLY HAPPENED, OBSERVED, NOT ASSERTED.
          //
          // contactLead returns void and has SEVERAL silent outcomes: it retires a
          // lead whose address turns out to be undeliverable, it retires one whose
          // draft trips the output guardrail, and it declines to draft at all once a
          // lead has hit its failed-attempt cap. Every one of those ends with nobody
          // texted, so a tool that answered "sent: true" because the call returned
          // would be the co-pilot telling an owner a patient was contacted when they
          // were not.
          //
          // AND THE OBVIOUS SIGNAL IS THE WRONG ONE. first_response_at is stamped
          // ONLY on a lead that has never been contacted ("so a staff resend never
          // corrupts the first-response SLA metric", contact.ts) — which is exactly
          // the lead a nudge is usually aimed at, so watching that field would report
          // every successful nudge of an already-contacted lead as a failure. The
          // attempt LEDGER is what a resend always writes, so that is what is read.
          const attemptsAfter = summariseAttempts(await listAttemptsForLeads([lead.id]).catch(() => []));
          const newAttempt = attemptsAfter.total > attemptsSoFar.total;

          if (failed) {
            await logCopilotAction({ ...audit, status: "error:contact_failed" });
            return JSON.stringify({
              sent: false,
              reason: "error",
              ...readback,
              message: `Something went wrong re-sending to ${lead.name}, so I cannot say a message went out. Try again in a moment, or check the lead in Leads.`,
            });
          }
          // Checked BEFORE the ledger, because the guardrail path writes a failed
          // attempt AND retires the lead: "retired" is the more important half.
          if (after && after.stage === "lost") {
            await logCopilotAction({ ...audit, status: "retired:unreachable" });
            return JSON.stringify({
              sent: false,
              reason: "unreachable",
              ...readback,
              attempts: attemptsAfter,
              message: `${lead.name} could not be reached (they have opted out, or the number or address cannot receive a message), so nothing was sent and the lead has been closed as lost. Tell the owner it needs a person, not another try.`,
            });
          }
          if (!newAttempt) {
            await logCopilotAction({ ...audit, status: "skipped:not_sent" });
            return JSON.stringify({
              sent: false,
              reason: "not_sent",
              ...readback,
              message: `I did not manage to get a message out to ${lead.name} just now, and the lead is unchanged. This usually means earlier attempts to reach them kept failing, so it needs a person to look at rather than another automatic try.`,
            });
          }
          if (attemptsAfter.lastStatus === "failed") {
            await logCopilotAction({ ...audit, status: "failed:not_delivered" });
            return JSON.stringify({
              sent: false,
              reason: "delivery_failed",
              ...readback,
              attempts: attemptsAfter,
              message: `The message to ${lead.name} could not be delivered, so they have not heard from us. The platform will try again on its own; do not tell the owner they have been contacted.`,
            });
          }

          const dryRun = isDryRun();
          await logCopilotAction({ ...audit, status: dryRun ? "dry_run" : "sent" });
          return JSON.stringify({
            sent: true,
            ...readback,
            stage: after?.stage ?? "contacted",
            dryRun,
            note: dryRun
              ? `Re-sent first contact to ${lead.name}, recorded in test mode (dry run): it was not delivered to them. It will go out for real once the practice switches messaging live.`
              : `Re-sent first contact to ${lead.name}.`,
          });
        }

        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
    }
  };
}
