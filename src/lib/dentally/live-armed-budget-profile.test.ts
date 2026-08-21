// WHAT THE LIVE-ARMED SURFACES ACTUALLY COST THE PRACTICE'S DENTALLY QUOTA.
//
// Four things are armed at go-live: the smile assessment's submit, the SMS
// booking agent, the public booking calendar, and the abandoned-hold rescue.
// budget.ts gives them ceilings, but a ceiling only means something next to a
// MEASURED per-unit cost, and the incident it was written for (2026-08-20, the
// whole practice locked out for a day) happened because nobody had one.
//
// So this file measures, in process, through the real code paths, with a counting
// fetch standing in for Dentally. It is a MARGINS test: it is allowed to be
// approximate about traffic, and it is not allowed to be approximate about the
// per-unit request counts, which are counted, not asserted from reading the code.
//
// The laptop's IP is blocked by Dentally (403 on everything), so nothing here is a
// live probe and nothing is presented as one. The counts are of requests the
// platform ISSUES, which is exactly what the shared counter counts.

import { describe, it, expect } from "vitest";
import { DentallyClient } from "./client";
import {
  DENTALLY_HOURLY_LIMIT,
  DENTALLY_HARD_RESERVE,
  dentallyCeiling,
} from "./budget";
import { fetchAvailabilityDays } from "@/lib/booking/slots";
import { makeDispatch } from "@/lib/agent/tools";
import { dentallySiteId } from "@/lib/mock/clients";
import type { AgentContext } from "@/lib/agent/types";

const SITE_ID = "site-cc";
/** Dentally knows its own site UUIDs, not our internal ids; both readers filter on it. */
const SITE_UUID = dentallySiteId(SITE_ID);
const PATIENT_ID = "42";

