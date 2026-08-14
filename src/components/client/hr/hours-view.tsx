import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { HoursWorkspace } from "./hours-workspace";

// Hours and pay.
//
// The month's worked hours per person, derived from the clock-in and clock-out
// pairs and compared against the rota, with everything unresolved called out
// before the month can be treated as settled.
//
// THE BOUNDARY IS STATED ON THE PAGE, not only in a comment: this is hours and
// cost. It is not payroll. Nothing here is submitted to HMRC, there is no RTI,
// no payslips, no deductions and no pension. It is the figure a practice reads
// to a bookkeeper.
export async function HoursView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Hours and pay" description="This client could not be found." />;
  }

  const scope = await getViewScope(client.id);

  return (
    <>
      <PageHeader
        title="Hours and pay"
        description={
          scope.isAllSites
            ? "Worked hours by person for the month, across all sites, with anything unresolved called out before the month is settled."
            : `Worked hours by person for the month at ${scope.siteName}, with anything unresolved called out before the month is settled.`
        }
      />

      <HoursWorkspace clientSlug={clientSlug} />
    </>
  );
}
