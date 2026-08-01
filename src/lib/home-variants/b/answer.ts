// ---------------------------------------------------------------------------
// VARIANT B, "Answer first": the derived line that leads the Overview screen.
//
// A practice manager opening this screen is asking one question: is the period
// she is looking at all right? Dentally makes her assemble that answer from four
// panels. This file assembles it once, from the same figures the panels render,
// and the panels then sit underneath it unchanged as the evidence.
//
// THREE RULES, and they are the whole design:
//
//   1. DERIVED, NEVER DECORATIVE. Every word out of here is computed from a
//      figure that is on the screen below. There is no score, no grade, no
//      traffic light and no encouragement. If a clause appears, a manager can
//      point at the panel it came from.
//
//   2. NEVER CHEERFUL. "All good" is not an answer, it is a mood. When nothing
//      needs attention the line says WHICH checks were run and came back empty,
//      so the reader can tell the difference between a quiet day and a check
//      that never ran.
//
//   3. HONEST WHEN IT CANNOT ANSWER. A figure that could not be sourced does not
//      become a zero and does not quietly vanish from the arithmetic: it becomes
//      a limit, printed with the headline, and `confident` goes false when there
//      is nothing left to stand a statement on.
//
// Pure: no React, no clock reads, no I/O. The caller passes the same view model
// the panels render, so the line can never disagree with the evidence below it.
// ---------------------------------------------------------------------------

import { formatPenceGbp } from "@/lib/dashboard/money";
import type { DashboardPeriod } from "@/lib/dashboard/period";
import type { PeriodPanels, ScopeView } from "@/lib/dashboard/view";

/** The ids the panels carry, so a clause can jump to the figure it came from. */
export const PANEL_ANCHOR = {
  takings: "b-takings",
  appointments: "b-appointments",
  accounts: "b-accounts",
  invoiced: "b-invoiced",
  counts: "b-counts",
} as const;

export type PanelAnchor = (typeof PANEL_ANCHOR)[keyof typeof PANEL_ANCHOR];

/** How loudly a clause reads. "attention" is work; "plain" is context. */
export type ClauseTone = "attention" | "plain";

export interface AnswerClause {
  /** Stable key for the list. */
  id: string;
  /** A short noun phrase: "8 did not attend", "£1,240.00 invoiced and unpaid". */
  text: string;
  tone: ClauseTone;
  /** The panel this clause was read from, or null when it spans several. */
  anchor: PanelAnchor | null;
}

export interface Answer {
  /** One sentence of figures: what the selected period actually is. */
  headline: string;
  /** Attention first, context after. Empty only when nothing could be checked. */
  clauses: AnswerClause[];
  /** What could not be established, in full sentences. Never trimmed away. */
  limits: string[];
  /** False when too little could be read to make any statement at all. */
  confident: boolean;
}

export interface AnswerInput {
  period: DashboardPeriod;
  /** The selected site, or the whole group. */
  scope: ScopeView;
  /** The selected period's panels, as rendered below the line. */
  panels: PeriodPanels;
  /** Payment rows the normaliser could not read at all, across the whole view. */
  droppedPayments: number;
}

/** How each period reads inside a sentence. */
const PERIOD_PHRASE: Record<DashboardPeriod, string> = {
  today: "today",
  yesterday: "yesterday",
  last7: "in the last 7 days",
  last30: "in the last 30 days",
  last90: "in the last 90 days",
};

const s = (n: number) => (n === 1 ? "" : "s");
const isAre = (n: number) => (n === 1 ? "is" : "are");

function count(n: number): string {
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(n);
}

