import type { LucideIcon } from "lucide-react";
import type { Role } from "@/lib/types";
import {
  LayoutDashboard,
  CalendarDays,
  CalendarRange,
  Users,
  Wallet,
  Sparkles,
  Zap,
  PhoneCall,
  ListChecks,
  CalendarClock,
  RotateCcw,
  HeartPulse,
  PhoneMissed,
  ShieldCheck,
  MessageCircle,
  MessagesSquare,
  Bot,
  Sunrise,
  Settings,
  BadgeCheck,
  Megaphone,
  ClipboardCheck,
  Star,
  TrendingUp,
  FileText,
  UserPlus,
  Bell,
  Home,
  Briefcase,
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
  /**
   * Roles allowed to see and reach this item. Undefined = visible to every role.
   * An item with `roles` requires the current role to be in the list; this is how
   * owner-only modules are hidden from coordinators in nav and gated on direct URL.
   */
  roles?: Role[];
}

/** Roles that may see the owner-only modules: the practice owner and agency admins. */
export const OWNER_ROLES: Role[] = ["agency_admin", "client_owner"];

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
    label: "Insights",
    items: [
      {
        slug: "roi",
        label: "ROI",
        icon: TrendingUp,
        status: "live",
        roles: OWNER_ROLES,
        note: "Practice-wide growth view: how acquisition spend turns into leads, booked patients and treatment revenue, by channel, with cost per new patient and return on spend. Mock until the live sources are connected.",
      },
      {
        slug: "reports",
        label: "Reports",
        icon: FileText,
        status: "live",
        roles: OWNER_ROLES,
        note: "AI weekly and monthly business reviews across acquisition, conversion, lifecycle and compliance, with recommendations. Mock until the live sources connect.",
      },
    ],
  },
  {
    label: "Clinic",
    items: [
      // NOTE: the old "today" module folded into the Home overview ("One Front
      // Door"): its diary snapshot renders there as the diary rail, and /today
      // redirects Home. The Calendar remains the full diary destination.
      {
        slug: "calendar",
        label: "Calendar",
        icon: CalendarDays,
        status: "live",
        note: "The live Dentally diary. Move day by day, filter by site, and see who is booked in and their appointment state.",
      },
      {
        slug: "patients",
        label: "Patients",
        icon: Users,
        status: "live",
        note: "The patient database from Dentally. Search by name or contact, see recall and last visit, and open a record.",
      },
      {
        slug: "payments",
        label: "Payments",
        icon: Wallet,
        status: "live",
        note: "Outstanding balances across accepted treatment plans, ranked by what is owed, live from Dentally.",
      },
    ],
  },
  {
    label: "Acquisition",
    items: [
      {
        slug: "meta-ads",
        label: "Meta Ads",
        icon: Megaphone,
        status: "live",
        roles: OWNER_ROLES,
        note: "Plan, build and track Facebook and Instagram ad campaigns: ready-to-launch templates, AI ad copy, a step-by-step launch guide, performance analytics, and a library of winning dental ads with an AI creative overview. UK GDC and ASA compliant. Campaign data is mock until the Meta account is connected.",
      },
      {
        slug: "smile-assessment",
        label: "Smile Assessment",
        icon: Sparkles,
        status: "live",
        note: "Embeddable qualifying quiz. Scores each enquiry on treatment interest, timeline, budget readiness and location. High scorers fast-tracked to booking in Dentally; low scorers nurtured. Intent and fit only, never clinical suitability.",
      },
      {
        slug: "speed-to-lead",
        label: "Speed-to-lead",
        icon: Zap,
        status: "live",
        note: "Contact a new enquiry within ~30 seconds across SMS, email and WhatsApp. Instrument first-response time (5+ min delay correlates with ~9x lower conversion).",
      },
      {
        slug: "onboarding",
        label: "Onboarding",
        icon: UserPlus,
        status: "live",
        note: "A branded new-patient onboarding form at /onboard/<client>: contact, brief medical intake, documents upload and consent, collected step by step. Submissions land here for the team to review and register.",
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
        status: "live",
        note: "Feeds coordinators the next prioritised task instead of a drag-and-drop pipeline. Follow-up cadence baked in (fast first touch, then spaced retries before a lead goes cold).",
      },
      {
        slug: "usps",
        label: "USPs",
        icon: BadgeCheck,
        status: "live",
        roles: OWNER_ROLES,
        note: "The practice's selling points, managed by the owner and woven into the AI agents' conversion messaging. Short, truthful, never a clinical guarantee.",
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
        status: "live",
        note: "Reads the exact dentist and hygienist recall dates clinicians set in Dentally and books patients back in via SMS/email. Respect consent flags before any outbound.",
      },
      {
        slug: "reactivation",
        label: "Reactivation",
        icon: RotateCcw,
        status: "live",
        note: "Revives lapsed/dormant patients (Dentally archived_reason = lapsed) and unfinished treatment plans from the existing database.",
      },
      {
        slug: "treatment-coordinator",
        label: "Treatment Coordinator",
        icon: HeartPulse,
        status: "live",
        note: "Highest-value module. Finds accepted-but-incomplete treatment, ranks by value, re-presents finance, follows up and books the next step.",
      },
      {
        slug: "after-hours",
        label: "After-hours capture",
        icon: PhoneMissed,
        status: "live",
        note: "Answers and books missed calls after hours and on genuine overflow only. A live-hours AI receptionist is explicitly out of scope.",
      },
      {
        slug: "no-show-defence",
        label: "No-show defence",
        icon: ShieldCheck,
        status: "live",
        note: "Smart confirmations and reminders driven off the live Dentally diary and appointment state machine.",
      },
      {
        slug: "reviews",
        label: "Reviews",
        icon: Star,
        status: "live",
        note: "After each appointment, staff mark who attended and a compliant Google review request is sent automatically a few hours later or the next day, through the consent-aware messaging layer. Requesting reviews is distinct from using testimonials in ads.",
      },
    ],
  },
  {
    label: "Conversational",
    items: [
      {
        slug: "conversations",
        label: "Conversations",
        icon: MessagesSquare,
        status: "live",
        note: "One inbox for every patient conversation across SMS, WhatsApp, after-hours and the lifecycle agents, grouped per person, with the ability to take over and reply yourself. Replies honour consent and opt-outs and are in test mode until go-live.",
      },
      {
        slug: "booking-agent",
        label: "Booking agent",
        icon: Bot,
        status: "live",
        note: "Two-way SMS booking agent. Identifies any inbound number against the patient record, answers replies and enquiries, books appointments, and escalates clinical questions, complaints and anything it is unsure about to a human.",
      },
      {
        slug: "whatsapp",
        label: "WhatsApp agent",
        icon: MessageCircle,
        status: "live",
        note: "Booking, rescheduling, cancelling, reminders, recalls and follow-ups over the WhatsApp Business API, with human escalation and takeover. Connected live to Dentally.",
      },
    ],
  },
  {
    label: "Staff & Ops",
    items: [
      {
        slug: "compliance",
        label: "Compliance",
        icon: ClipboardCheck,
        status: "live",
        roles: OWNER_ROLES,
        note: "CQC and GDC compliance, organised: a readiness dashboard across the five key lines of enquiry, the recurring audit and check calendar (HTM 01-05, IPC, radiography, fire, Legionella), the required policy library, and the staff training matrix, with an AI readiness check. Decision-support and an organiser, not legal advice or a substitute for the practice's compliance lead or CQC sign-off. Mock data for now.",
      },
      {
        slug: "rota",
        label: "Staff rota",
        icon: CalendarRange,
        status: "live",
        roles: OWNER_ROLES,
        note: "Owners and managers set staffing rules; the rota is generated automatically from opening hours and staff availability, and each staff member is texted their shifts.",
      },
      {
        slug: "daily-brief",
        label: "Daily brief",
        icon: Sunrise,
        status: "live",
        note: "Every morning, reads the diary and hands each role a prioritised action list: who to chase, gaps to fill, no-show risks, high-value treatment arriving today.",
      },
      {
        slug: "notifications",
        label: "Notifications",
        icon: Bell,
        status: "live",
        note: "Alerts that need attention now, gathered from compliance, no-show risk, new onboarding submissions and new enquiries.",
      },
      {
        slug: "co-pilot",
        label: "Ask the brain",
        icon: Bot,
        status: "live",
        roles: OWNER_ROLES,
        note: "Practice co-pilot. Ask the knowledge base anything; answers are grounded in stored knowledge and filtered to your access level.",
      },
    ],
  },
  {
    label: "Account",
    items: [
      { slug: "settings", label: "Settings", icon: Settings, status: "live", roles: OWNER_ROLES, note: "Connect your services and go live: integration status (Dentally, messaging, email, reviews, Meta, auth, scheduler), the messaging mode, the practice and its sites, and a go-live checklist. Status only, set the keys to connect." },
    ],
  },
];

