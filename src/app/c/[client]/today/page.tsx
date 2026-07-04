import { redirect } from "next/navigation";

// "One Front Door": Today folded into the client Home page. Keep the route so
// old bookmarks and palette deep-links land somewhere sensible.
export default async function TodayPage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  redirect(`/c/${client}`);
}
