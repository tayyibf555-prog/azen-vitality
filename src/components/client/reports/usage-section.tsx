import { BarChart3 } from "lucide-react";
import { SectionCard, DataTable, EmptyState, type Column } from "@/components/primitives";
import { usageSummary, type UsageSurfaceCount } from "@/lib/telemetry";

// Owner-only Usage panel on the Reports page. Reports is already gated to
// OWNER_ROLES in the nav (requireModuleAccess("reports")), so a coordinator can
// neither reach the page nor see this section — owner + agency only, as required.
//
// Numbers and a table only, no graphs, in the flat section language. It reads ONE
// grouped summary (usageSummary), which never throws, so it degrades to a calm
// empty state rather than breaking the report.

const WINDOW_DAYS = 30;

/**
 * A count that may be a floor, in the words a practice reads (charter §0/5,
 * ruling W3/11) — the same rendering Home's Operating system band and the
 * pre-visit interest lists use.
 *
 * EVERY figure this panel prints comes off the same scan, so every one of them
 * wears the cap: the headline total, each surface's row, and the most-active
 * user's tally. Qualifying only the headline was the defect — it left a table
 * of floors printed as exact totals directly underneath an honest sentence.
 */
function countLabel(value: number, capped: boolean): string {
  const figure = value.toLocaleString("en-GB");
  return capped ? `at least ${figure}` : figure;
}

export async function UsageSection({ clientId }: { clientId: string }) {
  const sinceIso = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const summary = await usageSummary({ clientId, sinceIso, windowDays: WINDOW_DAYS });

  const columns: Column<UsageSurfaceCount>[] = [
    {
      key: "surface",
      header: "Surface",
      cell: (r) => <span className="font-medium capitalize text-navy">{r.surface.replace(/-/g, " ")}</span>,
    },
    {
      key: "views",
      header: "Views",
      align: "right",
      cell: (r) => <span className="tabular-nums">{countLabel(r.views, summary.capped)}</span>,
    },
  ];

  return (
    <SectionCard
      title="Usage"
      description={`Which parts of the platform your team used in the last ${WINDOW_DAYS} days. Internal activity only, never patient data.`}
    >
      {summary.surfaces.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No usage recorded yet"
          description="As your team moves around the platform, the modules they use appear here, most-used first."
        />
      ) : (
        <div className="space-y-3">
          <p className="flex flex-wrap items-center gap-x-6 gap-y-1 text-caption text-muted">
            {/*
              A CAPPED SCAN PRINTS A FLOOR, AND SAYS SO (charter §0/5, ruling
              W3/11). `usageSummary` reads at most USAGE_SCAN_CAP rows; past
              that its figures are "at least", and a floor wearing a total's
              clothes is the exact defect the honest-numbers rule exists for.
            */}
            <span>
              {summary.capped ? "at least " : null}
              <span className="font-semibold text-navy">{summary.totalViews.toLocaleString("en-GB")}</span> page views
            </span>
            {summary.mostActiveUser ? (
              <span>
                {/*
                  UNDER A CAP THE RANKING ITSELF IS PARTIAL, not just the tally.
                  The scan is newest-first, so a capped run ranked only the most
                  recent slice of the window: the busiest person over the whole
                  thirty days may not be the busiest person in it. So the label
                  says which population the name won, and the figure is a floor.
                */}
                {summary.capped ? "Most active of those counted: " : "Most active: "}
                <span className="font-semibold text-navy">{summary.mostActiveUser.email}</span> (
                {countLabel(summary.mostActiveUser.views, summary.capped)})
              </span>
            ) : null}
          </p>
          <DataTable columns={columns} rows={summary.surfaces} getRowKey={(r) => r.surface} maxRows={12} />
        </div>
      )}
    </SectionCard>
  );
}
