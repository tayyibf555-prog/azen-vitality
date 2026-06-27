import { TaskQueueView } from "@/components/client/task-queue/task-queue-view";

export const dynamic = "force-dynamic";

export default async function TaskQueuePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  return <TaskQueueView clientSlug={client} />;
}
