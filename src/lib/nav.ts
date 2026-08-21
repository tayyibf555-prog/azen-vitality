import type { LucideIcon } from "lucide-react";
import type { Role } from "@/lib/types";
import {
  BadgeCheck,
  Bell,
  Bot,
  Briefcase,
  CalendarClock,
  CalendarDays,
  CalendarOff,
  CalendarPlus,
  CalendarRange,
  ClipboardCheck,
  Clock,
  FileCheck,
  FileText,
  Fingerprint,
  FolderLock,
  HeartPulse,
  Home,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  ListChecks,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  PhoneCall,
  PhoneMissed,
  Power,
  Rocket,
  RotateCcw,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Sunrise,
  TrendingUp,
  UserPlus,
  UserRound,
  Users,
  Wallet,
  Zap,
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

/**
 * THE CLINICIAN ALLOW-LIST. The complete set of module slugs a `client_clinician`
 * may see in the nav or reach by direct URL. Nothing else. Ever.
 *
 * WHY A SEPARATE SET RATHER THAN `roles` ARRAYS ON THE ITEMS. This nav is
 * allow-BY-DEFAULT: `roleCanSeeItem` returns true for any item with no `roles`
 * array, and `canRoleAccessModule` returns true for a slug it does not recognise
 * at all. Roughly two thirds of the modules carry no `roles` array, so a fourth
 * role added the obvious way would instantly inherit Payments, Recall,
 * Reactivation, Conversations, the agents and the rest — the opposite of what a
 * clinician login is for.
 *
 * The fix could not be "add `roles` arrays to the open items", because that edits
 * the shared allow-lists the existing three roles depend on and cannot be proven
 * non-widening. This set is consulted as the FIRST LINE of both predicates
 * instead, so the existing three roles never reach the new branch and their
 * evaluation path is byte-identical to before. `nav.clinician.test.ts` pins that
 * with a hard-coded snapshot of all three.
 *
 * Start minimal and widen only on written instruction: their own diary, their
 * patients, their holiday requests, their clocking, and the overview they land on.
 */
export const CLINICIAN_SLUGS = new Set<string>([
  "", // the Overview index — where /c/[client] lands them
  "calendar",
  "patients",
  "absence",
  "staff-check-in",
  // ADDED (campaign 6): "my-work" is the staff self-service surface — their own
  // published rota, their own holiday, their own documents, their own policy
  // signatures. A clinician is a member of staff too, and the nav item's `roles`
  // array names them, so leaving it out of this set would have made that array a
  // grant that reads as a grant and does nothing. It adds no data the clinician
  // did not already have: every tab is scoped to the caller's OWN staff record.
  "my-work",
]);

/**
 * THE STAFF ALLOW-LIST. The complete set of module slugs a `client_staff` may see
 * in the nav or reach by direct URL. Two entries. Nothing else. Ever.
 *
 * WHY A FIFTH ROLE RATHER THAN REUSING THE CLINICIAN. `CLINICIAN_SLUGS` grants
 * "calendar" and "patients" — the live diary and the whole 51k-patient database.
 * A nurse or a receptionist must not have either. Narrowing the clinician's set to
 * fit them would break the clinician; widening the staff set to the clinician's is
 * the opposite of what a staff login is for. So they are two allow-lists, not one.
 *
 * WHY AN ALLOW-LIST AT ALL — the same reason as CLINICIAN_SLUGS, and worth
 * restating because it is the entire safety argument: this nav is allow-BY-DEFAULT.
 * `roleCanSeeItem` returns true for any item carrying no `roles` array and
 * `canRoleAccessModule` returns true for a slug it does not recognise, and roughly
 * two thirds of the modules carry no `roles` array. A fifth role added the obvious
 * way would inherit Conversations, Recall, Reactivation, Payments and every agent
 * on day one. The branch below is consulted as the FIRST LINE of both predicates
 * and RETURNS, so the four existing roles never reach it and their evaluation path
 * is byte-identical to before. `nav.staff.test.ts` pins that with hard baselines.
 *
 * The API layer is a SEPARATE lock and does not come free with this one: the
 * thirteen `kind:"clinician"` exemptions in
 * `src/app/api/client-api-module-guard-coverage.test.ts` now each name the exact
 * roles that may reach them, and that test proves this role is refused the diary
 * and the patient database at the route layer too.
 */
export const STAFF_SLUGS = new Set<string>([
  "", // the Overview index — where /c/[client] lands them, as it lands every role
  "my-work", // their rota, their holiday, their documents, their signatures
]);

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
      {
        slug: "my-work",
        label: "My work",
        icon: UserRound,
        status: "live",
        // THE STAFF SELF-SERVICE SURFACE. One slug, five tabs (my rota, my
        // clock, my holiday, my documents, my signatures), every one of them
        // scoped to the CALLER'S OWN staff record resolved from the session —
        // never from a body parameter. It is here in Overview rather than Staff &
        // Ops because it is a personal surface, not a management one.
        //
        // HOW EACH ROLE ACTUALLY REACHES IT, because two different mechanisms are
        // in play and this array only governs one of them:
        //   agency_admin / client_owner / client_coordinator  — this array.
        //   client_clinician  — CLINICIAN_SLUGS (the early return in
        //                       roleCanSeeItem fires before this array is read).
        //   client_staff      — STAFF_SLUGS, same early-return mechanism.
        // They are listed here anyway so the intent is on the record in one place;
        // both allow-lists contain "my-work", so the array and the behaviour agree.
        roles: [
          ...OWNER_ROLES,
          "client_coordinator",
          "client_clinician",
          "client_staff",
        ],
        note: "Your own working page: the shifts you have been published, clocking yourself in and out, your holiday requests and their status, your own documents, and any practice policy waiting for your signature. Everything on it is scoped to you.",
      },
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
        note: "The live Dentally diary. One column per clinician, day by day, with each appointment's state.",
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
      {
        slug: "fp17",
        label: "NHS declarations",
        icon: FileCheck,
        status: "live",
        // Roles: no `roles` array = owner, agency and the practice coordinator can
        // see it (front-desk records work, like Onboarding); the clinician is denied
        // via CLINICIAN_SLUGS. Ships GATED OFF via the kill switch (seeded disabled in
        // migration 0071); the owner turns it on from System controls.
        note: "NHS FP17/PR consent + exemption declarations patients complete from a per-patient link, captured in this platform for the practice's records. It is NOT submitted to the NHS (Compass) from here — the NHS claim is still made in Dentally. Switched off until turned on in System controls.",
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
        slug: "landing-pages",
        label: "Landing pages",
        icon: LayoutTemplate,
        status: "live",
        // Owner, agency AND the practice manager (coordinator) can see this. Unlike
        // its sibling Meta Ads (owner-only, where pages are generated and launched),
        // this section is READ-ONLY: preview every page and read which is converting.
        // The practice manager runs the day-to-day marketing checks, so they get it
        // too; creating and launching pages stays in the owner-only Meta Ads workspace.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "Preview every campaign landing page (drafts open with a preview link) and see how each is performing: total views, the A/B split with per-variant conversion, and which variant is winning, so the best-performing pages are obvious. Pages are created in Meta Ads; this is where you watch and preview them.",
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
        label: "Leads",
        icon: Zap,
        status: "live",
        note: "Every enquiry in one place with its source (Smile Assessment campaign, website, missed call), tabbed by qualification: qualified leads are texted within seconds; close-to-qualified and not-qualified assessments are listed for the team to nurture. First-response time instrumented (5+ min delay correlates with ~9x lower conversion).",
      },
      {
        slug: "onboarding",
        label: "Onboarding",
        icon: UserPlus,
        status: "live",
        note: "A branded new-patient onboarding form at /onboard/<client>: contact, brief medical intake, documents upload and consent, collected step by step. Submissions land here for the team to review and register.",
      },
      {
        slug: "booking",
        label: "Booking",
        icon: CalendarPlus,
        status: "live",
        note: "The patient-facing online booking link for the selected site: a live Dentally diary a patient can pick a time from, with the appointment landing straight in the diary. Shareable link and pre-written message, per site.",
      },
      {
        slug: "outreach",
        label: "Campaigns",
        icon: Send,
        status: "live",
        roles: OWNER_ROLES,
        note: "Segment outreach campaigns: build a list of patients from the existing base (by past treatment, last-visit window, age and gender), preview who matches, then text them a warm invite back, optionally into a chosen clinician's diary. Every send honours consent, opt-outs, a per-campaign daily cap and one message per patient per day. Gated by the Segment outreach switch in System controls.",
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
        // WIDENED (campaign 6), and it is a decision rather than drift. The module
        // note says "owners and managers", but the array said OWNER_ROLES, so the
        // practice manager — a client_coordinator in this platform, and the rota's
        // PRIMARY user — could not open the page or make a single rota API call.
        // Its two siblings below (Holiday & absence, Staff check-in) were widened
        // for exactly this reason and this one was missed. All four rota API routes
        // move from requireOwnerRole to requireApproverRole in the same change, so
        // the page and the API agree; `nav.staff.test.ts` names the delta and pins
        // the route change.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "Owners and managers set staffing rules; the rota is generated automatically from opening hours and staff availability, and each staff member is texted their shifts.",
      },
      {
        slug: "absence",
        label: "Holiday & absence",
        icon: CalendarOff,
        status: "live",
        // The PRACTICE MANAGER is the person who approves holiday, and in this
        // platform she is a client_coordinator, so gating this on OWNER_ROLES alone
        // would lock out its primary user. Clinicians reach it too, but through the
        // CLINICIAN_SLUGS allow-list rather than this array (they request, they do
        // not decide — that split is enforced in the absence rules, not here).
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "Holiday, sickness, training and unpaid leave in one place: staff request time off, the manager approves or refuses, and approved absence is taken out of the generated rota so nobody is rostered on a day they are away. Overlapping requests for the same person are surfaced before a decision, and nobody can approve their own.",
      },
      {
        slug: "staff-check-in",
        label: "Staff check-in",
        icon: Fingerprint,
        status: "live",
        // Same reasoning as Holiday & absence: attendance exceptions are the
        // practice manager's job, so the coordinator role is added alongside the
        // owners. Clinicians clock themselves in via the CLINICIAN_SLUGS allow-list.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "Staff clock in and out on their own phone by tapping an NFC tag mounted at the practice. The tag proves the place (a cryptographic NTAG 424 DNA tag emits a fresh signed code on every tap, so it cannot be photographed, copied or relayed) and their login proves the person. Attendance is compared against the rota and anything unusual (off-network, well before the shift, never clocked out) is raised to the practice manager as an exception rather than blocking anyone. Deliberately NOT biometric: face and fingerprint attendance is special category data, and the ICO has enforced against exactly that use. Self-employed associates are excluded by design, since clocking them like employees carries employment-status risk for the practice.",
      },
      {
        slug: "hours",
        label: "Hours & pay",
        icon: Clock,
        status: "live",
        // Same reasoning as Holiday & absence, Staff check-in and (now) Staff rota:
        // the practice manager runs the month's hours, so the coordinator role sits
        // alongside the owners. HOURS AND COST ONLY — no payments, no HMRC/RTI, no
        // payslips — and the pay columns are omitted SERVER-side for anyone without
        // pay access, never merely hidden in the client.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "The month's worked hours per person, derived from clock-in/out pairs and compared against the rota, with anything unresolved (a missed clock-out, a shift with no clocking) called out before the month can be marked final. Cost is shown only to logins with pay access. Hours and cost only: this is not payroll, and nothing here is submitted to HMRC.",
      },
      {
        slug: "staff-hr",
        label: "Staff HR",
        icon: FolderLock,
        status: "live",
        // Owner + agency + the practice manager, for the same reason as its
        // siblings. Pay rates are a SEPARATE permission inside the module (owner
        // and agency by default), enforced by omitting the fields from the server
        // response, so a coordinator with the module does not thereby see pay.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "The employee file: contact and emergency details, employment dates, holiday entitlement, the document vault (right to work, DBS, GDC registration, indemnity, contracts) with expiry tracking, and the practice policies each person has signed. Employee personal data under UK GDPR: access is logged and pay is a separate permission.",
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
        // WIDENED to the practice manager, and the widening is the whole of
        // Wave 3 #5. It is NOT the owner's co-pilot handed to another role: the
        // page and the route are shared, but `copilotAccessForRole`
        // (src/lib/copilot/scope.ts) derives a SIX-TOOL operational allow-list
        // from the session's role on the server, caps her practice-brain
        // clearance at her own tier, and money-projects the patient record. The
        // owner's surface is unchanged. The clinician and staff roles are still
        // denied — by their own allow-lists, which run before this array.
        //
        // Because `system.copilot.ask` takes its default holders from THIS array
        // (DEFAULT_PROVENANCE: { base: "module", slug: "co-pilot" }), the
        // coordinator also gains that capability by derivation, which is named as
        // a deliberate WIDENED delta in capabilities/non-widening.test.ts — so an
        // owner can still take it away from one named person on the People &
        // logins screen.
        roles: [...OWNER_ROLES, "client_coordinator"],
        note: "Practice co-pilot. Ask the knowledge base anything; answers are grounded in stored knowledge and filtered to your access level. The owner's view reads the whole practice, including money and campaigns; a practice manager's view is the operational one (the diary, patients, enquiries and how the practice does things) and cannot reach financials, reports, marketing performance, the system controls or any way of sending to a patient.",
      },
      {
        slug: "controls",
        label: "System controls",
        icon: Power,
        status: "live",
        roles: OWNER_ROLES,
        note: "The owner's master on/off panel for every automated system (recall, reactivation, no-show defence, the agents, and more). Switching one off is a full kill switch: it hides the module and halts its server-side work, so nothing sends until it is switched back on.",
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        slug: "getting-started",
        label: "Getting started",
        icon: Rocket,
        status: "live",
        // Not owner-only (unlike its Operations siblings): the practice coordinator
        // is normally the one who works through this checklist day to day, so both
        // the owner and the coordinator may see and tick it. No `roles` = every role.
        note: "The go-live checklist: the thirteen items we need from the practice (with three go-live gates that block patient messaging) to move the platform from read-and-review mode to fully live, with per-item detail on what each means and how to do it.",
      },
      {
        slug: "permissions",
        label: "People & logins",
        icon: KeyRound,
        status: "live",
        // OWNER-ONLY, v1, and not negotiable at this level: this is the screen that
        // decides who can reach what. A role that could edit it could grant itself
        // anything, so it stays with the practice owner and the agency admin.
        roles: OWNER_ROLES,
        note: "Who can log in, at what level, and what each level can reach. Invite a colleague by email (they set their own password — no password ever passes through us or the practice), assign their role, link their login to their staff record, and switch an individual permission on or off. Removing access disables the login rather than deleting the record, so the audit trail survives.",
      },
      { slug: "settings", label: "Settings", icon: Settings, status: "live", roles: OWNER_ROLES, note: "Connect your services and go live: integration status (Dentally, messaging, email, reviews, Meta, auth, scheduler), the messaging mode, the practice and its sites, and a go-live checklist. Status only, set the keys to connect." },
    ],
  },
];

