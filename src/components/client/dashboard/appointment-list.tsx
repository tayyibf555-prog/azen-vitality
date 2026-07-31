"use client";

import Link from "next/link";
import { useMemo } from "react";
import { StatusPill } from "@/components/primitives";
import { PERIOD_LABELS, type DashboardPeriod } from "@/lib/dashboard/period";
import type { AppointmentRow, PractitionerRef, SiteRef } from "@/lib/dashboard/view";
import { cn, num } from "@/lib/utils";
import { Footnote } from "./parts";

// ---------------------------------------------------------------------------
// The appointment list: the full-width panel under the band, with the three
// filters above it she already uses (a person, a status, and a site).
//
// Row order, left to right, is hers: the type bar, the time and its length, the
// patient, the reason with whatever the receptionist typed under it, the
// clinician and their site, then the state.
//
// Two things about state, both deliberate:
//   - A finished appointment gets a quiet dot and muted text, not a pill. Pills
//     are for rows that still need something doing, which is the house rule and
//     also the reason the default filter is "remaining to be completed".
//   - The state is never re-worded. Dentally's vocabulary is what the practice
//     trained on, so a row says what Dentally says it says.
// ---------------------------------------------------------------------------

export type StatusFilter = "remaining" | "all" | "completed" | "cancelled" | "dna";

const STATUS_LABELS: Record<StatusFilter, string> = {
  remaining: "Appointments remaining to be completed",
  all: "All appointments",
  completed: "Completed",
  cancelled: "Cancelled",
  dna: "Did not attend",
};

/**
 * The appointment type bar.
 *
 * The practice configures its own type colours in Dentally and the API does not
 * hand them over, so nothing here claims to be her colours. It is a stable,
 * restrained mark drawn from the existing blue family: same type, same bar,
 * every day. The reason itself is written on the row, so the bar reinforces and
 * never carries the meaning on its own.
 */
const TYPE_BARS = [
  "var(--navy)",
  "var(--blue-royal)",
  "var(--blue-dark)",
  "var(--blue-light)",
  "var(--blue-deep)",
  "var(--line-strong)",
] as const;

