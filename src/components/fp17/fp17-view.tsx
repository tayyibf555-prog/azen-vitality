import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { FP17_COPY } from "@/lib/fp17/copy";
import { Fp17Worklist } from "./fp17-worklist";

// NHS exemption declarations — internal staff view. Rendered by BOTH the client
// worklist page (/c/[client]/fp17) and the owner page (/owner/[client]/fp17), so the
// two stay identical (owner parity). The headline figures + worklist are fetched
// client-side from the auth-gated /api/fp17/list.

export function Fp17View({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title={FP17_COPY.title} description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader title={FP17_COPY.title} description={FP17_COPY.staffDescription} />
      <div className="mt-5">
        <Fp17Worklist clientSlug={clientSlug} />
      </div>
    </>
  );
}
