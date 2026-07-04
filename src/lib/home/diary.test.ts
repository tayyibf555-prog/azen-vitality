import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/dentally/read", () => ({
  listAppointments: vi.fn(),
}));
vi.mock("@/lib/noshow/repository", () => ({
  listTargets: vi.fn(),
}));
vi.mock("@/lib/mock/clients", () => ({
  getSites: vi.fn(),
}));

import { listAppointments } from "@/lib/dentally/read";
import { listTargets } from "@/lib/noshow/repository";
import { getSites } from "@/lib/mock/clients";
import { getTodayDiary } from "./diary";

const mockAppts = vi.mocked(listAppointments);
const mockTargets = vi.mocked(listTargets);
const mockSites = vi.mocked(getSites);

// 4 July 2026 is BST (UTC+1): 10:00Z is 11:00 on the London wall clock.
const NOW = new Date("2026-07-04T10:00:00Z");

function appt(over: Record<string, unknown>) {
  return {
    id: "a1",
    patientId: "p1",
    patientName: "Amelia Khan",
    siteId: "site-1",
    start: "2026-07-04T08:00:00Z",
    finish: null,
    durationMin: 30,
    state: "booked",
    reason: null,
    practitioner: null,
    ...over,
  };
}

function target(appointmentId: string) {
  return { appointmentId } as Awaited<ReturnType<typeof listTargets>>[number];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSites.mockReturnValue([
    { id: "site-1", name: "Harley Street" },
    { id: "site-2", name: "Richmond" },
  ] as ReturnType<typeof getSites>);
  mockTargets.mockResolvedValue([]);
});

describe("getTodayDiary", () => {
  it("classifies the day: done, gap, next, risk, booked — and computes fill", async () => {
    mockAppts.mockResolvedValue([
      // 08:00 London, already past → completed even though state is "booked"
      appt({ id: "a1", start: "2026-07-04T07:00:00Z", patientName: "Amelia Khan" }),
      // explicit done state
      appt({ id: "a2", start: "2026-07-04T08:00:00Z", state: "completed", patientName: "Ben Osei" }),
      // cancelled future slot → gap
      appt({ id: "a3", start: "2026-07-04T10:30:00Z", state: "cancelled", patientName: "Chloe Fox" }),
      // first future booked → next
      appt({ id: "a4", start: "2026-07-04T11:00:00Z", patientName: "Dev Patel", reason: "hygiene" }),
      // future + flagged high risk → risk (not "booked")
      appt({ id: "a5", start: "2026-07-04T12:00:00Z", patientName: "Ella Nowak" }),
      // remaining future → booked
      appt({ id: "a6", start: "2026-07-04T13:00:00Z", patientName: "Farid Aziz" }),
    ] as Awaited<ReturnType<typeof listAppointments>>);
    mockTargets.mockResolvedValue([target("a5")] as Awaited<ReturnType<typeof listTargets>>);

    const diary = await getTodayDiary("client-1", NOW);

    expect(diary.slots.map((s) => s.state)).toEqual([
      "completed",
      "completed",
      "gap",
      "next",
      "risk",
      "booked",
    ]);
    // London wall-clock labels (BST = UTC+1).
    expect(diary.slots.map((s) => s.time)).toEqual([
      "08:00",
      "09:00",
      "11:30",
      "12:00",
      "13:00",
      "14:00",
    ]);
    expect(diary.next).toEqual({ time: "12:00", label: "Dev Patel · hygiene" });
    expect(diary.gapCount).toBe(1);
    expect(diary.fillPercent).toBe(83); // 5 of 6 slots kept
    // Risk joined by appointment id, and passed the site scope + filters.
    expect(mockTargets).toHaveBeenCalledWith({
      siteIds: ["site-1", "site-2"],
      statuses: ["scheduled"],
      riskBands: ["high"],
    });
  });

  it("labels without reason as just the patient name", async () => {
    mockAppts.mockResolvedValue([
      appt({ id: "a1", start: "2026-07-04T11:00:00Z", patientName: "Grace Lam", reason: null }),
    ] as Awaited<ReturnType<typeof listAppointments>>);

    const diary = await getTodayDiary("client-1", NOW);
    expect(diary.slots[0].label).toBe("Grace Lam");
  });

  it("a first-future appointment that is high-risk stays risk; next falls to the following slot", async () => {
    mockAppts.mockResolvedValue([
      appt({ id: "a1", start: "2026-07-04T11:00:00Z", patientName: "Hana Suzuki" }),
      appt({ id: "a2", start: "2026-07-04T12:00:00Z", patientName: "Isaac Boone" }),
    ] as Awaited<ReturnType<typeof listAppointments>>);
    mockTargets.mockResolvedValue([target("a1")] as Awaited<ReturnType<typeof listTargets>>);

    const diary = await getTodayDiary("client-1", NOW);
    expect(diary.slots.map((s) => s.state)).toEqual(["risk", "next"]);
    expect(diary.next?.label).toBe("Isaac Boone");
  });

  it("drops rows outside today even if the upstream range leaks them", async () => {
    mockAppts.mockResolvedValue([
      appt({ id: "a1", start: "2026-07-03T11:00:00Z", patientName: "Yesterday" }),
      appt({ id: "a2", start: "2026-07-04T11:00:00Z", patientName: "Today" }),
      appt({ id: "a3", start: "2026-07-05T11:00:00Z", patientName: "Tomorrow" }),
    ] as Awaited<ReturnType<typeof listAppointments>>);

    const diary = await getTodayDiary("client-1", NOW);
    expect(diary.slots).toHaveLength(1);
    expect(diary.slots[0].label).toBe("Today");
  });

  it("renders empty (never throws) when the appointments read fails", async () => {
    mockAppts.mockRejectedValue(new Error("dentally down"));

    const diary = await getTodayDiary("client-1", NOW);
    expect(diary).toEqual({ slots: [], next: null, fillPercent: null, gapCount: 0 });
  });

  it("keeps the diary (without risk marks) when the risk read fails", async () => {
    mockAppts.mockResolvedValue([
      appt({ id: "a1", start: "2026-07-04T11:00:00Z" }),
    ] as Awaited<ReturnType<typeof listAppointments>>);
    mockTargets.mockRejectedValue(new Error("db down"));

    const diary = await getTodayDiary("client-1", NOW);
    expect(diary.slots.map((s) => s.state)).toEqual(["next"]);
  });
});
