import { getPatientChart, getPlanPanelRead } from "@/lib/dentally/charting-read";
import type { PlanPanelRead } from "@/lib/dentally/charting-read";
import { isChartDraftEnabled } from "@/lib/charting/write-gate";
import { planPanelNotices, toPlanPanelViews } from "@/lib/charting/plan-panel-view";
import { listDraft } from "@/lib/patient-chart/draft-repository";
import type { ChartRead, DraftEntry } from "@/lib/charting/types";
import { ChartWorkspace } from "./chart/chart-workspace";
import { PlanPanel } from "./chart/plan-panel";

/**
 * The Chart tab's data seam: an async SERVER component, and the only place the
 * reads behind this screen are made.
 *
 * IT IMPORTS EXACTLY TWO THINGS FROM chart/, and boundary.test.ts pins that, now
 * by walking the import graph rather than by naming two files. Every other leaf
 * in that directory is an undirected universal module that attaches DOM handlers
 * and takes function props; a server component rendering one builds green and
 * throws at render, which is a failure this repo has already shipped once.
 * ChartWorkspace owns the client boundary. PlanPanel and everything it pulls in
 * (the appointment cards, the footer, the plan cards, the inert controls) are
 * genuinely server-safe: no state, no handlers, no function props, and collapse
 * done with native <details> rather than with a second client leaf.
 *
 * PlanCards IS STILL ON THE SCREEN and is no longer imported here. PlanPanel
 * renders it as the no-plan empty state, which is where Dentally puts those two
 * cards. Rendering it here as well would put its two labels, and the two DOM ids
 * their aria-describedby points at, on the page twice.
 *
 * THE FAILED STATE IS NOT GATED ON BOTH READS FAILING. Each read carries a health
 * flag per stream, and that flag travels through the workspace to the arch itself,
 * so a failed items read renders unmarked teeth that make no claim plus the failed
 * sentence in the always-visible status bar. The clinically important case is the
 * CHART read failing on its own, and gating on "both failed" would have hidden
 * exactly that.
 *
 * EVEN A TOTAL FAILURE RENDERS THE SCREEN. Both reads fail soft per stream, but
 * either can still throw before any stream starts (no API key, a bad base URL), so
 * the catches below produce an all-failed read rather than letting the tab blow up.
 * A blank tab on a charting screen says nothing at all, and saying nothing is the
 * one outcome this build treats as unacceptable.
 *
 * TWO READS, NOT ONE, AND DELIBERATELY SO. getPatientChart feeds the arch;
 * getPlanPanelRead feeds the panel beneath it and additionally pages the
 * treatment_appointments and the diary that the arch has no use for. They are
 * issued in parallel, each caches on its own, and the reasoning for keeping them
 * apart is written out at the top of charting-read.ts. Both are read-only, and
 * neither has a write path to call: Dentally publishes no create route on any
 * charting resource. The draft read below goes to OUR table and is skipped
 * entirely unless CHART_DRAFT_ENABLED is set, which it is not.
 *
 * IT TAKES NO `nowIso`, unlike every other tab, and the omission is deliberate.
 * Those tabs render an age ("last seen 14 months ago") and so must all agree on
 * one "now". Nothing under the chart renders a present tense at all: every time it
 * prints comes from a read's fetchedAt, captured inside the read at fetch time,
 * from an item's own completedAt, or from a diary appointment's start. Passing a
 * "now" that nothing consumes would be a prop somebody later wires to a clock,
 * which is how a screen starts asserting a present it cannot support.
 */
