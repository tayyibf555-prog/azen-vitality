import { CloudUpload, Grid2x2, History, Images, Settings, Stethoscope } from "lucide-react";
import { StatusPill } from "@/components/primitives";
import { CANNOT_READ_COPY } from "@/lib/patient/tabs";
import { cn } from "@/lib/utils";
import type { ChartPanelVariant } from "./chart-unavailable-panel";

/**
 * THE BOTTOM-RIGHT CONTROL CLUSTER, in the reference's own order: Cloud Gallery,
 * Images, BPE, History, Base Chart, cog.
 *
 * ONE CONNECTED GROUP, NOT SIX FLOATING CHIPS. Dentally draws these as a single
 * segmented bar with hairline dividers, and that is not decoration: a connected bar
 * says "these six belong together and none of them is the primary action here", which
 * is exactly true, while six separately-bordered pills read as six independent
 * decisions and pull the eye off the arch, which is the thing on this screen anyone
 * actually came to read.
 *
 * THEY ARE BIGGER THAN THEY WERE, BY DELIBERATION. The owner's verdict on the first
 * pass was "you make everything small it should be bigger", and it applies here as
 * much as to the arch: a clinician reads this screen from a metre away across a
 * surgery, not from a laptop keyboard. 11.5px text on a 22px button is legible at
 * desk distance and gone at surgery distance. 13px on a 36px row is not a taste
 * preference, it is the size at which the cluster survives the room it is used in.
 * DENTALLY.md's MEASURED GEOMETRY table is the authority for the arch; this row is
 * sized to sit under an arch built to those numbers without looking like a footnote.
 *
 * ALL SIX ARE PRESENT AND ALL SIX ARE ENABLED. Not one of them is a dead disabled
 * button. Three of them open a panel that states plainly what Dentally holds there
 * and we cannot read; three of them do real work.
 *
 * THE BPE CONTROL IS THE CLINICAL-SAFETY CONTROL OF THIS FILE.
 *
 * Dentally puts a SOLID RED DOT on BPE when a BPE is due, and a Dentally user's eye
 * has been trained for years to check that exact position. So the dot is built, in
 * that exact position, and it renders red and solid the day something can tell this
 * component a BPE is due — see `bpeDue`.
 *
 * WHAT IT NEVER DOES IS GUESS. `bpeDue` is optional and nothing passes it today,
 * because Dentally exposes no BPE data at all through the connection we have
 * (CANNOT_READ_COPY.bpe). Undefined means NOT KNOWN and draws no dot, because a red
 * dot we invented is a fake alert and a quiet grey dot in that trained position reads
 * as "checked, nothing due" - which is a claim, and a false one.
 *
 * AND THE DOT IS NEVER THE EXPLANATION, WHICH IS WHY THE PILL STAYS. A colour alone
 * cannot say why. The labelled neutral pill reading "BPE not read" sits alongside the
 * group, in words, visible in the default state of the screen without a click. That
 * is exactly what patient-record-header.tsx does with "Medical history not read", and
 * it is the precedent this cluster follows. Dot and pill are complements: the dot is
 * the alert channel, the pill is the honesty channel, and neither replaces the other.
 *
 * WHERE THE ROUND BLUE + IS. Not here, on purpose. DENTALLY.md puts it "bottom left",
 * attached to the plan strip it creates a tab in, and it already lives in
 * plan-tabs.tsx behind the write gate with its own rendered explanation. The workspace
 * lays that strip and this cluster out as ONE row with justify-between, so the
 * composed row already reads "+ at the far left ... controls right-aligned". Adding a
 * second + here would put two write controls on one row and duplicate the DOM id its
 * aria-describedby points at, which would break the explanation for a screen reader.
 *
 * BASE CHART IS A MODE, NOT A FILTER. The reference says the left list changes
 * context in base-chart mode, so this toggles the mode and the panel and the arch
 * both follow. aria-pressed says which state it is in.
 *
 * THE COG RENDERS NO MENU OF ITS OWN. It calls onOpenPreferences, which opens the ONE
 * preferences menu that the treatment panel's chevron also opens. Two owners each
 * writing a menu is two menus that drift.
 *
 * NO "use client": rendered from chart-workspace.tsx, which owns the boundary.
 */