function typeBarColour(typeKey: string): string {
  let h = 2_166_136_261;
  for (let i = 0; i < typeKey.length; i += 1) {
    h ^= typeKey.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return TYPE_BARS[(h >>> 0) % TYPE_BARS.length];
}

/**
 * Confirmed reads green and pending amber, as it does in Dentally.
 *
 * One state, one colour, across the product: amber means "awaiting confirmation"
 * and nothing else, so cancelled takes the neutral tone rather than warning (on
 * the diary an amber cancelled block would be the loudest thing on the screen and
 * would read as pending from two metres); and green means "confirmed" and nothing
 * else, so the completed quiet dot is the muted grey.
 */
function statePill(row: AppointmentRow): { tone: "success" | "warning" | "danger" | "info" | "neutral"; quiet: false } | { quiet: true; dot: string } {
  const key = row.state.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (row.bucket === "completed") return { quiet: true, dot: "bg-muted" };
  if (row.bucket === "dna") return { tone: "danger", quiet: false };
  if (row.bucket === "cancelled") return { tone: "neutral", quiet: false };
  if (key === "confirmed") return { tone: "success", quiet: false };
  if (key === "arrived" || key === "checked_in" || key === "in_surgery" || key === "in_treatment") {
    return { tone: "info", quiet: false };
  }
  return { tone: "warning", quiet: false };
}

function Filters({
  practitioners,
  practitionerId,
  onPractitionerChange,
  status,
  onStatusChange,
  sites,
  siteId,
  onSiteChange,
}: {
  practitioners: PractitionerRef[];
  practitionerId: string | null;
  onPractitionerChange: (id: string | null) => void;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  sites: SiteRef[];
  siteId: string | null;
  onSiteChange: (id: string | null) => void;
}) {
  const select =
    "rounded-md border border-line bg-card px-2 py-[2px] text-[11px] font-medium text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25";
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
      <label className="sr-only" htmlFor="appt-person">
        Filter by person
      </label>
      <select
        id="appt-person"
        className={select}
        value={practitionerId ?? ""}
        onChange={(event) => onPractitionerChange(event.target.value || null)}
      >
        <option value="">Everyone</option>
        {practitioners.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <label className="sr-only" htmlFor="appt-status">
        Filter by status
      </label>
      <select
        id="appt-status"
        className={select}
        value={status}
        onChange={(event) => onStatusChange(event.target.value as StatusFilter)}
      >
        {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((key) => (
          <option key={key} value={key}>
            {STATUS_LABELS[key]}
          </option>
        ))}
      </select>

      <div className="ml-auto flex items-center gap-2">
        <label className="sr-only" htmlFor="appt-site">
          Filter by site
        </label>
        <select
          id="appt-site"
          className={select}
          value={siteId ?? ""}
          onChange={(event) => onSiteChange(event.target.value || null)}
        >
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function Row({ row, showDay, clientSlug }: { row: AppointmentRow; showDay: boolean; clientSlug: string }) {
  const pill = statePill(row);
  // The reason and whatever the receptionist typed share ONE line, so every row
  // is the same height and the list scans as a column of times. Neither is
  // shortened: the full text is on the row's title for anything that truncates.
  const reason = row.reason ?? "No reason recorded";
  const second = row.note ? `${reason} · ${row.note}` : reason;
  return (
    <li className="flex items-center gap-2.5 py-[4px]">
      <span
        aria-hidden
        className="h-[26px] w-[3px] shrink-0 rounded-full"
        style={{ background: typeBarColour(row.typeKey) }}
      />

      <span className="w-[76px] shrink-0">
        {showDay ? (
          <span className="block text-[10px] font-medium leading-[1.15] text-faint">{row.dayLabel}</span>
        ) : null}
        <span className="block text-[12.5px] font-bold leading-[1.2] tabular-nums tracking-[-0.2px] text-navy">
          {row.time}
          {row.durationMin === null ? null : (
            <span className="ml-1 text-[10px] font-medium text-faint">({row.durationMin})</span>
          )}
        </span>
      </span>

      <span
        aria-hidden
        className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full bg-card-muted text-[9px] font-semibold text-navy"
      >
        {row.initials}
      </span>

      <span className="min-w-0 flex-1">
        {row.patientId === null ? (
          <span className="block truncate text-[12.5px] font-semibold leading-[1.2] text-navy">
            {row.patientName}
          </span>
        ) : (
          <Link
            href={`/c/${clientSlug}/patients?patient=${encodeURIComponent(row.patientId)}`}
            className="block truncate text-[12.5px] font-semibold leading-[1.2] text-blue-deep underline-offset-2 hover:underline"
          >
            {row.patientName}
          </Link>
        )}
        <span title={second} className="block truncate text-[11px] font-medium leading-[1.25] text-muted">
          {second}
        </span>
      </span>

      <span className="hidden w-[150px] shrink-0 sm:block">
        <span className="block truncate text-[11px] font-medium leading-[1.2] text-navy">
          {row.practitionerName ?? "Not assigned"}
        </span>
        <span className="block truncate text-[10px] font-normal leading-[1.25] text-faint">
          {row.siteName ?? "Site unknown"}
        </span>
      </span>

      <span className="w-[100px] shrink-0 text-right">
        {pill.quiet ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted">
            <i aria-hidden className={cn("inline-block h-[6px] w-[6px] rounded-full", pill.dot)} />
            {row.stateLabel}
          </span>
        ) : (
          <StatusPill tone={pill.tone}>{row.stateLabel}</StatusPill>
        )}
      </span>
    </li>
  );
}

export function AppointmentListPanel({
  rows,
  period,
  window,
  clientSlug,
  practitioners,
  practitionerId,
  onPractitionerChange,
  status,
  onStatusChange,
  sites,
  siteId,
  onSiteChange,
  capped,
  totalInWindow,
}: {
  rows: AppointmentRow[];
  period: DashboardPeriod;
  window: { from: string; to: string };
  clientSlug: string;
  practitioners: PractitionerRef[];
  practitionerId: string | null;
  onPractitionerChange: (id: string | null) => void;
  status: StatusFilter;
  onStatusChange: (status: StatusFilter) => void;
  sites: SiteRef[];
  siteId: string | null;
  onSiteChange: (id: string | null) => void;
  capped: boolean;
  totalInWindow: number;
}) {
  const multiDay = window.from !== window.to;

  const visible = useMemo(() => {
    return rows.filter((row) => {
      if (row.day < window.from || row.day > window.to) return false;
      if (siteId !== null && row.siteId !== siteId) return false;
      if (practitionerId !== null && row.practitionerId !== practitionerId) return false;
      if (status === "all") return true;
      if (status === "remaining") return row.remaining;
      return row.bucket === status;
    });
  }, [rows, window.from, window.to, siteId, practitionerId, status]);

  return (
    <section aria-label="Appointments list">
      <div className="flex flex-col gap-1 border-b border-line pb-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">
            Appointments
          </h2>
          <span className="text-[10px] font-medium text-faint">
            {PERIOD_LABELS[period]} · {num(visible.length)} shown
          </span>
        </div>
        <Filters
          practitioners={practitioners}
          practitionerId={practitionerId}
          onPractitionerChange={onPractitionerChange}
          status={status}
          onStatusChange={onStatusChange}
          sites={sites}
          siteId={siteId}
          onSiteChange={onSiteChange}
        />
      </div>

      {visible.length === 0 ? (
        <p className="pt-3 text-[11px] font-medium text-muted">
          No appointment matches these filters in this period.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((row) => (
            <Row key={row.id} row={row} showDay={multiDay} clientSlug={clientSlug} />
          ))}
        </ul>
      )}

      {capped ? (
        <Footnote>
          The list holds the most recent {num(rows.length)} of {num(totalInWindow)} appointments in the
          ninety day scan, newest first, so today and yesterday are always complete. Older ones are not
          shown here.
        </Footnote>
      ) : null}
    </section>
  );
}
