"use client";

import { Coffee, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { entrySentence, type DiaryEntryRecord } from "@/lib/calendar/entries";
import { blockEdges, type Zoom } from "./diary-view";

// ---------------------------------------------------------------------------
// A break or a note on the diary.
//
// THESE ARE OUR RECORDS, NOT DENTALLY'S. Dentally exposes no endpoint for
// breaks, blocked time or diary notes, so nothing here mirrors it; they live in
// public.diary_entry.
//
// A break must be IMPOSSIBLE to mistake for a patient appointment. Five
// simultaneous differences, and the first two are STRUCTURAL rather than
// decorative, so they survive a CSS regression that a colour choice would not:
//
//   1. It is not in the appointments <ul>. It lives in a sibling
//      <ul aria-label="Breaks and notes"> painted BENEATH it (diary-day.tsx), so
//      an appointment always wins the z-order and a break can never hide a patient.
//   2. It is NEVER type-coloured. There is no code path here that can reach a
//      --type-N-fill.
//   3. An icon stands where an appointment's state glyph would be.
//   4. Its text is ITALIC and --muted. Nothing else on the entire grid is italic.
//   5. No patient name is ever drawn, and its accessible sentence LEADS with the
//      kind ("Break. 13:00 to 14:00, 60 minutes. Lunch. Femi Osei."), so a screen
//      reader cannot hear it as a booking either.
//
// Entries never reach dayCounts: a break is not an appointment, so the header
// counts and the caption are unchanged by them.
// ---------------------------------------------------------------------------

export function entryDomId(entryId: string): string {
  return `diary-entry-${entryId}`;
}

export function DiaryEntryBlock({
  entry,
  boundsStartMin,
  boundsEndMin,
  zoom,
  clinicianName,
  onOpen,
}: {
  entry: DiaryEntryRecord;
  boundsStartMin: number;
  boundsEndMin: number;
  zoom: Zoom;
  clinicianName: string | null;
  onOpen?: (entry: DiaryEntryRecord) => void;
}) {
  const drawnEndMin = Math.min(entry.endMin, boundsEndMin);
  const { top, height } = blockEdges(entry.startMin, drawnEndMin, boundsStartMin, zoom);
  if (height <= 0) return null;

  const isBreak = entry.kind === "break";
  const sentence = entrySentence(entry, clinicianName);
  // A break gets a DASHED left rail rather than a solid state spine, because a
  // solid 3px spine is the appointment grammar and must not be borrowed.
  const border = isBreak
    ? {
        background: "var(--card-muted)",
        borderColor: "var(--line-strong)",
        borderLeft: "3px dashed var(--line-strong)",
      }
    : { background: "var(--band)", borderColor: "var(--band-line)" };

  const Icon = isBreak ? Coffee : Info;

  return (
    <li className="absolute inset-x-0" style={{ top, height }}>
      <button
        type="button"
        id={entryDomId(entry.id)}
        onClick={onOpen ? () => onOpen(entry) : undefined}
        disabled={!onOpen}
        title={`${isBreak ? "Break" : "Note"}: ${entry.title}`}
        className={cn(
          "absolute inset-y-0 left-[1px] right-[1px] overflow-hidden rounded-[4px] border border-solid pl-[6px] pr-[16px] pt-[2px] text-left",
          "focus-visible:[outline:2px_solid_var(--navy)] focus-visible:[outline-offset:-2px]",
          onOpen ? "cursor-pointer" : "cursor-default",
        )}
        style={border}
      >
        <span aria-hidden className="absolute right-[3px] top-[2px] text-muted">
          <Icon size={10} strokeWidth={2} />
        </span>
        {/* Italic and muted: the one italic surface on the whole grid. */}
        <span
          aria-hidden
          className="block truncate text-[9.5px] font-medium italic leading-[1.2] text-muted"
        >
          {entry.title}
        </span>
        {height >= 26 && entry.body ? (
          <span
            aria-hidden
            className="text-[9px] font-normal italic leading-[1.2] text-faint"
            style={{
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: 2,
              overflow: "hidden",
            }}
          >
            {entry.body}
          </span>
        ) : null}
        <span className="sr-only">{sentence}</span>
      </button>
    </li>
  );
}
