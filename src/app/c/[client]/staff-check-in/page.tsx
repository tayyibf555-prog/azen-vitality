import { StaffCheckInView } from "@/components/client/staff-check-in/staff-check-in-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function StaffCheckInPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("staff-check-in");
  return <StaffCheckInView clientSlug={clientSlug} />;
}
