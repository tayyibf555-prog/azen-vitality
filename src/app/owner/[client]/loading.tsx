import { DashboardSkeleton } from "@/components/skeletons/dashboard-skeleton";

// Instant content-area fallback while an owner module page resolves. The sidebar
// (in the layout) stays put; only the content swaps for the skeleton.
export default function Loading() {
  return <DashboardSkeleton />;
}
