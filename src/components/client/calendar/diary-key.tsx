"use client";

import { Check, Clock } from "lucide-react";
import { stateLabel } from "./calendar-logic";
import { stateGlyph } from "./diary-view";
import { MIN_USEFUL_PIECE_MIN } from "@/lib/calendar/capacity";

// ---------------------------------------------------------------------------
// THE KEY: what every mark on this diary means, without hovering anything.
//
// The practice was trained on Dentally's own single-letter notation and named it
// verbatim: P pending, C confirmed, a clock arrived, S in surgery, a tick
// complete, plus a did-not-attend marker. All of those already RENDER
// (diary-view.ts STATE_GLYPHS), and the shapes are distinct. What was missing is
// the thing that makes a notation learnable: somewhere it is written down. A new
// receptionist meeting an "S" for the first time had no way to find out what it
// meant except to hover a block and read the tooltip, and a notation you have to
// hover is not a glanceable notation.
//
// A <details>, closed by default, so it costs one line of chrome when shut. This
// diary's whole density argument is that vertical space belongs to the grid.
//
// IT ALSO SAYS WHAT IS NOT HERE. Dentally's appointment feed carries a reason
// and a state; it carries no slot TYPE, so there is no such thing as an
// "emergency slot" to draw and none is invented. Saying so on screen is the
// honest answer to "I cannot see any emergency slots" — better than a plausible
// number nobody can trace to a source.
// ---------------------------------------------------------------------------

/**
 * The order the practice reads them in: the life of one appointment, in sequence.
 *
 * "booked" sits next to "confirmed" because that is what it is: the legacy word
 * this repo's own fixtures use where live Dentally says Confirmed, and
 * diary-view.ts gives it CONFIRMED_STYLE with its own letter B so it is never
 * silently relabelled. It EARNS a row here because it is DRAWN — measured on the
 * running mock, a B appears on roughly half the blocks in a week — and a mark on
 * the grid that is not in the key is a mark you can only learn by hovering,
 * which is the one thing this panel exists to stop. It will simply never fire
 * against a live Dentally account, which emits Pending / Confirmed / Arrived /
 * In surgery / Completed / Cancelled / Did not attend and nothing else.
 */
const STATE_ORDER = [
  "pending",
  "confirmed",
  "booked",
  "arrived",
  "in_surgery",
  "completed",
  "cancelled",
  "did_not_attend",
] as const;

function Mark({ state }: { state: string }) {
  const glyph = stateGlyph(state);
  const inSurgery = state === "in_surgery";
  return (
    <span
      aria-hidden
      className="flex h-[16px] min-w-[16px] shrink-0 items-center justify-center rounded-[2px] border border-line-strong px-[2px] leading-none"
      style={{
        // in_surgery inverts on the grid too: it is the one state meant to
        // shout, and at most one column is in surgery at a time.
        background: inSurgery ? "var(--navy)" : "var(--card)",
        color: inSurgery ? "#ffffff" : "var(--ink)",
      }}
    >
      {glyph === null ? null : glyph.kind === "text" ? (
        <span className={glyph.text === "DNA" ? "text-[8px] font-bold" : "text-[11px] font-bold"}>
          {glyph.text}
        </span>
      ) : glyph.kind === "clock" ? (
        <Clock size={10} strokeWidth={2.5} />
      ) : (
        <Check size={10} strokeWidth={3} />
      )}
    </span>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{children}</div>;
}

function Item({ mark, label }: { mark: React.ReactNode; label: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[10px] font-medium text-ink">
      {mark}
      {label}
    </span>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <span className="w-[86px] shrink-0 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted">
      {children}
    </span>
  );
}

/** A 3px funding rail, drawn at the size it appears on a block. */
function Rail({ colour }: { colour: string }) {
  return (
    <span
      aria-hidden
      className="h-[14px] w-[3px] shrink-0 rounded-[1px]"
      style={{ background: colour }}
    />
  );
}

/** A swatch of one of the three column textures. */
function Texture({ background, backgroundImage }: { background?: string; backgroundImage?: string }) {
  return (
    <span
      aria-hidden
      className="h-[14px] w-[18px] shrink-0 rounded-[2px] border border-line-strong"
      style={{ background, backgroundImage }}
    />
  );
}

export function DiaryKey() {
  return (
    <details className="relative shrink-0 rounded-md border border-line bg-card">
      <summary className="cursor-pointer list-none rounded-md px-2 py-[3px] text-[10px] font-semibold text-navy marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25">
        Key: what the marks mean
      </summary>
      {/* A POPOVER, not an expanding block. Opening a reference panel must not
          push the grid down the page: this diary's density argument is that
          vertical space belongs to the appointments, and a key that shoved
          everything down would be shut immediately and never opened again.
          Anchored to the right edge, where the summary sits. */}
      <div className="absolute right-[-1px] top-full z-30 mt-1 flex w-[min(92vw,880px)] flex-col gap-2 rounded-md border border-line-strong bg-card px-3 py-2 shadow-lg">
        <Row>
          <Heading>State</Heading>
          {STATE_ORDER.map((s) => (
            <Item key={s} mark={<Mark state={s} />} label={stateLabel(s)} />
          ))}
        </Row>

        <Row>
          <Heading>Funding</Heading>
          <Item mark={<Rail colour="var(--fund-nhs)" />} label="NHS" />
          <Item mark={<Rail colour="var(--fund-private)" />} label="Private" />
          <Item mark={<Rail colour="var(--fund-udc)" />} label="Urgent dental care" />
          <span className="text-[10px] font-medium text-muted">
            No rail means nothing is on file. Private is never assumed.
          </span>
        </Row>

        <Row>
          <Heading>Column</Heading>
          <Item mark={<Texture background="var(--card)" />} label="Working" />
          <Item mark={<Texture background="var(--diary-off)" />} label="Not working" />
          <Item
            mark={
              <Texture backgroundImage="repeating-linear-gradient(45deg, var(--card-muted) 0 6px, var(--line) 6px 8px)" />
            }
            label="We could not find out"
          />
        </Row>

        <Row>
          <Heading>On a block</Heading>
          <Item
            mark={
              <span
                aria-hidden
                className="h-[4px] w-[4px] shrink-0 rounded-full bg-ink"
              />
            }
            label="Something is typed on this booking"
          />
          <Item
            mark={<span aria-hidden className="h-[14px] w-[3px] shrink-0 bg-navy" />}
            label="A navy seam on the right edge means a double booking"
          />
        </Row>

        <p className="text-[10px] font-medium leading-[1.45] text-muted">
          <span className="font-semibold text-ink">Free time</span> in a column header is that
          clinician&rsquo;s working time with their appointments and breaks taken out, for this
          practice on this day. &ldquo;Longest&rdquo; is the biggest single unbroken run of it;
          anything under {MIN_USEFUL_PIECE_MIN} minutes is counted in the total but is never offered
          as a run. A column that cannot say who is working shows no figure at all rather than a
          zero.
        </p>
        <p className="text-[10px] font-medium leading-[1.45] text-muted">
          <span className="font-semibold text-ink">Emergency slots are not shown</span>, because
          Dentally&rsquo;s diary does not carry them. An appointment has a reason and a state, and
          no slot type, so nothing in the data marks a slot as held back for emergencies. The free
          runs above are the honest version of that question: they are real unbooked time, not a
          reservation.
        </p>
      </div>
    </details>
  );
}
