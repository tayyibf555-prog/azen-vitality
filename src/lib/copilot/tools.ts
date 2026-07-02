import type Anthropic from "@anthropic-ai/sdk";
import { getSite } from "@/lib/mock";
import { londonDayKey } from "@/lib/time/london";
import {
  listPatients,
  listAppointments,
  listOutstanding,
  getPatientDetail,
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
          const q = String(input.query ?? "").toLowerCase().trim();
          const patients = await listPatients(siteIds);
          const matches = q
            ? patients.filter((p) => p.name.toLowerCase().includes(q) || (p.phone ?? "").includes(q))
            : patients;
          return JSON.stringify({ count: matches.length, patients: matches.slice(0, 25).map(patientSummary) });
        }

        case "patient_record": {
          const q = String(input.query ?? "").toLowerCase().trim();
          const patients = await listPatients(siteIds);
          const matches = patients.filter(
            (p) => p.name.toLowerCase().includes(q) || (p.phone ?? "").includes(q),
          );
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
          const q = String(input.patient ?? "").toLowerCase().trim();
          const message = String(input.message ?? "").trim();
          const subject = String(input.subject ?? "").trim();
          if (!q || !message) {
            return JSON.stringify({ sent: false, error: "Need a patient and a message." });
          }
          if (channel === "email" && !subject) {
            return JSON.stringify({ sent: false, error: "An email needs a subject." });
          }

          const patients = await listPatients(siteIds);
          const matches = patients.filter(
            (p) => p.name.toLowerCase().includes(q) || (p.phone ?? "").includes(q) || (p.email ?? "").toLowerCase().includes(q),
          );
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

        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
    }
  };
}
