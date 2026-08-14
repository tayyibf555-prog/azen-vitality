import { notFound, redirect } from "next/navigation";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { ReactivationView } from "@/components/client/reactivation/reactivation-view";
import { RecallView } from "@/components/client/recall/recall-view";
import { NoshowView } from "@/components/client/noshow/noshow-view";
import { SmileAssessmentView } from "@/components/client/smile-assessment/smile-assessment-view";
import { MetaAdsView } from "@/components/client/meta-ads/meta-ads-view";
import { LandingPagesView } from "@/components/client/landing-pages/landing-pages-view";
import { BookingView } from "@/components/client/booking/booking-view";
import { OutreachCampaignsView } from "@/components/client/outreach/campaigns-view";
import { RoiView } from "@/components/client/roi/roi-view";
import { ReportsView } from "@/components/client/reports/reports-view";
import { ComplianceView } from "@/components/client/compliance/compliance-view";
import { RotaView } from "@/components/client/rota/rota-view";
import { AbsenceView } from "@/components/client/absence/absence-view";
import { StaffCheckInView } from "@/components/client/staff-check-in/staff-check-in-view";
import { StaffHrView } from "@/components/client/hr/staff-hr-view";
import { HoursView } from "@/components/client/hr/hours-view";
import { MyWorkView } from "@/components/client/my-work/my-work-view";
import { PeopleLogins } from "@/components/client/permissions/people-logins";
import { PermissionsView } from "@/components/client/permissions/permissions-view";
import { ReviewsView } from "@/components/client/reviews/reviews-view";
import { UspsView } from "@/components/client/usps/usps-view";
import { SpeedToLeadView } from "@/components/client/speed-to-lead/speed-to-lead-view";
import { OnboardingView } from "@/components/client/onboarding/onboarding-view";
import { Fp17View } from "@/components/fp17/fp17-view";
import { AfterHoursView } from "@/components/client/after-hours/after-hours-view";
import { DailyBriefView } from "@/components/client/daily-brief/daily-brief-view";
import { AgentView } from "@/components/client/agent/agent-view";
import { InboxView } from "@/components/client/inbox/inbox-view";
import { CopilotView } from "@/components/client/copilot/copilot-view";
import { PatientsView } from "@/components/client/patients/patients-view";
import { CalendarView } from "@/components/client/calendar/calendar-view";
import { PaymentsView } from "@/components/client/payments/payments-view";
import { TaskQueueView } from "@/components/client/task-queue/task-queue-view";
import { NotificationsView } from "@/components/client/notifications/notifications-view";
import { PracticeBrainView } from "@/components/client/practice-brain";
import { SettingsView } from "@/components/client/settings/settings-view";
import { SystemsView } from "@/components/client/systems/systems-view";
import { GettingStartedView } from "@/components/client/getting-started/getting-started-view";
import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function OwnerModulePage({
  params,
}: {
  params: Promise<{ client: string; module: string }>;
}) {
  const { client, module } = await params;

  // Block direct-URL access to owner-only modules for roles that may not reach
  // them (no-op when enforcement is off, and a pass-through for owner/agency).
  await requireModuleAccess(module);

  if (module === "overview") {
    // Honour the top-bar site switcher like the owner home page: without siteIds the
    // dashboard falls back to every site and labels itself a cross-site view even
    // when a single site is selected.
    const clientRecord = getClient(client);
    if (clientRecord) {
      const scope = await getViewScope(clientRecord.id);
      return <OverviewDashboard siteIds={scope.siteIds} />;
    }
    return <OverviewDashboard />;
  }

  if (module === "treatment-coordinator") {
    return <TreatmentCoordinatorView clientSlug={client} />;
  }

  if (module === "reactivation") {
    return <ReactivationView clientSlug={client} />;
  }

  if (module === "recall") {
    return <RecallView clientSlug={client} />;
  }

  if (module === "no-show-defence") {
    return <NoshowView clientSlug={client} />;
  }

  if (module === "smile-assessment") {
    return <SmileAssessmentView clientSlug={client} />;
  }

  if (module === "meta-ads") {
    return <MetaAdsView clientSlug={client} />;
  }

  if (module === "roi") {
    return <RoiView clientSlug={client} />;
  }

  if (module === "reports") {
    return <ReportsView clientSlug={client} />;
  }

  if (module === "compliance") {
    return <ComplianceView clientSlug={client} />;
  }

  if (module === "rota") {
    return <RotaView clientSlug={client} />;
  }

  // The two People modules. Both are status:"live" in CLIENT_NAV, so
  // owner-module-coverage.test.ts requires an entry here: without one the owner view
  // silently shows "this module is being built" while the client view shows the real
  // thing, which is the exact drift that test exists to catch.
  if (module === "absence") {
    return <AbsenceView clientSlug={client} />;
  }

  if (module === "staff-check-in") {
    return <StaffCheckInView clientSlug={client} />;
  }

  // ---------------------------------------------------------------------------
  // The campaign 6 workforce modules. Same rule as the two above: each is
  // status:"live" in CLIENT_NAV, so owner-module-coverage.test.ts requires a
  // literal branch here. Without one the owner sees "this module is being built"
  // while the practice sees the real screen — the exact drift that test exists
  // to catch, and the reason the /owner if-chain is the integrator's file.
  // ---------------------------------------------------------------------------
  if (module === "staff-hr") {
    // The document vault and the policy e-sign panels mount INSIDE StaffHrView
    // (its own documented seam), so this branch stays one line as they land.
    return <StaffHrView clientSlug={client} />;
  }

  if (module === "hours") {
    return <HoursView clientSlug={client} />;
  }

  if (module === "my-work") {
    // Deliberately reachable from the owner shell too. "My work" is the caller's
    // OWN rota, holiday, documents and signatures, resolved from the session —
    // an owner who also works clinical days has one, and the page shows theirs,
    // never somebody else's.
    return <MyWorkView clientSlug={client} />;
  }

  if (module === "permissions") {
    // BOTH panels, in the same order as /c/[client]/permissions: who can log in,
    // then what each of them may do. Owner parity means the same screen, not a
    // subset of it — a half-provisioned login is what happens when the invite
    // half is only on one of the two routes.
    return (
      <>
        <PeopleLogins clientSlug={client} />
        <PermissionsView clientSlug={client} />
      </>
    );
  }

  if (module === "reviews") {
    return <ReviewsView clientSlug={client} />;
  }

  if (module === "speed-to-lead") {
    return <SpeedToLeadView clientSlug={client} />;
  }

  if (module === "onboarding") {
    return <OnboardingView clientSlug={client} />;
  }

  // NHS FP17/PR consent + exemption declarations. A dedicated /owner/[client]/fp17
  // page shadows this branch at runtime (owner parity), but owner-module-coverage
  // requires the literal here, exactly like `patients`.
  if (module === "fp17") {
    return <Fp17View clientSlug={client} />;
  }

  if (module === "after-hours") {
    return <AfterHoursView clientSlug={client} />;
  }

  if (module === "daily-brief") {
    return <DailyBriefView clientSlug={client} />;
  }

  if (module === "conversations") {
    return <InboxView clientSlug={client} />;
  }

  if (module === "booking-agent") {
    return <AgentView clientSlug={client} channel="sms" />;
  }

  if (module === "whatsapp") {
    return <AgentView clientSlug={client} channel="whatsapp" />;
  }

  if (module === "co-pilot") {
    return <CopilotView clientSlug={client} />;
  }

  if (module === "practice-brain") {
    return <PracticeBrainView />;
  }

  if (module === "patients") {
    return <PatientsView clientSlug={client} />;
  }

  if (module === "calendar") {
    return <CalendarView clientSlug={client} />;
  }

  if (module === "today") {
    // Today folded into the front door ("One Front Door" layout).
    redirect(`/owner/${client}/overview`);
  }

  if (module === "payments") {
    return <PaymentsView clientSlug={client} />;
  }

  if (module === "usps") {
    return <UspsView clientSlug={client} />;
  }

  if (module === "task-queue") {
    return <TaskQueueView clientSlug={client} />;
  }

  if (module === "notifications") {
    return <NotificationsView clientSlug={client} />;
  }

  if (module === "settings") {
    return <SettingsView clientSlug={client} />;
  }

  if (module === "controls") {
    return <SystemsView clientSlug={client} />;
  }

  if (module === "getting-started") {
    return <GettingStartedView clientSlug={client} />;
  }

  if (module === "landing-pages") {
    return <LandingPagesView clientSlug={client} />;
  }

  if (module === "booking") {
    return <BookingView clientSlug={client} />;
  }

  if (module === "outreach") {
    return <OutreachCampaignsView clientSlug={client} />;
  }

  if (module !== "" && CLIENT_MODULE_SLUGS.includes(module)) {
    return <ModulePlaceholder slug={module} />;
  }

  notFound();
}
