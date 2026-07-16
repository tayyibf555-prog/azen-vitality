import { FeedbackList } from "@/components/agency/feedback-list";

// Agency-admin only via the /agency layout guard (src/app/agency/layout.tsx).
export default function AgencyFeedbackPage() {
  return <FeedbackList />;
}
