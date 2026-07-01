"use client";

import { CalendarClock, ShieldCheck, Users } from "lucide-react";
import { EmptyState, Tabs, type TabItem } from "@/components/primitives";
import { Worklist } from "./worklist";
import { WaitlistPanel } from "./waitlist-panel";
import type { NoshowTarget, WaitlistEntry } from "@/lib/noshow/types";

/**
 * Client wrapper for the no-show worklist + waitlist tabs. Tabs is a client
 * primitive (it holds the active-tab state), so the tab definitions - which
 * carry icon components and rendered panels - must be built on the client. The
 * server view fetches the data and hands us plain serialisable arrays.
 */
export function NoshowTabs({
  targets,
  waitlist,
  nowIso,
}: {
  targets: NoshowTarget[];
  waitlist: WaitlistEntry[];
  nowIso: string;
}) {
  const waiting = waitlist.filter((w) => w.status === "waiting");

  const tabs: TabItem[] = [
    {
      key: "upcoming",
      label: "Upcoming appointments",
      icon: CalendarClock,
      badge: targets.length || undefined,
      content:
        targets.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No upcoming appointments yet"
            description="Run the no-show sync to pull the upcoming diary from Dentally into this worklist. This view is mock safe, so it stays empty until data lands."
          />
        ) : (
          <Worklist targets={targets} nowIso={nowIso} />
        ),
    },
    {
      key: "waitlist",
      label: "Waitlist",
      icon: Users,
      badge: waiting.length || undefined,
      content: <WaitlistPanel entries={waitlist} nowIso={nowIso} />,
    },
  ];

  return <Tabs tabs={tabs} defaultKey="upcoming" />;
}
