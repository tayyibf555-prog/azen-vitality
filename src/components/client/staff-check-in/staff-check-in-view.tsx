import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { CheckInWorkspace } from "./check-in-workspace";

// Staff check-in.
//
// Staff clock in when they arrive and out when they leave; their login proves
// who they are. Attendance is compared against the rota and anything unusual is
// raised to the practice manager as an exception rather than blocking anybody.
//
// Deliberately NOT biometric: face and fingerprint attendance is special
// category data and the ICO has enforced against exactly that use. The NFC tag
// path (a signed code per tap, proving the place) is a later addition; the
// stored source enum already carries it.
export async function StaffCheckInView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Staff check-in" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);

  return (
    <>
      <PageHeader
        title="Staff check-in"
        description={
          scope.isAllSites
            ? "Who is in across all sites right now, who is expected from the rota, and anything worth a look."
            : `Who is in at ${scope.siteName} right now, who is expected from the rota, and anything worth a look.`
        }
      />

      <CheckInWorkspace clientSlug={clientSlug} />
    </>
  );
}
