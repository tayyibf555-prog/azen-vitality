import type Anthropic from "@anthropic-ai/sdk";
import { NOW } from "@/lib/mock/clients";
import { getSite } from "@/lib/mock";
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

const todayIso = () => NOW.toISOString().slice(0, 10);
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

export function makeCopilotDispatch(siteIds: string[]) {
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

        default:
          return JSON.stringify({ error: `unknown tool: ${name}` });
      }
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : "tool failed" });
    }
  };
}
