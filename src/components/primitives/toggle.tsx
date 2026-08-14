"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ===========================================================================
// THE SWITCH PRIMITIVE.
//
// There were three private copies of this before it existed — one in the
// onboarding form builder, one in the systems kill-switch panel, one implied by
// every future settings screen — and they had already drifted on size, colour
// and whether they announced themselves to a screen reader at all. This is the
// one, extracted from the smallest of them and given the busy state the kill
// switch had.
//
// `role="switch"` + `aria-checked` + a real `aria-label`, because a permissions
// grid is a wall of unlabelled controls otherwise: the visible label is the
// column header, which a screen reader will not associate with the cell.
// ===========================================================================

export type ToggleSize = "sm" | "md" | "lg";
export type ToggleTone = "brand" | "success";

const TRACK: Record<ToggleSize, string> = {
  sm: "h-4 w-7",
  md: "h-5 w-9",
  lg: "h-6 w-11",
};

const KNOB: Record<ToggleSize, string> = {
  sm: "h-3 w-3",
  md: "h-3.5 w-3.5",
  lg: "h-5 w-5",
};

const KNOB_ON: Record<ToggleSize, string> = {
  sm: "translate-x-3.5",
  md: "translate-x-4",
  lg: "translate-x-[22px]",
};

const ON_TONE: Record<ToggleTone, string> = {
  brand: "border-blue-dark bg-blue-dark",
  success: "border-success bg-success",
};

export function Toggle({
  checked,
  onChange,
  label,
  size = "md",
  tone = "brand",
  busy = false,
  disabled = false,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Announced to assistive technology. Say what it controls, not "toggle". */
  label: string;
  size?: ToggleSize;
  tone?: ToggleTone;
  /** A write is in flight: the control is disabled and shows a spinner. */
  busy?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const locked = disabled || busy;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={locked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        // Disabled reads as "not yours to change", not as "off": the track keeps
        // its on/off colour and only loses contrast.
        locked && "cursor-not-allowed opacity-55",
        TRACK[size],
        checked ? ON_TONE[tone] : "border-line-strong bg-card-muted",
        className,
      )}
    >
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full bg-white shadow-sm transition-transform",
          KNOB[size],
          checked ? KNOB_ON[size] : "translate-x-0.5",
        )}
        aria-hidden
      >
        {busy ? <Loader2 size={size === "sm" ? 8 : 11} className="animate-spin text-muted" /> : null}
      </span>
    </button>
  );
}
