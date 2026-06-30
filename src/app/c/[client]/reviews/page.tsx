import { ReviewsView } from "@/components/client/reviews/reviews-view";

export const dynamic = "force-dynamic";

export default async function ReviewsPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  return <ReviewsView clientSlug={clientSlug} />;
}