/** Flat lookup of every client module path (used for placeholder route generation + guards). */
export const CLIENT_MODULE_SLUGS = CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug));

/** Whether a role may see/reach a single nav item. No `roles` = open to all. */
function roleCanSeeItem(role: Role, item: NavItem): boolean {
  // THE TWO ALLOW-LIST BRANCHES ARE FIRST, AND THEY RETURN. Deny-by-default for
  // the two roles that must not inherit the allow-by-default line below. Because
  // they return before anything else runs, the other three roles evaluate exactly
  // as they did before either branch existed.
  if (role === "client_clinician") return CLINICIAN_SLUGS.has(item.slug);
  if (role === "client_staff") return STAFF_SLUGS.has(item.slug);
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
// Sidebar categories: the five collapsible AREAS of the single-level sidebar.
//
// The flat 9-group sidebar showed all ~29 modules at once, which overwhelmed
// non-technical staff. Instead the sidebar groups them into five plain-English
// buckets a receptionist thinks in. The area holding the current page is open
// and the rest are shut to a labelled header, so the column stays short but
// every module is one click from anywhere. Categories reference CLIENT_NAV items
// by slug so CLIENT_NAV stays the single source of truth for labels, icons,
// roles and notes (the command palette, the placeholder pages and the systems
// catalog keep reading it).
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
    // "my-work" joins Home rather than Operations because it is the person's own
    // page, not a management surface — and because for a client_staff login it is
    // the ONLY other destination they have, so filing it under an "Operations"
    // header would give a receptionist a one-item management area and nothing else.
    slugs: ["", "my-work"],
  },
  // THE DIARY GETS ITS OWN RAIL BUTTON, as it does in the reference, rather than
  // sitting as a tab under Home. It is the most-used screen in the practice and
  // reaching it should never cost a step. Being an area of one module it draws no
  // section bar, so the diary keeps the full height it needs.
  {
    key: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    slugs: ["calendar"],
  },
  {
    key: "patients",
    label: "Patients",
    icon: Users,
    // Onboarding lives here (not Growth): reviewing + registering new-patient form
    // submissions is a reception task, and Patients is where a receptionist looks.
    // NHS declarations (fp17) sits alongside it for the same reason — reviewing
    // captured consent + exemption declarations is front-desk records work.
    slugs: ["patients", "payments", "onboarding", "fp17", "recall", "reactivation", "treatment-coordinator", "no-show-defence", "reviews"],
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
    slugs: ["meta-ads", "landing-pages", "smile-assessment", "speed-to-lead", "booking", "outreach", "power-dialler", "usps", "roi"],
  },
  {
    key: "operations",
    label: "Operations",
    icon: Briefcase,
    // The workforce block (rota -> absence -> check-in -> hours -> HR file) runs in
    // the order a manager works it: who is on, who is off, who turned up, what that
    // came to, and the person's file behind it all.
    slugs: [
      "getting-started",
      "rota",
      "absence",
      "staff-check-in",
      "hours",
      "staff-hr",
      "compliance",
      "reports",
      "co-pilot",
      "controls",
      "permissions",
      "settings",
    ],
  },
];

