import { DashboardSkeleton } from "@/components/skeletons/dashboard-skeleton";

// Shown instantly in the content area while a tab's server page resolves. The
// sidebar + topbar live in the layout, so they stay put: only this swaps for the
// skeleton, then the real content streams in. Makes tab switching feel immediate.
export default function Loading() {
  return <DashboardSkeleton />;
}
