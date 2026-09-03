import { PageHeader } from "@/components/primitives";
import { SyncStatusView } from "@/components/client/systems/sync-status-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

// The deep link for the Dentally sync record. The same view is also a tab of
// System controls, which is how the owner tree (/owner/[client]/controls) reaches
// it — that route resolves ONE dynamic module segment and has no nested paths, so
// a page under it would not be routable.
//
// GUARDED WITH THE SAME SLUG AS ITS PARENT. "controls" is owner + agency only,
// and this page shows which systems have written to which Dentally records — an
// owner's question, not a coordinator's. The filesystem sweep in
// client-module-guard-coverage.test.ts walks ONE level under /c/[client], so a
// nested page like this one is invisible to it; its guard is asserted by name in
// src/lib/dentally/sync-surface.test.ts instead, which is why that assertion
// exists rather than being left to the sweep.
export default async function ControlsSyncPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("controls");
  return (
    <>
      <PageHeader
        title="Dentally sync"
        description="What this platform writes back to your Dentally account, what it cannot write back and why, and a record of every write it has made or held back."
      />
      <SyncStatusView clientSlug={clientSlug} />
    </>
  );
}
