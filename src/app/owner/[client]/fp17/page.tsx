import { Fp17View } from "@/components/fp17/fp17-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

// The owner tree's NHS exemption declarations page.
//
// It exists as a DEDICATED folder rather than only as a branch of
// /owner/[client]/[module] so the owner view is byte-identical to the client one
// (owner parity). A static `fp17` segment shadows [module] for this segment, so the
// `module === "fp17"` branch in that if-chain is unreachable — it is left in place
// deliberately because owner-module-coverage.test.ts matches on that literal, exactly
// as the `patients` page does.
export default async function OwnerFp17Page({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("fp17");
  return <Fp17View clientSlug={clientSlug} />;
}
