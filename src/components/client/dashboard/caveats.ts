import { formatPenceGbp } from "@/lib/dashboard/money";
import { PERIOD_LABELS } from "@/lib/dashboard/period";
import type { TakingsStrip } from "@/lib/dashboard/takings";
import type {
  AccountsPanel,
  AppointmentsPanel,
  InvoicedPanel,
  UdaProgressPanel,
  UdaWindowPanel,
} from "@/lib/dashboard/view";

// ---------------------------------------------------------------------------
// Every caveat the dashboard has to make, in one place.
//
// The panels used to each print their own grey paragraph. Four of them across
// one band is more prose than figures, and prose that sits under a number all
// day stops being read. So the text is built here, shown collapsed as one quiet
// row under the band, and reachable in two ways that both give the WHOLE
// sentence: hovering the mark beside the figure it qualifies, or opening its
// chip in the row.
//
// Nothing is shortened away. A caveat about money that could not be counted is
// marked `material`, which earns it a warning glyph rather than an information
// one, so it never reads as a footnote about formatting.
// ---------------------------------------------------------------------------

export interface Caveat {
  /** Stable id, so a mark beside a figure can open the same entry in the row. */
  id: string;
  /** Two or three words. The only part visible until the caveat is opened. */
  label: string;
  /** The whole sentence, verbatim. Never trimmed, never dropped. */
  text: string;
  /** True when it qualifies money, claims or appointments that could not be counted. */
  material: boolean;
}

const s = (n: number) => (n === 1 ? "" : "s");
const isAre = (n: number) => (n === 1 ? "is" : "are");

/** Takings: where each cell's figure came from, and anything left out of one. */
export function takingsCaveats(args: {
  strip: TakingsStrip;
  unattributedPayments: number;
  droppedPayments: number;
  /**
   * The NAMES of any practices whose takings read did not answer, already resolved
   * from ids by the caller. Appended to the blank-period sentence so a manager of
   * three practices is told which one is missing rather than that one of them is.
   * It never decides whether anything is blank — see BuildViewInput.takingsFailedSites.
   */
  failedSiteNames?: readonly string[];
}): Caveat[] {
  const { strip, unattributedPayments, droppedPayments } = args;
  const failedSiteNames = args.failedSiteNames ?? [];
  const out: Caveat[] = [
    {
      id: "takings-source",
      label: "How these are sourced",
      // THIS SENTENCE USED TO BE THE BUG, IN WRITING, ON HER SCREEN. It read: "Today
      // and yesterday are read live from Dentally. Longer periods come from the
      // nightly rollup, because Dentally does not filter payments by date and a
      // ninety day scan cannot run on a page load." Dentally DOES filter payments by
      // date, and totalling the rows we happened to reach is what understated the
      // last thirty days by 38% and the last ninety by 85%. Every period is now asked
      // for by name and answered by Dentally itself.
      text:
        "Every period is read live from Dentally, which returns the exact total for the dates asked for. " +
        "The figure is the same one Dentally reports for that window, including any refunds taken in it. " +
        "A period that could not be read says so instead of showing a total.",
      material: false,
    },
  ];

  const blanks = strip.cells.filter((c) => c.totalPence === null);
  if (blanks.length > 0) {
    const names = blanks.map((c) => PERIOD_LABELS[c.period].toLowerCase()).join(", ");
    const reason = blanks[0]?.unavailableReason ?? "no reason was given.";
    // WHICH PRACTICE. The read layer has always known and the screen has never said,
    // so "one of the sites in this view could not be read" left a manager of three
    // practices to guess. Nothing above this line depends on the list.
    const named =
      failedSiteNames.length === 0
        ? ""
        : ` The site${s(failedSiteNames.length)} that did not answer: ${failedSiteNames.join(", ")}.`;
    out.push({
      id: "takings-blank",
      label: `${blanks.length} period${s(blanks.length)} blank`,
      text: `${names} ${isAre(blanks.length)} blank: ${reason}${named}`,
      material: true,
    });
  }

  // THE NEXT TWO ARE FIXTURE-PATH ONLY, AND THAT IS DELIBERATE. Both describe rows
  // the takings ROW path handled, and the live dashboard has no rows: its money is
  // Dentally's own per-window aggregate, so it passes `payments: []` and neither
  // counter can ever be non-zero there. They are kept rather than deleted because the
  // row path is not dead code — the finance fixtures and dashboard-chrome.test.ts
  // drive the entire screen through it, and the stored-rollup seam will use it — and
  // because a caveat that only fires on one path still has to be right when it fires.
  if (strip.siteId !== null && unattributedPayments > 0) {
    out.push({
      id: "takings-unattributed",
      label: `${unattributedPayments} payment${s(unattributedPayments)} unsited`,
      text:
        `${unattributedPayments} payment${s(unattributedPayments)} carry no site and ` +
        `${isAre(unattributedPayments)} left out of a single site’s total rather than added to it.`,
      material: true,
    });
  }

  if (droppedPayments > 0) {
    out.push({
      id: "takings-dropped",
      label: `${droppedPayments} payment${s(droppedPayments)} unread`,
      text:
        `${droppedPayments} payment record${s(droppedPayments)} could not be read and ` +
        `${isAre(droppedPayments)} counted in no total.`,
      material: true,
    });
  }

  return out;
}

