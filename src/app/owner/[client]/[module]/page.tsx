import { notFound } from "next/navigation";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { ReactivationView } from "@/components/client/reactivation/reactivation-view";
import { RecallView } from "@/components/client/recall/recall-view";
import { NoshowView } from "@/components/client/noshow/noshow-view";
import { AfterHoursView } from "@/components/client/after-hours/after-hours-view";
import { DailyBriefView } from "@/components/client/daily-brief/daily-brief-view";
import { AgentView } from "@/components/client/agent/agent-view";
import { CopilotView } from "@/components/client/copilot/copilot-view";
import { PatientsView } from "@/components/client/patients/patients-view";
import { CalendarView } from "@/components/client/calendar/calendar-view";
import { TodayView } from "@/components/client/today/today-view";
import { PaymentsView } from "@/components/client/payments/payments-view";
import { PracticeBrainView } from "@/components/client/practice-brain";
import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";

export const dynamic = "force-dynamic";

export default async function OwnerModulePage({
  params,
}: {
  params: Promise<{ client: string; module: string }>;
}) {
  const { client, module } = await params;

  if (module === "overview") {
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

  if (module === "after-hours") {
    return <AfterHoursView clientSlug={client} />;
  }

  if (module === "daily-brief") {
    return <DailyBriefView clientSlug={client} />;
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
    return <TodayView clientSlug={client} />;
  }

  if (module === "payments") {
    return <PaymentsView clientSlug={client} />;
  }

  if (module !== "" && CLIENT_MODULE_SLUGS.includes(module)) {
    return <ModulePlaceholder slug={module} />;
  }

  notFound();
}
