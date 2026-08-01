import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { relativeLabel } from "@/lib/time/relative";

/** Merge Tailwind classes safely (conditional + de-duped). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Format a number as GBP. Dentally / Vitality are UK, so default to GBP. */
export function gbp(value: number, opts: { decimals?: boolean } = {}) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: opts.decimals ? 2 : 0,
    maximumFractionDigits: opts.decimals ? 2 : 0,
  }).format(value);
}

/** Compact number, e.g. 1.2k. */
export function compact(value: number) {
  return new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Whole number with thousands separators (en-GB): 1234 -> "1,234". Use for any
 *  count shown to the user so figures stay readable past three digits. */
export function num(value: number) {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

/**
 * "3 min ago" style relative time from an ISO string, against a fixed reference.
 *
 * Delegates to lib/time/relative.ts, which is pure and tested. This used to stop at
 * days and had no future tense, so a recall due in three months read "just now" and
 * a two-year-old visit read "730 days ago". Every screen using this helper gets the
 * fuller units and the future tense for free.
 */
export function relativeTime(iso: string, now: Date) {
  return relativeLabel(iso, now);
}
