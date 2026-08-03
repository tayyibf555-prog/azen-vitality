import { TaskQueueView } from "@/components/client/task-queue/task-queue-view";
import { requireModuleAccess } from "@/lib/auth/page-guard";

export const dynamic = "force-dynamic";

export default async function TaskQueuePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client } = await params;
  await requireModuleAccess("task-queue");
  return <TaskQueueView clientSlug={client} />;
}
