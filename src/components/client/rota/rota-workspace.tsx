"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarRange, Users, Settings2, MessageSquare, MapPin } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatCard } from "@/components/primitives";
import { getSites } from "@/lib/mock/clients";
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

export function RotaWorkspace({ clientSlug }: { clientSlug: string }) {
  const [tab, setTab] = useState<TabKey>("week");
  const [staffCount, setStaffCount] = useState(0);
  const [shiftsThisWeek, setShiftsThisWeek] = useState(0);
  const [notified, setNotified] = useState(0);

  // Number of configured sites is static mock data; the other counts come from the API.
  const siteCount = getSites(clientSlug).length;

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
  // same data without a second generate call.
  const onShiftsLoaded = useCallback((shifts: RotaShift[]) => {
    const week = shifts.filter((s) => withinDays(s.shiftDate, 7));
    setShiftsThisWeek(week.length);
    setNotified(week.filter((s) => s.status === "notified").length);
  }, []);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Staff" value={staffCount} icon={Users} hint="Active on the rota" />
        <StatCard
          label="Shifts this week"
          value={shiftsThisWeek}
          icon={CalendarRange}
          hint="Generated across all sites"
        />
        <StatCard label="Notified" value={notified} icon={MessageSquare} hint="Texted their shifts" />
        <StatCard label="Sites" value={siteCount} icon={MapPin} hint="Covered by the rota" />
      </div>

      <div
        role="tablist"
        aria-label="Staff rota sections"
        className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-card p-1 shadow-[0_1px_2px_rgba(10,14,26,0.04)]"
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
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40",
                active
                  ? "bg-blue-dark/[0.08] text-blue-deep"
                  : "text-muted hover:bg-card-muted hover:text-ink",
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
          <RotaThisWeek clientSlug={clientSlug} onShiftsLoaded={onShiftsLoaded} />
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
