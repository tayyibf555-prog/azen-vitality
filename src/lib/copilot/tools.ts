import type Anthropic from "@anthropic-ai/sdk";
import { getSite } from "@/lib/mock";
import { getSites } from "@/lib/mock/clients";
import { londonDayKey } from "@/lib/time/london";
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

          // Two-step gate: without an explicit confirm this is a PREVIEW only. It
          // has verified the patient and consent but sends nothing. The owner must
          // confirm before a real send (this is enforced here, not just in the
          // prompt, so a model that skips the confirmation cannot dispatch).
          if (input.confirm !== true) {
            return JSON.stringify({
              sent: false,
              preview: true,
              patient: p.name,
              channel,
              ...(channel === "email" ? { subject } : {}),
              message,
              note: `Ready to send to ${p.name} (consent is in place, nothing sent yet). Show this to the owner and, only once they confirm, call ${name} again with confirm true.`,
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
          return JSON.stringify({
            sent: true,
            patient: p.name,
            channel,
            dryRun,
            status: result.status,
            note: dryRun
              ? "Recorded in test mode (dry run); it was not delivered to the patient. It will go out for real once the practice switches messaging live."
              : "Sent.",
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
          let excludedMissingData = 0;
          let buildStatus: "ready" | "building" | "paused" | "unavailable" = "building";
          let pauseReason: "rate-limit" | "error" | null = null;
          if (!dentallyReadKey()) {
            buildStatus = "unavailable";
          } else {
            const tick = await runOutreachBuildTick(campaign);
            matched = tick.counts.matched ?? 0;
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
          const readback = {
            campaignId: campaign.id,
            name: campaign.name,
            segment: describeSegment(campaign.filters),
            matched: counts.built,
            practitioner: campaign.practitionerName,
            dailyCap: campaign.dailyCap,
            status: campaign.status,
          };

          // Two-step gate, identical to send_sms: without an explicit confirm this is a
          // READ-BACK only, nothing is launched. The prompt forbids setting confirm true
          // in the same turn as the request; this gate makes a missing confirm inert
          // regardless, so a model that skips the read-back cannot launch.
          if (input.confirm !== true) {
            return JSON.stringify({
              launched: false,
              preview: true,
              ...readback,
              note: "Read this back to the owner (segment, matched count, clinician, daily cap). Nothing launched yet. Only once they confirm, call launch_outreach_campaign again with confirm true.",
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

        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
    }
  };
}