/**
 * CLIENT_NAV modules that deliberately have NO sidebar category: their content
 * is embedded in (or linked from) the Home overview, but the routes stay alive
 * as deep-link targets and the command palette still finds them by name.
 */
// Routes that exist and stay reachable, but earn no nav entry.
//
// "notifications" joined them because it was showing TWICE: as a bell in the top
// bar and as a tab in Home's section bar. The bell is the right home for it, and
// it now opens a preview with a link through to this page, so the page is where
// "view all" lands rather than a place you navigate to directly.
export const NAV_HIDDEN_SLUGS = new Set<string>(["daily-brief", "task-queue", "notifications"]);

/**
 * Slugs that are MANAGEMENT surfaces for a controllable system, and so must stay in
 * the nav even when that system's kill switch is OFF (like System controls, which is
 * never a system itself). Segment outreach seeds OFF: switching it off must halt its
 * sends + sweep (enforced in the sweep + drain), but must NOT hide the page where the
 * owner reviews campaigns and turns it back on. The Launch action there is separately
 * gated in-page, so an off switch means "cannot launch", not "cannot reach".
 */
export const NAV_SWITCH_EXEMPT_SLUGS = new Set<string>(["outreach"]);

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
export function categoriesForRole(
  role: Role | null,
  disabledSlugs?: ReadonlySet<string>,
): ResolvedNavCategory[] {
  const bySlug = new Map(CLIENT_NAV.flatMap((g) => g.items).map((i) => [i.slug, i]));
  return NAV_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    icon: c.icon,
    items: c.slugs
      .map((s) => bySlug.get(s))
      // Drop items this role may not see, and any system the owner has switched
      // OFF (the kill switch hides the module; System controls is never a
      // controllable system, so it is never hidden and stays reachable). Management
      // surfaces in NAV_SWITCH_EXEMPT_SLUGS also stay reachable when their own switch
      // is off, so the owner can review + re-enable them.
      .filter(
        (i): i is NavItem =>
          Boolean(i) &&
          (!role || roleCanSeeItem(role, i!)) &&
          (!disabledSlugs?.has(i!.slug) || NAV_SWITCH_EXEMPT_SLUGS.has(i!.slug)),
      ),
  })).filter((c) => c.items.length > 0);
}

