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
      cell: (r) => <span className="tabular-nums">{r.views.toLocaleString("en-GB")}</span>,
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
            <span>
              <span className="font-semibold text-navy">{summary.totalViews.toLocaleString("en-GB")}</span> page views
            </span>
            {summary.mostActiveUser ? (
              <span>
                Most active:{" "}
                <span className="font-semibold text-navy">{summary.mostActiveUser.email}</span> (
                {summary.mostActiveUser.views.toLocaleString("en-GB")})
              </span>
            ) : null}
          </p>
          <DataTable columns={columns} rows={summary.surfaces} getRowKey={(r) => r.surface} maxRows={12} />
        </div>
      )}
    </SectionCard>
  );
}
