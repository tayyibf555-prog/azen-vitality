import { notFound } from "next/navigation";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { TreatmentCoordinatorView } from "@/components/client/coordinator/treatment-coordinator-view";
import { ModulePlaceholder } from "@/components/client/module-placeholder";
import { AgentSection } from "@/components/client/agent/agent-section";
import { CLIENT_MODULE_SLUGS } from "@/lib/nav";
import { getClient, getSites } from "@/lib/mock";

export const dynamic = "force-dynamic";

export default async function OwnerModulePage({
  params,
}: {
  params: Promise<{ client: string; module: string }>;
}) {
  const { client, module } = await params;

  if (module === "overview") {
    const c = getClient(client);
    const siteIds = c ? getSites(c.id).map((s) => s.id) : [];
    return (
      <>
        <AgentSection siteIds={siteIds} />
        <OverviewDashboard />
      </>
    );
  }

  if (module === "treatment-coordinator") {
    return <TreatmentCoordinatorView clientSlug={client} />;
  }

  if (module !== "" && CLIENT_MODULE_SLUGS.includes(module)) {
    return <ModulePlaceholder slug={module} />;
  }

  notFound();
}
