// ---------------------------------------------------------------------------
// VARIANT C, "Working surface": turning a figure into the work it implies.
//
// The thesis of this variant is that a dashboard figure is not only something to
// read. A debtor in ACCOUNTS is a patient to chase; a missed appointment in the
// donut is a slot to fill; an unpaid invoice is money to collect. Every one of
// those already has a page in this platform that does the job, so the figure
// links to it.
//
// Three rules are enforced here rather than in the components, because they are
// the ones that would quietly rot:
//
//   1. A destination must be a REAL module of this platform. The whitelist below
//      is the whole set, so a mistyped route is a type error rather than a 404
//      found by the practice manager.
//   2. Work is never claimed from a figure that could not be sourced. An
//      unavailable metric produces no work line at all, because "chase
//      Unavailable balances" is worse than saying nothing.
//   3. Zero is not work. A panel with nothing outstanding shows no line, so the
//      screen never invents a job to look busy.
//
// Nothing here triggers anything. Every work link is a NAVIGATION to the page
// that owns the job, where that page's own confirmation applies. The dashboard
// itself sends nothing, writes nothing and changes nothing.
//
// Pure functions: no I/O, no clock, no React.
// ---------------------------------------------------------------------------

import { formatPenceGbp } from "@/lib/dashboard/money";
import type { Metric } from "@/lib/dashboard/view";

/** Every module a figure on this screen may lead to, and how it is named there. */
export const WORK_MODULES = {
  patients: "Patients",
  payments: "Payments",
  "no-show-defence": "No-show defence",
  "treatment-coordinator": "Treatment Coordinator",
  calendar: "Calendar",
  "task-queue": "Task queue",
} as const;

export type WorkModule = keyof typeof WORK_MODULES;

/** The route of a module inside the client area. */
export function moduleHref(clientSlug: string, module: WorkModule): string {
  return `/c/${encodeURIComponent(clientSlug)}/${module}`;
}

/** One patient's record, which is where a name on this screen leads. */
export function patientHref(clientSlug: string, patientId: string): string {
  return `/c/${encodeURIComponent(clientSlug)}/patients?patient=${encodeURIComponent(patientId)}`;
}

/**
 * A figure turned into a job.
 *
 * `text` is what the line reads. `description` is the whole sentence, used as the
 * title and the accessible name, so what will happen is known BEFORE the click
 * rather than discovered after it.
 */
export interface WorkLink {
  module: WorkModule;
  href: string;
  destination: string;
  text: string;
  description: string;
}

function build(
  clientSlug: string,
  module: WorkModule,
  text: string,
  description: string,
): WorkLink {
  return {
    module,
    href: moduleHref(clientSlug, module),
    destination: WORK_MODULES[module],
    text,
    description,
  };
}

/** Whole numbers with thousands separators. The practice has five-digit counts. */
function count(value: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(value);
}

/**
 * Work measured in a COUNT of things: balances, missed appointments, open plans.
 *
 * Null when the figure could not be sourced, and null when it is zero or
 * negative. A negative would mean the arithmetic upstream is wrong, and inviting
 * somebody to chase minus four balances is not a useful thing to do about it.
 */
export function countWork(args: {
  clientSlug: string;
  module: WorkModule;
  metric: Metric;
  /** The verb the line opens with, e.g. "Chase". */
  verb: string;
  /** The thing being counted, singular then plural. */
  one: string;
  many: string;
}): WorkLink | null {
  const value = args.metric.value;
  if (value === null || value <= 0) return null;
  const noun = value === 1 ? args.one : args.many;
  const text = `${args.verb} ${count(value)} ${noun}`;
  const destination = WORK_MODULES[args.module];
  return build(
    args.clientSlug,
    args.module,
    text,
    `${text}. Opens ${destination}, where the work is done. Nothing is sent from this screen.`,
  );
}

/**
 * Work measured in MONEY: the unpaid balance on invoices raised in the period.
 *
 * Same contract as countWork. Pence rather than a count, so it reads as the sum
 * somebody is being asked to go and collect.
 */
export function moneyWork(args: {
  clientSlug: string;
  module: WorkModule;
  metric: Metric;
  verb: string;
  /** What the money is, e.g. "unpaid on invoices raised in this period". */
  trailing: string;
}): WorkLink | null {
  const value = args.metric.value;
  if (value === null || value <= 0) return null;
  const text = `${args.verb} ${formatPenceGbp(value)}`;
  const destination = WORK_MODULES[args.module];
  return build(
    args.clientSlug,
    args.module,
    text,
    `${text} ${args.trailing}. Opens ${destination}, where the work is done. Nothing is sent from this screen.`,
  );
}

/**
 * A slice's share of the whole, as a whole percent.
 *
 * A total of zero has no shares, and 0/0 must not render as NaN% on a panel read
 * at a glance, so it reports zero.
 */
export function sharePercent(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((value / total) * 100);
}
