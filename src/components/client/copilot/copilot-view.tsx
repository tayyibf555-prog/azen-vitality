import { getClient } from "@/lib/mock";
import { CopilotConversation } from "@/components/platform/copilot-conversation";

export function CopilotView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <p className="text-sm text-muted">This client could not be found.</p>;
  }

  return (
    <div className="flex h-[calc(100vh-10rem)] min-h-[480px] flex-col rounded-[15px] bg-card p-4 shadow-float ring-1 ring-line/60">
      <CopilotConversation clientSlug={clientSlug} />
    </div>
  );
}
