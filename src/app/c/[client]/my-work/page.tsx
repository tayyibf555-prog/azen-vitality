import { MyWorkView } from "@/components/client/my-work/my-work-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function MyWorkPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("my-work");
  return <MyWorkView clientSlug={clientSlug} />;
}