/**
 * Slugs that are NOT in CLIENT_NAV but still render under an owner shell and must
 * stay owner-only when reached by direct URL (e.g. the owner-only Practice brain).
 */
export const EXTRA_OWNER_ONLY_SLUGS = new Set<string>(["practice-brain"]);

/**
 * Whether a role may access a module by its slug — the single source of truth for
 * both the sidebar filter and the server-side direct-URL guard. A slug with no
 * `roles` entry in CLIENT_NAV is open to all roles; owner-only slugs require an
 * owner/agency role. Slugs not in the nav (e.g. practice-brain) are treated as
 * owner-only when listed in EXTRA_OWNER_ONLY_SLUGS, otherwise open.
 */
export function canRoleAccessModule(role: Role, slug: string): boolean {
  // THE TWO ALLOW-LIST BRANCHES ARE FIRST, AND THEY RETURN — see CLINICIAN_SLUGS
  // and STAFF_SLUGS. They have to precede the `if (!item) return true`
  // fall-through below, which would otherwise hand an unrecognised slug straight
  // to a deny-by-default role: any module added without a nav entry would be open
  // to it. The other three roles never reach these lines, so nothing about their
  // access changed.
  if (role === "client_clinician") return CLINICIAN_SLUGS.has(slug);
  if (role === "client_staff") return STAFF_SLUGS.has(slug);
  if (EXTRA_OWNER_ONLY_SLUGS.has(slug)) return OWNER_ROLES.includes(role);
  const item = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === slug);
  if (!item) return true; // unknown slug: not owner-restricted here (the page itself 404s)
  return roleCanSeeItem(role, item);
}

