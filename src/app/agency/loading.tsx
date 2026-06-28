import { DashboardSkeleton } from "@/components/skeletons/dashboard-skeleton";

// Instant content-area fallback while an agency page resolves.
export default function Loading() {
  return <DashboardSkeleton />;
}
