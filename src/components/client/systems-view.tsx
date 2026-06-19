"use client";

import {
  CalendarClock,
  RotateCcw,
  HeartPulse,
  Zap,
  ShieldCheck,
  MessageCircle,
  Sunrise,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill } from "@/components/primitives";

type SystemStatus = "running" | "paused";

interface SystemRow {
  name: string;
  icon: LucideIcon;
  status: SystemStatus;
  lastActivity: string;
  detail: string;
}

/**
 * "Systems running" status page for managers. Mock data inline for the pilot;
 * this becomes live agent health once the modules ship. No backend call.
 */
const SYSTEMS: SystemRow[] = [
  {
    name: "Recall concierge",
    icon: CalendarClock,
    status: "running",
    lastActivity: "Booked a hygienist recall 4 minutes ago",
    detail: "Reading Dentally recall dates and booking patients back in.",
  },
  {
    name: "Reactivation",
    icon: RotateCcw,
    status: "running",
    lastActivity: "Reached out to a lapsed patient 22 minutes ago",
    detail: "Reviving dormant patients and stalled treatment from the database.",
  },
  {
    name: "Treatment Coordinator",
    icon: HeartPulse,
    status: "running",
    lastActivity: "Drafted a finance re-present 9 minutes ago",
    detail: "Finding accepted but incomplete treatment and following up.",
  },
  {
    name: "Speed-to-lead",
    icon: Zap,
    status: "running",
    lastActivity: "First contact in 18s, 1 hour ago",
    detail: "Contacting new enquiries within seconds across SMS, email and WhatsApp.",
  },
  {
    name: "No-show defence",
    icon: ShieldCheck,
    status: "paused",
    lastActivity: "Paused for the bank holiday weekend",
    detail: "Smart confirmations and reminders off the live Dentally diary.",
  },
  {
    name: "WhatsApp agent",
    icon: MessageCircle,
    status: "running",
    lastActivity: "Handled a reschedule 31 minutes ago",
    detail: "Booking, rescheduling and reminders over the WhatsApp Business API.",
  },
  {
    name: "Daily brief",
    icon: Sunrise,
    status: "paused",
    lastActivity: "Next run at 7:00 tomorrow",
    detail: "Hands each role a prioritised action list every morning.",
  },
];

const TONE: Record<SystemStatus, "success" | "warning"> = {
  running: "success",
  paused: "warning",
};

const LABEL: Record<SystemStatus, string> = {
  running: "Running",
  paused: "Paused",
};

export function SystemsView() {
  const runningCount = SYSTEMS.filter((s) => s.status === "running").length;
  const total = SYSTEMS.length;
  const pausedCount = total - runningCount;

  return (
    <>
      <PageHeader
        title="Systems"
        description="A live view of the automated systems working across the practice. Pause or hand a thread to a human whenever you need to step in."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Systems running"
          value={`${runningCount} of ${total}`}
          icon={CheckCircle2}
          hint="Active right now"
        />
        <StatCard
          label="Paused"
          value={String(pausedCount)}
          icon={ShieldCheck}
          hint="Idle or scheduled"
        />
        <StatCard
          label="Coverage"
          value={`${Math.round((runningCount / total) * 100)}%`}
          icon={Zap}
          hint="Share of systems live"
        />
      </div>

      <SectionCard
        title="Automated systems"
        description="Each system reports its current state and most recent activity."
      >
        <ul className="divide-y divide-line">
          {SYSTEMS.map((system) => {
            const Icon = system.icon;
            return (
              <li
                key={system.name}
                className="flex items-center gap-4 py-3.5 first:pt-0 last:pb-0"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
                  <Icon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-semibold text-navy">{system.name}</p>
                  <p className="truncate text-sm text-muted">{system.detail}</p>
                </div>
                <div className="hidden shrink-0 text-right sm:block">
                  <p className="text-xs text-muted">{system.lastActivity}</p>
                </div>
                <StatusPill tone={TONE[system.status]} className="shrink-0">
                  {LABEL[system.status]}
                </StatusPill>
              </li>
            );
          })}
        </ul>
      </SectionCard>
    </>
  );
}
