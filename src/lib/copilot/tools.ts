import Anthropic from "@anthropic-ai/sdk";
import { getSite } from "@/lib/mock";
import { getSites, getClient } from "@/lib/mock/clients";
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
  type PatientRecord,
} from "@/lib/dentally/read";
import { listTargets } from "@/lib/reactivation/repository";
import { listOpportunities } from "@/lib/coordinator/repository";
import { getAgentAnalytics } from "@/lib/agent/repository";
import { searchKnowledge } from "@/lib/practice-brain/retrieval";
import { sendMessage } from "@/lib/messaging/send";
import { isSuppressed } from "@/lib/messaging/suppression";
import { wasContactedToday, recordContacted } from "@/lib/messaging/frequency";
import { toE164, normaliseEmail } from "@/lib/messaging/phone";
import { checkAgentReply } from "@/lib/agent/guardrail";
import type { MessageChannel } from "@/lib/messaging/types";
import {
  createCampaign,
  getCampaign,
  updateCampaign,
  campaignStatusCounts,
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
      "Create a DRAFT segment outreach campaign (or just build a patient list to see how many match) and start scanning the patient base. It NEVER launches or sends anything: it defines the segment, kicks off the scan, and returns the campaign id, a plain-English read-back of the segment, the current matched count, and how many records were skipped for having no recorded age/gender when those filters are used. Use ONLY filter values the owner actually stated; do not invent dates, treatments, ages, gender or a practitioner. A message angle (what the invite is about, e.g. 'a hygiene visit') is OPTIONAL here, so the owner can build a list first; it is required later to launch. The build may take a moment; the matched count updates shortly.",
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
            appointmentHistory: detail.appointments,
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
          // (not via the shared drain), so — like the drain — it must key on the CANONICAL
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
          // takeover bypasses the module kill switches) — but only as a DELIBERATE,
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
          // reactivation, no-show, outreach, nurture — all draining through the shared
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
          const readback = {
            campaignId: campaign.id,
            name: campaign.name,
            segment: describeSegment(campaign.filters),
            matched: counts.built,
            ...(contactable !== null ? { contactable } : {}),
            practitioner: campaign.practitionerName,
            dailyCap: campaign.dailyCap,
            status: campaign.status,
          };
          const consentCaveat =
            contactable !== null && contactable < counts.built
              ? ` Of the ${counts.built} matched, ${contactable} have SMS consent and will be contacted; the rest are not texted.`
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
              note: `Read this back to the owner (segment, matched count, clinician, daily cap).${consentCaveat} Nothing launched yet. Only once they confirm, call launch_outreach_campaign again with confirm true.`,
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

        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
    }
  };
}
