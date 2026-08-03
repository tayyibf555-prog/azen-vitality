"use client";

import { useState } from "react";
import { StatusPill, type Tone } from "@/components/primitives";
import { PanelEmpty, PanelFailed, PanelNote } from "./panel";
import { EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { appointmentStateLabel, isLiveBookingState } from "@/lib/dentally/appointment-state";
import { londonDateTimeLabelWithYear } from "@/lib/time/london";
import { cn } from "@/lib/utils";
import type { AppointmentRecord, ReadHealth } from "@/lib/dentally/read";

/**
 * The patient's whole appointment history, newest first.
 *
 * IT INCLUDES CANCELLATIONS AND DID-NOT-ATTENDS, which it previously did not. The
 * client defaults Dentally's `cancelled` filter to false, and the per-patient read
 * never overrode it, so a patient's own record hid every DNA and every cancellation.
 * A clinical record that hides a patient's did-not-attends is worse than no tab. The
 * read now opts in AND pages, so a long-standing patient's history is not silently
 * truncated at 100 rows either.
 *
 * The filter chips carry their counts because those counts are the point: "3 no-shows"
 * changes what the front desk offers this patient.
 */

// Tones and filters read the SHARED vocabulary, because this table had the same
// defect the record's figures did: it knew "booked" (the mock's word) and not
// "Confirmed", "Arrived" or "In surgery", so a real appointment rendered a raw
// lowercase "confirmed" pill and fell out of the Booked filter entirely.
const STATE_TONE: Record<string, Tone> = {
  booked: "info",
  pending: "info",
  confirmed: "info",
  arrived: "warning",
  in_surgery: "warning",
  completed: "success",
  did_not_attend: "danger",
  cancelled: "neutral",
};

type Segment = "all" | "booked" | "completed" | "cancelled" | "did_not_attend";

const SEGMENTS: { key: Segment; label: string }[] = [
  { key: "all", label: "All" },
  { key: "booked", label: "Booked" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
  { key: "did_not_attend", label: "Did not attend" },
];

/** "Booked" is every state that has not closed, so Confirmed and Arrived are in it. */
function inSegment(state: string, segment: Segment): boolean {
  if (segment === "all") return true;
  if (segment === "booked") return isLiveBookingState(state);
  return state === segment;
}

export function TabAppointments({
  appointments,
  reads,
}: {
  appointments: AppointmentRecord[];
  reads: ReadHealth;
}) {
  const [segment, setSegment] = useState<Segment>("all");

  if (reads.appointments === "failed") {
    // Category D. NOT "no appointments on record", which is what an empty list would
    // have said before the read-health flags existed.
    return <PanelFailed>{FAILED_COPY.appointments}</PanelFailed>;
  }

  const countFor = (key: Segment) =>
    key === "all" ? appointments.length : appointments.filter((a) => inSegment(a.state, key)).length;
  const rows = segment === "all" ? appointments : appointments.filter((a) => inSegment(a.state, segment));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter appointments">
        {SEGMENTS.map(({ key, label }) => {
          const active = segment === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={active}
              onClick={() => setSegment(key)}
              className={cn(
                "pressable rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                active
                  ? "border-navy bg-navy font-semibold text-white"
                  : "border-line-strong bg-card text-muted hover:text-navy",
              )}
            >
              {label}
              <span className={cn("ml-1.5 tabular-nums", active ? "text-white/70" : "text-faint")}>
                {countFor(key)}
              </span>
            </button>
          );
        })}
      </div>

      {appointments.length === 0 ? (
        <PanelEmpty>{EMPTY_COPY.appointments}</PanelEmpty>
      ) : rows.length === 0 ? (
        <PanelEmpty>No appointments in this state.</PanelEmpty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-1.5 text-[11px] font-medium text-faint">When</th>
                <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Mins</th>
                <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Reason</th>
                <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Practitioner</th>
                <th className="px-2 py-1.5 text-[11px] font-medium text-faint">Note</th>
                <th className="px-2 py-1.5 text-right text-[11px] font-medium text-faint">State</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-line last:border-0">
                  <td className="whitespace-nowrap px-2 py-2 tabular-nums text-navy">
                    {londonDateTimeLabelWithYear(a.start)}
                  </td>
                  <td className="px-2 py-2 tabular-nums text-muted">{a.durationMin}</td>
                  <td className="px-2 py-2 text-ink">{a.reason ?? "Appointment"}</td>
                  <td className="px-2 py-2 text-muted">{a.practitioner ?? "Not assigned"}</td>
                  {/* Whatever the receptionist typed on the booking. Absent renders
                      nothing at all, never an empty quoted line. */}
                  <td className="max-w-[280px] px-2 py-2 text-muted">{a.note ?? ""}</td>
                  <td className="px-2 py-2 text-right">
                    <StatusPill tone={STATE_TONE[a.state] ?? "neutral"}>
                      {appointmentStateLabel(a.state)}
                    </StatusPill>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PanelNote>
        Includes cancelled and did-not-attend appointments, which Dentally&apos;s API leaves out by default.
      </PanelNote>
    </div>
  );
}
