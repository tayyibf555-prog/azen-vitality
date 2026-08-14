import { Fp17View } from "@/components/fp17/fp17-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function Fp17Page({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("fp17");
  return <Fp17View clientSlug={clientSlug} />;
}