export async function TabChart({
  clientSlug,
  siteId,
  patientId,
}: {
  clientSlug: string;
  siteId: string;
  patientId: string;
}) {
  const draftEnabled = isChartDraftEnabled();

  const [read, panelRead, seedDraft] = await Promise.all([
    getPatientChart(patientId, siteId).catch((err) => {
      console.error(`[chart] the chart read threw for patient ${patientId}`, err);
      return failedRead();
    }),
    getPlanPanelRead(patientId, siteId).catch((err) => {
      console.error(`[chart] the plan panel read threw for patient ${patientId}`, err);
      return failedPanelRead();
    }),
    draftEnabled
      ? listDraft({ siteId, patientId }).then(
          (entries) => ({ ok: true, entries }),
          // A failed draft read is REPORTED, never flattened to an empty list: an
          // empty draft renders as "this clinician has planned nothing", which is a
          // claim about a person rather than about a database.
          () => ({ ok: false, entries: [] as DraftEntry[] }),
        )
      : Promise.resolve({ ok: true, entries: [] as DraftEntry[] }),
  ]);

  // The join between the read and the cards, and every decision inside it, lives in
  // a .ts so vitest can reach it. Nothing about what a cell says is decided here.
  const panels = toPlanPanelViews(panelRead.panels);
  const notices = planPanelNotices(panelRead);

  // A FAILED PLANS READ IS NOT AN EMPTY PLAN. When the plans stream failed AND
  // nothing came back at all, the panel must say so rather than print Dentally's
  // empty state, which reads as "this patient has no planned treatment". When rows
  // did survive - the synthetic panel holds them - they are shown, with the notices
  // above them saying what was missing.
  const plansUnreadable = panelRead.health.plans === "failed" && panels.length === 0;
  // A FAILED LINES READ IS NOT A PLAN WORTH NOTHING. The footer's Total Price and
  // Uncharged are summed from the rows on screen; with the items stream down there
  // are no rows, and both printed a confident £0.00 next to Dentally's own private
  // plan value. The read-level caveat above the panels says the lines failed, but
  // £0.00 is still a money claim built out of a failed read, so the figures
  // themselves are suppressed and the footer says why.
  const itemsFailed = panelRead.health.items === "failed";

  return (
    <div className="space-y-4">
      <ChartWorkspace
        clientSlug={clientSlug}
        siteId={siteId}
        patientId={patientId}
        read={read}
        draftEnabled={draftEnabled}
        seedDraft={seedDraft}
      />

      {/* THE READ-LEVEL CAVEATS, above every panel rather than inside one, because
          they are facts about the read and not about a plan. Ordered most serious
          first by planPanelNotices, which is pure and tested. */}
      {notices.length > 0 ? (
        <div className="space-y-2">
          {notices.map((notice) => (
            <p
              key={notice}
              className="rounded-xl border border-tint-amber-line bg-tint-amber px-3.5 py-2.5 text-[12.5px] leading-[1.5] text-ink"
            >
              {notice}
            </p>
          ))}
        </div>
      ) : null}

      {plansUnreadable ? (
        <PlanPanel plan={null} failed />
      ) : panels.length === 0 ? (
        // Genuinely no treatment plan on this patient. PlanPanel renders Dentally's
        // own two empty-state cards here, inert and explained.
        <PlanPanel plan={null} />
      ) : (
        // EVERY PANEL, NOT THE FIRST ONE. A patient can hold several treatment plans
        // and the read appends a synthetic one for treatment filed against none;
        // rendering only panels[0] would be the same silent drop as rendering only
        // the appointment cards, one level up again.
        panels.map((plan) => (
          <PlanPanel key={plan.domId} plan={plan} itemsFailed={itemsFailed} />
        ))
      )}
    </div>
  );
}

/** Every stream failed before it began. The screen still draws its chrome, its status
 *  bar and an arch that makes no claim about any tooth. */
function failedRead(): ChartRead {
  return {
    items: [],
    unplaced: [],
    treatments: [],
    categories: [],
    plans: [],
    truncated: false,
    truncatedCatalogue: false,
    fetchedAt: "",
    health: { items: "failed", treatments: "failed", categories: "failed", plans: "failed" },
  };
}

/** The panel read threw before any stream started. `balanced` stays TRUE: nothing was
 *  read, so nothing was dropped, and claiming a reconciliation failure here would
 *  point a clinician at the wrong problem. The health flags say what actually
 *  happened, and the panel renders its failed state. */
function failedPanelRead(): PlanPanelRead {
  return {
    panels: [],
    itemCount: 0,
    renderedItemCount: 0,
    balanced: true,
    truncated: false,
    truncatedSupporting: false,
    fetchedAt: "",
    health: {
      items: "failed",
      appointments: "failed",
      plans: "failed",
      diary: "failed",
      practitioners: "failed",
    },
  };
}
