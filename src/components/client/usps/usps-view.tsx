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
        description="Your practice's selling points. The AI agents weave these into their conversion messages naturally, so the same true, on-brand reasons to choose you show up everywhere."
      />
      <UspsPanel clientSlug={clientSlug} />
    </>
  );
}
