import { notFound } from "next/navigation";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { SystemsView } from "@/components/client/systems-view";
import { CopilotView } from "@/components/client/copilot-view";
import { PatientsView } from "@/components/client/patients-view";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";

export const dynamic = "force-dynamic";

export default async function OwnerModulePage({
  params,
}: {
  params: Promise<{ client: string; module: string }>;
}) {
  const { client, module } = await params;

  if (module === "overview" || module === "analytics") {
    // The manager's "relevant analytics" reuses the existing analytics dashboard.
    return <OverviewDashboard />;
  }

  if (module === "treatment-coordinator") {
    return <TreatmentCoordinatorView clientSlug={client} />;
  }

  if (module === "systems") {
    return <SystemsView />;
  }

  if (module === "co-pilot") {
    return <CopilotView />;
  }

  if (module === "patients") {
    return <PatientsView />;
  }

  if (module !== "" && CLIENT_MODULE_SLUGS.includes(module)) {
    return <ModulePlaceholder slug={module} />;
  }

  notFound();
}