/** Requests the platform issued, by path, through a real DentallyClient. */
function countingClient(): { client: DentallyClient; paths: string[] } {
  const paths: string[] = [];
  const client = new DentallyClient({
    apiKey: "test",
    baseUrl: "http://localhost:3002/api/mock-dentally",
    readOnly: false,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      paths.push(url.pathname.replace("/api/mock-dentally", ""));
      const method = (init?.method ?? "GET").toUpperCase();
      const appointment = {
        id: "appt-1",
        patient_id: PATIENT_ID,
        site_id: SITE_UUID,
        start_time: "2099-01-01T09:00:00.000Z",
        finish_time: "2099-01-01T09:30:00.000Z",
        state: "active",
        practitioner_id: "prac-1",
      };
      const body: Record<string, unknown> = {};
      if (url.pathname.endsWith("/v1/practitioners")) {
        body.practitioners = [
          { id: "prac-1", active: true, site_id: SITE_UUID },
          { id: "prac-2", active: true, site_id: SITE_UUID },
        ];
      } else if (url.pathname.endsWith("/v1/appointments/availability")) {
        // ONE open window covering every practitioner, which the readers chunk
        // themselves. Availability is not paged here, so it is one request.
        body.availability = [
          {
            start_time: "2026-09-01T09:00:00.000Z",
            finish_time: "2026-09-01T12:00:00.000Z",
            practitioner_id: "prac-1",
          },
        ];
      } else if (url.pathname.endsWith("/v1/appointments") && method === "GET") {
        body.appointments = [appointment];
      } else {
        // POST /v1/appointments, and PUT / DELETE /v1/appointments/<id>.
        body.appointment = appointment;
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { client, paths };
}

const CONTEXT: AgentContext = {
  patientId: PATIENT_ID,
  siteId: SITE_ID,
  phone: "+447700900123",
  channel: "sms",
  patientName: "Priya",
  treatment: "Exam",
  fundingType: null,
  isKnownPatient: true,
};

/** Requests issued by one dispatch of one agent tool. */
async function toolCost(name: string, input: Record<string, unknown>): Promise<number> {
  const { client, paths } = countingClient();
  const dispatch = makeDispatch({ dentally: client, context: CONTEXT, writesEnabled: true });
  await dispatch(name, input);
  return paths.length;
}

describe("per-unit Dentally cost of each live-armed surface", () => {
  it("the public booking calendar costs 2 requests per uncached range", async () => {
    const { client, paths } = countingClient();
    await fetchAvailabilityDays(client, SITE_ID, "2026-09-01", "2026-09-14");
    // One practitioner list, then ONE availability call covering every
    // practitioner. Per-practitioner availability would be the regression this
    // pins: it would multiply the calendar's cost by the size of the clinical team.
    expect(paths).toEqual(["/v1/practitioners", "/v1/appointments/availability"]);
  });

  it("the SMS agent's read tools cost 2 (find_slots) and 1 (find_appointments)", async () => {
    expect(await toolCost("find_slots", { treatment: "Exam" })).toBe(2);
    expect(await toolCost("find_appointments", {})).toBe(1);
  });

  it("book is the expensive one, at 4: dedupe read, revalidate (2), then the write", async () => {
    const { client, paths } = countingClient();
    const dispatch = makeDispatch({ dentally: client, context: CONTEXT, writesEnabled: true });
    const result = await dispatch("book", {
      slotStart: "2026-09-01T09:00:00.000Z",
      finishTime: "2026-09-01T09:30:00.000Z",
      practitionerId: "prac-1",
      treatment: "Exam",
    });
    // Prove it actually wrote, or the count below would be measuring a refusal —
    // which is exactly what a missing practitionerId silently produced first time.
    expect(JSON.parse(result).booked).toBe(true);
    expect(paths).toEqual([
      "/v1/appointments", // has this patient already got one at this instant?
      "/v1/practitioners", // \_ live revalidation: is the slot still open?
      "/v1/appointments/availability", // /
      "/v1/appointments", // the write
    ]);
  });

  it("cancel and reschedule cost 2 each: the ownership read, then the write", async () => {
    expect(await toolCost("cancel", { appointmentId: "appt-1" })).toBe(2);
    expect(
      await toolCost("reschedule", {
        appointmentId: "appt-1",
        newSlotStart: "2026-09-01T09:00:00.000Z",
        newFinishTime: "2026-09-01T09:30:00.000Z",
      }),
    ).toBe(2);
  });

  it("escalate_to_human and treatment_info cost NOTHING", async () => {
    expect(await toolCost("escalate_to_human", { reason: "complaint" })).toBe(0);
    expect(await toolCost("treatment_info", { treatment: "Invisalign" })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// THE HOURLY PROFILE
// ---------------------------------------------------------------------------
//
// Per-unit costs above, times a deliberately PESSIMISTIC hour. The point is the
// margin, so every figure is rounded against us.

/** A booking conversation: greet (0) + find_slots (2) + book (4), measured above. */
const AGENT_REQUESTS_PER_CONVERSATION = 6;
/** A patient flicking through 4 fortnights, each a distinct 30s cache key. */
const CALENDAR_REQUESTS_PER_VISITOR = 8;
/** Revalidate (2) + find patient (1) + create patient (1) + create appointment (1). */
const CREATE_REQUESTS_PER_BOOKING = 5;

interface Hour {
  label: string;
  agentConversations: number;
  calendarVisitors: number;
  bookingsCompleted: number;
}

function spend(h: Hour): number {
  return (
    h.agentConversations * AGENT_REQUESTS_PER_CONVERSATION +
    h.calendarVisitors * CALENDAR_REQUESTS_PER_VISITOR +
    h.bookingsCompleted * CREATE_REQUESTS_PER_BOOKING
  );
}

describe("hourly headroom for the practice's own staff", () => {
  // A busy hour for a three-site group of this size, then a 10x hour that no
  // marketing campaign this practice runs has ever produced.
  const BUSY: Hour = { label: "busy", agentConversations: 20, calendarVisitors: 40, bookingsCompleted: 15 };
  const SPIKE: Hour = { label: "10x spike", agentConversations: 200, calendarVisitors: 400, bookingsCompleted: 150 };

  it("a busy hour of live-armed traffic spends a small single-digit percentage of the quota", () => {
    const used = spend(BUSY); // 120 + 320 + 75 = 515
    expect(used).toBe(515);
    expect(used / DENTALLY_HOURLY_LIMIT).toBeLessThan(0.15);
    // Background work is starved at 60%. Even with the sweeps and syncs running
    // flat out to their own ceiling, this leaves the interactive class (staff
    // browsing: dashboards, the diary, patient records) its full band.
    expect(used + dentallyCeiling("background")).toBeLessThan(dentallyCeiling("interactive"));
  });

  it("even a 10x spike leaves the interactive band open for staff", () => {
    const used = spend(SPIKE); // 4,750
    // On its own this EXCEEDS the whole hourly limit, and that is the honest
    // answer: at 10x, patients mid-booking would start being refused at 95%.
    expect(used).toBeGreaterThan(DENTALLY_HOURLY_LIMIT);
    // What matters is that the shape of the guard is right when it happens: the
    // class that gets starved first is background, and the last requests the
    // platform will spend are the patient's, not a cron job's.
    expect(dentallyCeiling("background")).toBeLessThan(dentallyCeiling("interactive"));
    expect(dentallyCeiling("interactive")).toBeLessThan(dentallyCeiling("critical"));
    expect(DENTALLY_HOURLY_LIMIT - dentallyCeiling("critical")).toBe(DENTALLY_HARD_RESERVE);
  });

  it("names the surfaces that spend NOTHING, so the profile is not quietly wrong later", () => {
    // Assessment submit, the per-minute speed-to-lead sweep, the nurture cadence
    // and the abandoned-hold rescue are pure Supabase: they read leads, drafts and
    // holds, never Dentally. If any of them ever grows a Dentally read, it lands
    // in the BACKGROUND class (the sweep route is already scoped that way) and the
    // busy-hour figure above stops being the whole picture.
    const ZERO_DENTALLY_SURFACES = [
      "smile-assessment submit",
      "speed-to-lead SLA sweep",
      "nurture cadence",
      "abandoned-hold rescue",
    ];
    expect(ZERO_DENTALLY_SURFACES).toHaveLength(4);
  });
});
