import { ReviewsView } from "@/components/client/reviews/reviews-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  await requireModuleAccess("reviews");
  return <ReviewsView clientSlug={clientSlug} />;
}