/** Appointments: states Dentally sent that we did not file into a slice. */
export function appointmentsCaveats(panel: AppointmentsPanel): Caveat[] {
  const n = panel.unknownStates.length;
  if (n === 0) return [];
  const listed = panel.unknownStates.slice(0, 3).join(", ");
  return [
    {
      id: "appointments-unknown",
      label: `${n} state${s(n)} unrecognised`,
      text:
        `${n} appointment state${s(n)} not recognised (${listed}${n > 3 ? ", and others" : ""}). ` +
        "They are counted as still to come, never filed into one of the three states.",
      material: true,
    },
  ];
}

/** Accounts: what the headline is, and anything that did not reach it. */
export function accountsCaveats(panel: AccountsPanel): Caveat[] {
  const out: Caveat[] = [
    {
      id: "accounts-snapshot",
      label: "What a balance means",
      text: "A balance is what is owed today, so this panel does not change with the selected period.",
      material: false,
    },
  ];

  const net = panel.netBalancePence.value;
  const owed = panel.totalOwedPence.value;
  if (owed !== null && net !== null && owed !== Math.abs(net)) {
    out.push({
      id: "accounts-credit",
      label: "Credits net off",
      text: `Debts total ${formatPenceGbp(owed)}; the headline is lower because some accounts are in credit.`,
      material: true,
    });
  }

  if (panel.dropped > 0) {
    out.push({
      id: "accounts-dropped",
      label: `${panel.dropped} balance${s(panel.dropped)} unread`,
      text:
        `${panel.dropped} balance row${s(panel.dropped)} could not be read and ` +
        `${isAre(panel.dropped)} in no total.`,
      material: true,
    });
  }

  return out;
}

/** Invoiced: bills that carry no date, and bills that could not be read at all. */
export function invoicedCaveats(panel: InvoicedPanel): Caveat[] {
  const out: Caveat[] = [];

  const n = panel.undatedInvoices;
  if (n > 0) {
    out.push({
      id: "invoiced-undated",
      label: `${n} invoice${s(n)} undated`,
      text:
        `${n} invoice${s(n)} ${n === 1 ? "carries" : "carry"} no date and cannot be placed in a period, ` +
        `so ${n === 1 ? "it is" : "they are"} counted here in no period at all.`,
      material: true,
    });
  }

  // A DIFFERENT FACT FROM UNDATED, AND THE REASON THE GRAMMAR COULD BE TIGHTENED.
  // The row parser here used to be a private, looser one than the platform's; making
  // it the strict shared parser is only honest if a row it refuses is COUNTED and
  // shown, rather than skipped in silence and taken off the total.
  const d = panel.droppedInvoices;
  if (d > 0) {
    out.push({
      id: "invoiced-unread",
      label: `${d} invoice${s(d)} unread`,
      text:
        `${d} invoice record${s(d)} could not be read and ${isAre(d)} in no total on this panel.`,
      material: true,
    });
  }

  return out;
}

/** UDAs: the missing contract target, and claims with a status we cannot file. */
export function udaCaveats(uda: UdaWindowPanel, progress: UdaProgressPanel): Caveat[] {
  const out: Caveat[] = [];

  if (progress.progress === null) {
    out.push({
      id: "uda-contract",
      label: "Contract target",
      text:
        progress.reason ??
        "Contract progress is unavailable because the annual UDA target is not configured.",
      material: true,
    });
  }

  const n = uda.unrecognisedClaimCount;
  if (n > 0) {
    out.push({
      id: "uda-claims",
      label: `${n} claim${s(n)} unrecognised`,
      text:
        `${n} claim${s(n)} carry a status we do not recognise (${uda.unknownStatuses.slice(0, 2).join(", ")}) ` +
        "and count toward neither figure.",
      material: true,
    });
  }

  return out;
}

/**
 * The hover and screen-reader text for the mark beside a figure: every caveat
 * that figure carries, in full, joined into one string.
 */
export function caveatSummary(caveats: Caveat[]): string {
  return caveats.map((c) => c.text).join(" ");
}

/** The entry a mark should open: the money one if there is one, else the first. */
export function leadCaveat(caveats: Caveat[]): Caveat | null {
  return caveats.find((c) => c.material) ?? caveats[0] ?? null;
}
