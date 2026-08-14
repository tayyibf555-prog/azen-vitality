import { StaffHrView } from "@/components/client/hr/staff-hr-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function StaffHrPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  // The page half of the module lock. Without it the module is reachable by URL
  // to any role the /c layout admits, whatever the sidebar shows.
  await requireModuleAccess("staff-hr");
  return <StaffHrView clientSlug={clientSlug} />;
}
