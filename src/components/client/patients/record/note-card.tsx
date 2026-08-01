"use client";

import { useEffect, useRef, useState } from "react";
import { EyeOff, Loader2, Mic, Palette, Pencil, Pin, PinOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { relativeLabel } from "@/lib/time/relative";
import { londonDateTimeLabel } from "@/lib/time/london";
import { NOTE_COLOUR_HEX, NOTE_TINT_ALPHA, effectiveColour, tintFrom, type NoteColour } from "@/lib/patient-notes/colours";
import type { PatientNote } from "@/lib/patient-notes/types";
import { ColourSwatches } from "./colour-swatches";

/**
 * One practice note, as a card.
 *
 * DENTALLY'S METAPHOR IS KEPT, DELIBERATELY. Coloured cards, an author, an age, a
 * Hide control, a pin. The owner's first verdict on the reference was that it looked
 * bad, and then he corrected the premise himself: that patient carried five pinned
 * notes at once, and ours will not. The shape is not the problem, so the shape stays.
 * Fifty people move off Dentally in one week and every component they do not have to
 * relearn is a week of goodwill.
 *
 * THE ONE EXECUTION CHANGE. Dentally fills the whole card with a saturated sticky
 * colour, which is exactly what makes five of them shout. Ours is a white card with a
 * hairline border and a 10px radius, a 3px rail of the user's colour down the left
 * edge, and a 6% tint of the same hue behind it. Scannable at a glance from across a
 * room; never a wash.
 *
 * The controls sit top-right and appear on hover, on focus-within, and always on a
 * touch device (where there is no hover to reveal them). Each is a real button with an
 * aria-label and a focus-visible ring, because a clinical note must be pinnable from
 * the keyboard.
 */

const CONTROL =
  "flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-navy/[0.06] hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:opacity-40";

export function NoteCard({
  note,
  now,
  variant,
  clampLines = 3,
  busy = false,
  onPin,
  onColour,
  onSaveBody,
  onHide,
}: {
  note: PatientNote;
  now: Date;
  /** "band" is the pinned strip at the top of the record; "list" is the Notes tab. */
  variant: "band" | "list";
  clampLines?: 2 | 3;
  busy?: boolean;
  onPin: (pinned: boolean) => void;
  onColour: (colour: NoteColour | null) => void;
  onSaveBody: (body: string) => Promise<boolean>;
  /** Band only. Hide is per-reader and lasts for the session; see pinned-notes-band. */
  onHide?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const bodyRef = useRef<HTMLParagraphElement | null>(null);

  const colour = effectiveColour(note);
  const pinned = Boolean(note.pinnedAt);

  // Is the clamped body actually cut off? Measured rather than guessed from a
  // character count, because a note of three short lines must not offer a "More" that
  // reveals nothing.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const check = () => setOverflowing(el.scrollHeight - el.clientHeight > 1);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [note.body, clampLines, expanded, variant]);

  async function save() {
    const text = draft.trim();
    if (!text || text === note.body) {
      setEditing(false);
      return;
    }
    const ok = await onSaveBody(text);
    if (ok) setEditing(false);
  }

  const clampStyle: React.CSSProperties = expanded
    ? {}
    : {
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: clampLines,
        overflow: "hidden",
      } as React.CSSProperties;

  return (
    <article
      className={cn(
        "group relative rounded-[10px] border border-line bg-card",
        variant === "band" ? "px-3 py-2.5" : "px-3.5 py-2.5",
        busy && "opacity-60",
      )}
      style={
        colour
          ? {
              borderLeft: `3px solid ${NOTE_COLOUR_HEX[colour]}`,
              backgroundColor: tintFrom(NOTE_COLOUR_HEX[colour], NOTE_TINT_ALPHA),
            }
          : undefined
      }
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              {note.canEdit ? (
                <>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    rows={3}
                    aria-label="Note text"
                    className="w-full resize-y rounded-lg border border-line bg-card px-2.5 py-1.5 text-[13.5px] leading-[1.45] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={save}
                      disabled={busy}
                      className="rounded-lg bg-blue-dark px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-blue-dark/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(note.body);
                        setEditing(false);
                      }}
                      className="rounded-lg border border-line-strong px-2.5 py-1 text-[12px] font-medium text-navy transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p className="whitespace-pre-wrap text-[13.5px] leading-[1.45] text-ink">{note.body}</p>
                  {/* Said plainly rather than by a greyed-out control, because the
                      rule is a clinical one, not a permission accident. */}
                  <p className="text-[11px] leading-[1.45] text-faint">
                    A note can be corrected by its author for 15 minutes. After that, add a new note rather than
                    changing this one.
                  </p>
                </>
              )}
              <ColourSwatches value={note.colour} onChange={onColour} disabled={busy} />
            </div>
          ) : (
            <>
              <p
                ref={bodyRef}
                style={clampStyle}
                className="whitespace-pre-wrap text-[13.5px] leading-[1.45] text-ink"
              >
                {note.body}
              </p>
              {overflowing || expanded ? (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="mt-0.5 rounded text-[11px] font-medium text-blue-dark underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30"
                >
                  {expanded ? "Less" : "More"}
                </button>
              ) : null}
            </>
          )}

          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] leading-[1.4] text-muted">
            {note.source === "voice" ? <Mic size={10.5} className="shrink-0" aria-label="Dictated" /> : null}
            <span className="truncate">{note.authorName}</span>
            <span aria-hidden>·</span>
            {/* Dentally's own foot line reads "4 years ago", so ours does too. The
                exact Europe/London stamp is one hover away rather than spent on a
                line that is read a hundred times a day. */}
            <span title={londonDateTimeLabel(note.createdAt)}>{relativeLabel(note.createdAt, now)}</span>
            {note.updatedAt ? (
              <>
                <span aria-hidden>·</span>
                <span title={`Corrected by ${note.editedBy ?? "the author"} on ${londonDateTimeLabel(note.updatedAt)}`}>
                  edited
                </span>
              </>
            ) : null}
            {variant === "list" && pinned ? (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1 font-medium text-navy">
                  <Pin size={10} className="shrink-0" aria-hidden /> Pinned
                </span>
              </>
            ) : null}
          </p>
        </div>

        {/* ALWAYS VISIBLE. These were opacity-0 until the pointer entered the card, so
            with the mouse anywhere else on screen a pinned note showed body, author and
            age only. Dentally's card carries the Hide button, the pencil and the pin
            visibly on every card, and PRODUCT.md rejects "clean" reductions that hide
            information behind a click. They rest at 60% and come to full strength on
            hover or focus, which keeps them quiet without making them a secret. The
            busy spinner lives in here too, and was invisible on a keyboard save. */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
          {busy ? <Loader2 size={13} className="mr-0.5 animate-spin text-muted" aria-label="Saving" /> : null}
          <button
            type="button"
            onClick={() => onPin(!pinned)}
            disabled={busy}
            aria-label={pinned ? "Unpin this note" : "Pin this note to the top of the record"}
            title={pinned ? "Unpin" : "Pin"}
            className={cn(CONTROL, pinned && "text-navy")}
          >
            {pinned ? <PinOff size={13.5} /> : <Pin size={13.5} />}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(note.body);
              setEditing((v) => !v);
            }}
            disabled={busy}
            aria-label={note.canEdit ? "Edit this note" : "Change this note's colour"}
            title={note.canEdit ? "Edit" : "Colour"}
            aria-expanded={editing}
            className={CONTROL}
          >
            {note.canEdit ? <Pencil size={13} /> : <Palette size={13} />}
          </button>
          {onHide ? (
            <button
              type="button"
              onClick={onHide}
              aria-label="Hide this note for now"
              title="Hide"
              className={CONTROL}
            >
              <EyeOff size={13.5} />
            </button>
          ) : null}
        </div>
      </div>
    </article>
  );
}
