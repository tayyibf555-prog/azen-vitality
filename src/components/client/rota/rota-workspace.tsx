"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarRange, Users, Settings2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/primitives";
import { isLiveShift, type RotaShift, type RotaStaff } from "@/lib/rota/types";
import { RotaSchedule } from "./rota-schedule";
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
  { key: "week", label: "Rota", icon: CalendarRange },
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

  // Site scoping now happens SERVER-side, in GET /api/rota/shifts, which honours the
  // same view scope the Staff tab does. The client-side filter that used to live
  // here existed only because the read was a POST to the generator, which had no
  // scope at all; keeping it would be a second copy of a rule that can drift.
  //
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

  // The rota tab reports its loaded shifts here, so the StatCards describe exactly
  // what is on screen -- the week or the month being looked at -- rather than a
  // different window the reader cannot see. Tombstoned and cancelled shifts are
  // excluded: nobody is working them.
  const onShiftsLoaded = useCallback((shifts: RotaShift[]) => {
    const live = shifts.filter(isLiveShift);
    setShiftsThisWeek(live.length);
    setNotified(live.filter((s) => s.status === "notified").length);
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <StatCard label="Staff" value={staffCount} dot="bg-status-blue" hint="Active on the rota" />
        <StatCard
          label="Shifts on screen"
          value={shiftsThisWeek}
          dot="bg-status-blue"
          hint={isAllSites || !siteName ? "Across all sites" : `At ${siteName}`}
        />
        <StatCard label="Told about it" value={notified} dot="bg-status-green" hint="Sent their shifts" />
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
          <RotaSchedule clientSlug={clientSlug} siteIds={siteIds} onShiftsLoaded={onShiftsLoaded} />
        ) : null}
        {tab === "staff" ? (
          <RotaStaffPanel clientSlug={clientSlug} onChanged={refreshStaffCount} />
        ) : null}
        {tab === "settings" ? <RotaSettingsPanel clientSlug={clientSlug} /> : null}
      </div>
    </div>
  );
}