/** Flat lookup of every client module path (used for placeholder route generation + guards). */
export const CLIENT_MODULE_SLUGS = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));

/** Whether a role may see/reach a single nav item. No `roles` = open to all. */
function roleCanSeeItem(role: Role, item: NavItem): boolean {
  return !item.roles || item.roles.includes(role);
}

/**
 * The nav groups visible to a role: items the role may not see are dropped, and
 * any group left empty is removed. An item with no `roles` is allowed for all.
 */
export function navForRole(role: Role): NavGroup[] {
  return CLIENT_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => roleCanSeeItem(role, item)),
  })).filter((group) => group.items.length > 0);
}

// ---------------------------------------------------------------------------
// Sidebar categories: the two-level "rail + panel" navigation.
//
// The flat 9-group sidebar showed all ~29 modules at once, which overwhelmed
// non-technical staff. Instead the sidebar shows a slim category rail (five
// plain-English buckets a receptionist thinks in) and the panel lists ONLY the
// selected category's modules. Categories reference CLIENT_NAV items by slug so
// CLIENT_NAV stays the single source of truth for labels/icons/roles/notes
// (command palette, placeholder pages and the systems catalog keep reading it).
// ---------------------------------------------------------------------------

export interface NavCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  /** CLIENT_NAV item slugs shown when this category is selected, in order. */
  slugs: string[];
}

