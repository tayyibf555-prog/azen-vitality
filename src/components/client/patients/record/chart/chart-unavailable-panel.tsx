import { CANNOT_READ_COPY, CHART_COPY } from "@/lib/patient/tabs";
import { canWriteChartToDentally } from "@/lib/charting/write-gate";
import { UnavailablePanel } from "../unavailable-panel";
import { DisabledControl } from "./disabled-control";

/**
 * WHAT DENTALLY'S CHARTING SCREEN HOLDS AND WE CANNOT READ, said in place, in
 * Dentally's own position, and never as an empty region.
 *
 * THE RULE THIS FILE EXISTS FOR. Dentally's API exposes NO periodontal data and NO
 * BPE scores of any kind, while Dentally's own charting screen HAS them. So a BPE or
 * perio region rendering as blank, empty or greyed-out tells a dentist "no findings
 * recorded" when the truth is "not available here", and that is a plausible
 * contributor to a missed diagnosis. Rendered, enabled, explicit, and NAMING
 * DENTALLY as the place to look. Never omitted, never a disabled button with no
 * explanation.
 *
 * IT COMPOSES UnavailablePanel rather than duplicating it, because the record already
 * has one shape for this sentence and two would drift in type scale and surface
 * within a release.
 *
 * IT DOES NOT LINK TO OUR OWN PERIO TAB. That tab cannot read perio either, so a link
 * there sends a clinician round a loop into a second unavailable panel. It names
 * Dentally, where the data actually is.
 *
 * NO WARNING COLOUR, ANYWHERE IN IT. A permanent property of the connection is not an
 * incident, and amber on a permanent condition trains people to ignore amber.
 *
 * NO "use client": no state and no handlers of its own beyond the close control it is
 * given.
 */
export type ChartPanelVariant = "bpe" | "images" | "gallery" | "socket";

export function ChartUnavailablePanel({
  variant,
  onClose,
}: {
  variant: ChartPanelVariant;
  onClose?: () => void;
}) {
  const spec = SPEC[variant];
  return (
    <div className="space-y-2">
      <UnavailablePanel
        title={spec.title}
        cannotRead={spec.cannotRead}
        willHold={spec.also ? <p>{spec.also}</p> : null}
      >
        {/* Dentally's own "Record New BPE / BEWE" lives here. It is RENDERED, and it
            is focusable, and it carries its reason as a sentence a keyboard user can
            reach: a disabled attribute would remove it from the tab order, hover on
            disabled controls is unreliable, and a title is not dependably announced.
            The gate is canWriteChartToDentally, which is false forever because
            Dentally publishes no create route on any charting resource. */}
        {variant === "bpe" && !canWriteChartToDentally() ? (
          <div className="pt-1">
            <DisabledControl
              id="chart-record-bpe"
              label="Record New BPE / BEWE"
              reason={CHART_COPY.writeBlockedTitle}
            />
          </div>
        ) : null}
      </UnavailablePanel>

      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          className="pressable rounded-md px-2 py-[3px] text-[11.5px] font-medium text-muted hover:text-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
        >
          Close
        </button>
      ) : null}
    </div>
  );
}

/**
 * Every sentence comes from the tested copy module. The titles are labels, not
 * claims, so they are the only words this file owns.
 *
 * "bpe" renders bpe AND perioOnChart together, which is what finally gives
 * perioOnChart a renderer: an earlier draft added it to a tested copy module and put
 * it on no screen at all, which is a green test and an invisible sentence.
 */
const SPEC: Record<ChartPanelVariant, { title: string; cannotRead: string; also: string | null }> = {
  bpe: {
    title: "BPE and periodontal",
    cannotRead: CANNOT_READ_COPY.bpe,
    also: CANNOT_READ_COPY.perioOnChart,
  },
  images: {
    title: "Images",
    cannotRead: CANNOT_READ_COPY.chartImages,
    also: null,
  },
  gallery: {
    title: "Cloud gallery",
    cannotRead: CANNOT_READ_COPY.cloudGallery,
    also: null,
  },
  // What the crown itself opens. Dentally's own recommended route for tooth status is
  // the socket selection menu, and that is exactly the thing we cannot read, so the
  // crown is where a Dentally user's cursor goes and where the sentence has to be.
  socket: {
    title: "Tooth status and base chart",
    cannotRead: CANNOT_READ_COPY.toothStatus,
    also: CANNOT_READ_COPY.baseChartStatus,
  },
};
