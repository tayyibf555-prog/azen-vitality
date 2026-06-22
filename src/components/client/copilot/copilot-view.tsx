import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock";
import { CopilotConversation } from "@/components/platform/copilot-conversation";

export function CopilotView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Co-pilot" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="Co-pilot"
        description="Your practice assistant with full visibility of the database. Ask about any patient, today's diary, outstanding balances, or how the practice is doing. Tip: press ⌘K to search and ⌘J to open this anywhere."
      />
      <div className="flex h-[calc(100vh-15rem)] min-h-[420px] flex-col rounded-xl border border-line bg-card p-4">
        <CopilotConversation clientSlug={clientSlug} />
      </div>
    </>
  );
}