export const NAV_CATEGORIES: NavCategory[] = [
  // "One Front Door": the Home overview absorbs Today (deleted from the nav; its
  // route redirects Home) and hosts the live task queue, so the rail's Home
  // category is just three destinations. Daily brief and Task queue keep their
  // routes (linked from Home as "Morning brief" / "View all tasks", and findable
  // via the command palette) but no longer earn nav entries — see NAV_HIDDEN_SLUGS.
  {
    key: "home",
    label: "Home",
    icon: Home,
    slugs: ["", "calendar", "notifications"],
  },
  {
    key: "patients",
    label: "Patients",
    icon: Users,
    // Onboarding lives here (not Growth): reviewing + registering new-patient form
    // submissions is a reception task, and Patients is where a receptionist looks.
    slugs: ["patients", "payments", "onboarding", "recall", "reactivation", "treatment-coordinator", "no-show-defence", "reviews"],
  },
  {
    key: "messages",
    label: "Messages",
    icon: MessagesSquare,
    slugs: ["conversations", "booking-agent", "whatsapp", "after-hours"],
  },
  {
    key: "growth",
    label: "Growth",
    icon: TrendingUp,
    slugs: ["meta-ads", "smile-assessment", "speed-to-lead", "power-dialler", "usps", "roi"],
  },
  {
    key: "operations",
    label: "Operations",
    icon: Briefcase,
    slugs: ["rota", "compliance", "reports", "co-pilot", "settings"],
  },
];

/**
 * CLIENT_NAV modules that deliberately have NO sidebar category: their content
 * is embedded in (or linked from) the Home overview, but the routes stay alive
 * as deep-link targets and the command palette still finds them by name.
 */
export const NAV_HIDDEN_SLUGS = new Set<string>(["daily-brief", "task-queue"]);

export interface ResolvedNavCategory {
  key: string;
  label: string;
  icon: LucideIcon;
  items: NavItem[];
}

/**
 * The sidebar categories visible to a role, with each category's slugs resolved
 * to full CLIENT_NAV items. Items the role may not see are dropped and a category
 * left empty disappears (e.g. a coordinator sees no Operations rail entry at all,
 * since every module in it is owner-only). `role: null` (dev / enforcement off)
 * shows everything, matching the sidebars' existing fallback behaviour.
 */
export function categoriesForRole(role: Role | null): ResolvedNavCategory[] {
  const bySlug = new Map(CLIENT_NAV.flatMap((g) => g.items).map((i) => [i.slug, i]));
  return NAV_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    icon: c.icon,
    items: c.slugs
      .map((s) => bySlug.get(s))
      .filter((i): i is NavItem => Boolean(i) && (!role || roleCanSeeItem(role, i!))),
  })).filter((c) => c.items.length > 0);
}

/**
 * Slugs that are NOT in CLIENT_NAV but still render under an owner shell and must
 * stay owner-only when reached by direct URL (e.g. the owner-only Practice brain).
 */
const EXTRA_OWNER_ONLY_SLUGS = new Set<string>(["practice-brain"]);

/**
 * Whether a role may access a module by its slug — the single source of truth for
 * both the sidebar filter and the server-side direct-URL guard. A slug with no
 * `roles` entry in CLIENT_NAV is open to all roles; owner-only slugs require an
 * owner/agency role. Slugs not in the nav (e.g. practice-brain) are treated as
 * owner-only when listed in EXTRA_OWNER_ONLY_SLUGS, otherwise open.
 */
export function canRoleAccessModule(role: Role, slug: string): boolean {
  if (EXTRA_OWNER_ONLY_SLUGS.has(slug)) return OWNER_ROLES.includes(role);
  const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);
  if (!item) return true; // unknown slug: not owner-restricted here (the page itself 404s)
  return roleCanSeeItem(role, item);
}