// ---------------------------------------------------------------------------
// WHERE THE INDEX LANDS A ROLE.
// ---------------------------------------------------------------------------
/**
 * The page `/c/[client]` should forward this role to, or null to render the
 * Overview it already renders.
 *
 * WHY THIS EXISTS AT ALL, and why it is not simply STAFF_SLUGS losing "".
 * `/c/[client]` IS the practice dashboard: the takings strip, outstanding
 * accounts, invoiced totals, UDA, and the day's appointment list carrying
 * patient names. That is the money and the diary — precisely the two things a
 * `client_staff` login exists NOT to have. But "" has to stay in STAFF_SLUGS,
 * because "/" routes every non-agency, non-owner role to /c/[client] and the
 * shell's `guardPage` admits them there: removing "" would bounce a staff login
 * from "/" to /c/[client] to "/" for ever. So the ALLOW-LIST admits them to the
 * route and the PAGE forwards them, which is the only arrangement that is both
 * loop-free and safe.
 *
 * A pure function rather than an `if` in the page for the usual reason: an
 * `if (user.role === "client_staff")` buried in a server component is a rule
 * nothing can test, and this is the one rule standing between a receptionist and
 * the practice's takings. It is called from the page BEFORE any dashboard read,
 * so the numbers are never even fetched for a role that may not see them.
 */
export function indexRedirectFor(role: Role, clientSlug: string): string | null {
  // Deny-by-default in spirit: only the roles whose OWN allow-list contains the
  // index render it. `client_staff` holds "" so the layout admits them, and is
  // sent to the one surface built for them instead.
  if (role === "client_staff") return `/c/${clientSlug}/my-work`;
  return null;
}
