"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarRange, Users, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/primitives";
import type { RotaShift, RotaStaff } from "@/lib/rota/types";
import { RotaThisWeek } from "./rota-this-week";
import { RotaStaffPanel } from "./rota-staff-panel";
import { RotaSettingsPanel } from "./rota-settings-panel";

// Tabbed Staff Rota workspace. Three tabs:
//   - This week: the generated rota, grouped by day and site, with a generate action.
//   - Staff: the rota_staff list with add / edit / remove and availability.
//   - Settings: the coverage + automation config (roles needed, lead days, weeks ahead).
// The tab bar mirrors the compliance / onboarding workspaces (active = blue-deep pill,
// role=tablist/tab/tabpanel). The StatCards summarise the live shift + staff data: the
// active-staff count comes from a lightweight staff fetch, and the shift + notified
// counts are pushed up by the "This week" tab (which already loads the shifts) so we
// never generate twice.

type TabKey = "week" | "staff" | "settings";

const TABS: { key: TabKey; label: string; icon: LucideIcon }[] = [
  { key: "week", label: "This week", icon: CalendarRange },
  { key: "staff", label: "Staff", icon: Users },
  { key: "settings", label: "Settings", icon: Settings2 },
];

export function RotaWorkspace({
  clientSlug,
  siteIds,
  isAllSites,
  siteName,
}: {
  clientSlug: string;
  /** The site(s) the current view is scoped to (single site, or every site for "All sites"). */
  siteIds: string[];
  /** True when the switcher is on "All sites". */
  isAllSites: boolean;
  /** The selected site's name when a single site is chosen, else null. */
  siteName: string | null;
}) {
  const [tab, setTab] = useState<TabKey>("week");
  const [staffCount, setStaffCount] = useState(0);
  const [shiftsThisWeek, setShiftsThisWeek] = useState(0);
  const [notified, setNotified] = useState(0);

  // The generate route returns shifts for every site (there is no scoped read
  // route), so we filter to the selected site(s) here for the displayed grid and
  // the shift counts. A stable Set keeps the filter cheap and referentially safe
  // for the memoised child.
  const scopedSiteIds = useMemo(() => new Set(siteIds), [siteIds]);
  const inScope = useCallback((s: RotaShift) => scopedSiteIds.has(s.siteId), [scopedSiteIds]);

  // Sites the view covers: every configured site for "All sites", else just the one.
  const siteCount = siteIds.length;

  const refreshStaffCount = useCallback(async () => {
    try {
      const res = await fetch(`/api/rota/staff?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; staff?: RotaStaff[] };
      const staff = res.ok && data.ok ? (data.staff ?? []) : [];
      setStaffCount(staff.filter((s) => s.active).length);
    } catch {
      // Leave the last-known count in place; a later refresh reconciles.
    }
  }, [clientSlug]);

  useEffect(() => {
    void refreshStaffCount();
  }, [refreshStaffCount]);

  // The "This week" tab reports its loaded shifts here, so the StatCards reflect the
  // same data without a second generate call. Scope to the selected site(s) so the
  // counts match the grid.
  const onShiftsLoaded = useCallback(
    (shifts: RotaShift[]) => {
      const week = shifts.filter((s) => inScope(s) && withinDays(s.shiftDate, 7));
      setShiftsThisWeek(week.length);
      setNotified(week.filter((s) => s.status === "notified").length);
    },
    [inScope],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="Staff" value={staffCount} dot="bg-status-blue" hint="Active on the rota" />
        <StatCard
          label="Shifts this week"
          value={shiftsThisWeek}
          dot="bg-status-blue"
          hint={isAllSites || !siteName ? "Generated across all sites" : `Generated for ${siteName}`}
        />
        <StatCard label="Notified" value={notified} dot="bg-status-green" hint="Texted their shifts" />
        <StatCard label="Sites" value={siteCount} dot="bg-line-strong" hint="Covered by the rota" />
      </div>

      <div
        role="tablist"
        aria-label="Staff rota sections"
        className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]"
      >
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = tab === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              id={`rota-tab-${key}`}
              aria-selected={active}
              aria-controls={`rota-panel-${key}`}
              onClick={() => setTab(key)}
              className={cn(
                "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25",
                active ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
              )}
            >
              <Icon size={15} />
              {label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`rota-panel-${tab}`} aria-labelledby={`rota-tab-${tab}`}>
        {tab === "week" ? (
          <RotaThisWeek clientSlug={clientSlug} inScope={inScope} onShiftsLoaded={onShiftsLoaded} />
        ) : null}
        {tab === "staff" ? (
          <RotaStaffPanel clientSlug={clientSlug} onChanged={refreshStaffCount} />
        ) : null}
        {tab === "settings" ? <RotaSettingsPanel clientSlug={clientSlug} /> : null}
      </div>
    </div>
  );
}

/** Whether a `YYYY-MM-DD` shift date is within `days` days from today (whole-day, UTC-anchored). */
function withinDays(shiftDate: string, days: number): boolean {
  const start = Date.parse(`${shiftDate}T00:00:00Z`);
  if (Number.isNaN(start)) return false;
  const now = Date.now();
  const todayUtc = now - (now % 86_400_000);
  const diffDays = Math.round((start - todayUtc) / 86_400_000);
  return diffDays >= 0 && diffDays < days;
}
