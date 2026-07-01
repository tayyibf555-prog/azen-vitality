import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { UspsPanel } from "./usps-panel";

export async function UspsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="USPs" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="USPs"
        description="Your practice's selling points, which the AI agents weave naturally into their conversion messages everywhere."
      />
      <UspsPanel clientSlug={clientSlug} />
    </>
  );
}
