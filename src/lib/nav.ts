import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Sparkles,
  Zap,
  PhoneCall,
  ListChecks,
  Tags,
  CalendarClock,
  RotateCcw,
  HeartPulse,
  PhoneMissed,
  ShieldCheck,
  MessageCircle,
  Sunrise,
  Settings,
} from "lucide-react";

export type ModuleStatus = "live" | "placeholder";

export interface NavItem {
  /** Path segment under /c/[client]. Empty string = the Overview index. */
  slug: string;
  label: string;
  icon: LucideIcon;
  status: ModuleStatus;
  /** PILOT spec behaviour, surfaced on the placeholder page so a future session can pick it up cold. */
  note?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * The PILOT module map. This single config drives the client sidebar AND the
 * placeholder routes, so adding/owning a module later means editing one place.
 * Roles that can see each area are enforced in the shell, not here.
 */
export const CLIENT_NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { slug: "", label: "Overview", icon: LayoutDashboard, status: "live" },
    ],
  },
  {
    label: "Acquisition",
    items: [
      {
        slug: "smile-assessment",
        label: "Smile Assessment",
        icon: Sparkles,
        status: "placeholder",
        note: "Embeddable qualifying quiz. Scores each enquiry on treatment interest, timeline, budget readiness and location. High scorers fast-tracked to booking in Dentally; low scorers nurtured. Intent and fit only, never clinical suitability.",
      },
      {
        slug: "speed-to-lead",
        label: "Speed-to-lead",
        icon: Zap,
        status: "placeholder",
        note: "Contact a new enquiry within ~30 seconds across SMS, email and WhatsApp. Instrument first-response time (5+ min delay correlates with ~9x lower conversion).",
      },
    ],
  },
  {
    label: "Conversion",
    items: [
      {
        slug: "power-dialler",
        label: "Power dialler",
        icon: PhoneCall,
        status: "placeholder",
        note: "Auto-dials several leads at once, staggered so two never connect at once, routes the first answered call to a free coordinator and drops the rest. Configurable concurrency. Shared across sites.",
      },
      {
        slug: "task-queue",
        label: "Task queue",
        icon: ListChecks,
        status: "placeholder",
        note: "Feeds coordinators the next prioritised task instead of a drag-and-drop pipeline. Follow-up cadence baked in (fast first touch, then spaced retries before a lead goes cold).",
      },
      {
        slug: "pricing-usps",
        label: "Pricing & USPs",
        icon: Tags,
        status: "placeholder",
        note: "Canonical, lightweight source of truth for pricing and USPs, configurable at service and site level so messaging is consistent everywhere.",
      },
    ],
  },
  {
    label: "Lifecycle",
    items: [
      {
        slug: "recall",
        label: "Recall concierge",
        icon: CalendarClock,
        status: "placeholder",
        note: "Reads the exact dentist and hygienist recall dates clinicians set in Dentally and books patients back in via SMS/email. Respect consent flags before any outbound.",
      },
      {
        slug: "reactivation",
        label: "Reactivation",
        icon: RotateCcw,
        status: "placeholder",
        note: "Revives lapsed/dormant patients (Dentally archived_reason = lapsed) and unfinished treatment plans from the existing database.",
      },
      {
        slug: "treatment-coordinator",
        label: "Treatment Coordinator",
        icon: HeartPulse,
        status: "placeholder",
        note: "Highest-value module. Finds accepted-but-incomplete treatment, ranks by value, re-presents finance, follows up and books the next step.",
      },
      {
        slug: "after-hours",
        label: "After-hours capture",
        icon: PhoneMissed,
        status: "placeholder",
        note: "Answers and books missed calls after hours and on genuine overflow only. A live-hours AI receptionist is explicitly out of scope.",
      },
      {
        slug: "no-show-defence",
        label: "No-show defence",
        icon: ShieldCheck,
        status: "placeholder",
        note: "Smart confirmations and reminders driven off the live Dentally diary and appointment state machine.",
      },
    ],
  },
  {
    label: "Conversational",
    items: [
      {
        slug: "whatsapp",
        label: "WhatsApp agent",
        icon: MessageCircle,
        status: "placeholder",
        note: "Booking, rescheduling, cancelling, reminders, recalls and follow-ups over the WhatsApp Business API, with human escalation and takeover. Connected live to Dentally.",
      },
    ],
  },
  {
    label: "Staff & Ops",
    items: [
      {
        slug: "daily-brief",
        label: "Daily brief",
        icon: Sunrise,
        status: "placeholder",
        note: "Every morning, reads the diary and hands each role a prioritised action list: who to chase, gaps to fill, no-show risks, high-value treatment arriving today.",
      },
    ],
  },
  {
    label: "Account",
    items: [
      { slug: "settings", label: "Settings", icon: Settings, status: "placeholder", note: "Site preferences, consent defaults, Dentally connection, team and roles." },
    ],
  },
];

/** Flat lookup of every client module path (used for placeholder route generation + guards). */
export const CLIENT_MODULE_SLUGS = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));