/** Sentence case for a clause that has to start a sentence. */
function sentence(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Join a list the way a person writes one: "a, b and c". */
function listWords(parts: readonly string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Compose the line.
 *
 * Order matters and is the practice manager's, not a designer's: what happened
 * to the day's appointments outranks what is owed, because a missed appointment
 * can still be recovered this afternoon and a ledger cannot.
 */
export function composeAnswer(input: AnswerInput): Answer {
  const { period, scope, panels, droppedPayments } = input;
  const phrase = PERIOD_PHRASE[period];

  const cell = scope.strip.cells.find((c) => c.period === period) ?? null;
  const takenPence = cell?.totalPence ?? null;
  const total = panels.appointments.total.value;
  const completed = panels.appointments.completed.value;
  const cancelled = panels.appointments.cancelled.value;
  const dna = panels.appointments.dna.value;
  const stillToCome = panels.appointments.other.value;
  const unpaidPence = panels.invoiced.unpaidPence.value;
  const owedPence = scope.accounts.netBalancePence.value;
  const inDebt = scope.accounts.patientsInDebt.value;
  const variance = scope.udaProgress.progress?.varianceUda ?? null;

  // --- The headline ---------------------------------------------------------

  let headline: string;
  let confident = true;
  if (takenPence !== null && total !== null) {
    headline = `${formatPenceGbp(takenPence)} taken ${phrase}, across ${count(total)} appointment${s(total)}.`;
  } else if (takenPence !== null) {
    headline = `${formatPenceGbp(takenPence)} taken ${phrase}. The appointment count could not be read.`;
  } else if (total !== null) {
    headline = `${count(total)} appointment${s(total)} ${phrase}. Takings could not be read.`;
  } else {
    headline = `Neither takings nor appointments could be read for ${phrase}.`;
    confident = false;
  }

  // --- What needs attention -------------------------------------------------

  const clauses: AnswerClause[] = [];
  /** Checks that genuinely ran and came back with nothing to do. */
  const clear: string[] = [];

  if (total === 0) {
    clauses.push({
      id: "nothing-booked",
      text: `nothing booked ${phrase}`,
      tone: "attention",
      anchor: PANEL_ANCHOR.appointments,
    });
  }

  if (dna !== null) {
    if (dna > 0) {
      clauses.push({
        id: "dna",
        text: `${count(dna)} did not attend`,
        tone: "attention",
        anchor: PANEL_ANCHOR.appointments,
      });
    } else if (total !== 0) {
      clear.push("nobody missed an appointment");
    }
  }

  if (cancelled !== null) {
    if (cancelled > 0) {
      clauses.push({
        id: "cancelled",
        text: `${count(cancelled)} cancelled`,
        tone: "attention",
        anchor: PANEL_ANCHOR.appointments,
      });
    } else if (total !== 0) {
      clear.push("nothing was cancelled");
    }
  }

  if (unpaidPence !== null) {
    if (unpaidPence > 0) {
      clauses.push({
        id: "unpaid",
        text: `${formatPenceGbp(unpaidPence)} invoiced and unpaid`,
        tone: "attention",
        anchor: PANEL_ANCHOR.invoiced,
      });
    } else {
      clear.push("every invoice raised was paid");
    }
  }

  if (owedPence !== null && owedPence > 0) {
    clauses.push({
      id: "owed",
      text:
        inDebt === null
          ? `${formatPenceGbp(owedPence)} owed on patient accounts`
          : `${formatPenceGbp(owedPence)} owed across ${count(inDebt)} account${s(inDebt)}`,
      tone: "attention",
      anchor: PANEL_ANCHOR.accounts,
    });
  } else if (owedPence !== null) {
    clear.push("no account is in debt");
  }

  if (variance !== null && variance < 0) {
    clauses.push({
      id: "uda",
      text: `${count(Math.round(Math.abs(variance)))} UDA behind an even year`,
      tone: "attention",
      anchor: PANEL_ANCHOR.counts,
    });
  }

  const attentionCount = clauses.length;

  // Context, after the work. These are facts a manager reads next, not problems.
  if (stillToCome !== null && stillToCome > 0) {
    clauses.push({
      id: "still-to-come",
      text: `${count(stillToCome)} still to come`,
      tone: "plain",
      anchor: PANEL_ANCHOR.appointments,
    });
  }
  if (completed !== null && completed > 0) {
    clauses.push({
      id: "completed",
      text: `${count(completed)} completed`,
      tone: "plain",
      anchor: PANEL_ANCHOR.appointments,
    });
  }

  // Nothing to do, so say which checks were run. "All clear" on its own is a
  // mood; naming the checks lets a reader see what was NOT checked.
  if (attentionCount === 0 && clear.length > 0) {
    clauses.unshift({
      id: "clear",
      text: `${sentence(listWords(clear))}`,
      tone: "plain",
      anchor: null,
    });
  }

  // --- What could not be established ---------------------------------------

  const limits: string[] = [];
  if (takenPence === null) {
    limits.push(
      cell?.unavailableReason ?? "Takings could not be sourced for this period.",
    );
  }
  if (total === null && panels.appointments.total.reason !== null) {
    limits.push(panels.appointments.total.reason);
  }
  if (droppedPayments > 0) {
    limits.push(
      `${count(droppedPayments)} payment record${s(droppedPayments)} could not be read and ` +
        `${isAre(droppedPayments)} counted in no total.`,
    );
  }
  if (scope.siteId !== null && scope.unattributedPayments > 0) {
    limits.push(
      `${count(scope.unattributedPayments)} payment${s(scope.unattributedPayments)} carry no site and ` +
        `${isAre(scope.unattributedPayments)} left out of a single site's total rather than added to it.`,
    );
  }

  return { headline, clauses, limits, confident };
}
