import { PageHeader } from "@/components/primitives";
import { getClient } from "@/lib/mock/clients";
import { TaskQueueBoard } from "./task-queue-board";

// One prioritised worklist across every module. The board fetches the computed
// tasks live; this server shell just guards the client and frames the page.
export async function TaskQueueView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Task queue" description="This client could not be found." />;
  }

  return (
    <>
      <PageHeader
        title="Task queue"
        description="Everything that needs doing across the practice, most urgent first. Claim a task, mark it done, or snooze it for later."
      />
      <TaskQueueBoard clientSlug={clientSlug} />
    </>
  );
}