/**
 * The BPE marker's words, from the tested copy module and NOT from this file.
 * It sits beside CANNOT_READ_COPY.medicalHistoryFlag, whose shape it copies, so
 * the copy sweep covers it like every other honesty sentence in the record.
 */
const BPE_FLAG = CANNOT_READ_COPY.bpeFlag;

export function ChartTools({
  baseMode,
  historyOpen,
  bpeDue,
  onOpenPanel,
  onToggleBase,
  onToggleHistory,
  onOpenPreferences,
}: {
  baseMode: boolean;
  historyOpen: boolean;
  /**
   * TRUE means a BPE is DUE and draws Dentally's solid red dot. UNDEFINED means NOT
   * KNOWN and draws nothing, which is the only honest state today: no caller passes
   * this, because no read we have returns BPE. Deliberately optional so the day a BPE
   * source exists it is one prop away, and so nobody is tempted to pass `false` -
   * false is a positive claim that none is due, and we cannot make it.
   */
  bpeDue?: boolean;
  onOpenPanel: (variant: ChartPanelVariant) => void;
  onToggleBase: () => void;
  onToggleHistory: () => void;
  onOpenPreferences: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
      {/* The words, beside the group and not inside it: this is an explanation, not a
          seventh control, and putting it in the segmented bar would make it look like
          one. It stays on the same line so the reader meets it and the BPE button in
          the same glance. */}
      <StatusPill tone="neutral" className="px-2.5 py-[4px] text-[12px]">
        {BPE_FLAG}
      </StatusPill>

      <div className="inline-flex items-stretch overflow-hidden rounded-lg border border-line-strong bg-card shadow-chip">
        <ToolBtn label="Cloud Gallery" onClick={() => onOpenPanel("gallery")}>
          <CloudUpload size={17} aria-hidden />
        </ToolBtn>
        <ToolBtn label="Images" onClick={() => onOpenPanel("images")}>
          <Images size={17} aria-hidden />
        </ToolBtn>
        <ToolBtn label="BPE" dot={bpeDue === true} onClick={() => onOpenPanel("bpe")}>
          <Stethoscope size={17} aria-hidden />
        </ToolBtn>
        <ToolBtn label="History" active={historyOpen} onClick={onToggleHistory}>
          <History size={17} aria-hidden />
        </ToolBtn>
        <ToolBtn label="Base Chart" active={baseMode} onClick={onToggleBase}>
          <Grid2x2 size={17} aria-hidden />
        </ToolBtn>
        <ToolBtn label="Chart preferences" iconOnly onClick={onOpenPreferences}>
          <Settings size={17} aria-hidden />
        </ToolBtn>
      </div>
    </div>
  );
}

/**
 * One segment of the bar. Icon AND word, because an icon-only row of six is a row of
 * six guesses; only the cog is icon-only, and that one is a convention every user of
 * every application already reads.
 *
 * The divider is a left border on every segment but the first, so the group is drawn
 * by the segments themselves and there is no separator element to fall out of step
 * when one of them is reordered.
 */
function ToolBtn({
  label,
  active,
  iconOnly,
  dot,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  iconOnly?: boolean;
  /** Dentally's solid red "one is due" marker. Only ever passed a known true. */
  dot?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active === undefined ? undefined : active}
      aria-label={iconOnly ? label : undefined}
      title={label}
      className={cn(
        "pressable relative inline-flex h-9 items-center gap-2 border-l border-line text-[13px] font-medium transition-colors first:border-l-0",
        iconOnly ? "px-3" : "px-3.5",
        // ring-inset, not an outer ring: an outer ring on a segment inside an
        // overflow-hidden group is clipped on three sides and reads as a broken edge.
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-navy/30",
        active ? "bg-navy text-white" : "bg-card text-muted hover:bg-card-muted hover:text-navy",
      )}
    >
      <span className="relative inline-flex">
        {children}
        {dot ? (
          // Solid, red, and RINGED so it survives on both the resting and the active
          // fill. aria-hidden because the alert is spoken by the sentence beside the
          // group, never by a colour.
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-[9px] rounded-full bg-danger ring-2 ring-card"
          />
        ) : null}
      </span>
      {iconOnly ? null : <span>{label}</span>}
    </button>
  );
}
