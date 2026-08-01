import Link from "next/link";
import { StatusPill } from "@/components/primitives";
import { PanelEmpty, PanelFailed, PanelNote, PanelSection } from "./panel";
import { CANNOT_READ_COPY, EMPTY_COPY, FAILED_COPY } from "@/lib/patient/tabs";
import { TASK_KIND_LABEL, type Task } from "@/lib/task-queue/types";

/**
 * Tasks: this patient's own open work, and an explicit statement of what it cannot
 * cover.
 *
 * A task reaches this tab ONLY when its module carries a real Dentally patient id on
 * the target: recall, no-show and reactivation. The other four (coordinator,
 * after-hours, speed-to-lead, smile assessment) are keyed by opaque uuids with no
 * patient id at all, and matching them by patientName on a clinical record is not
 * acceptable at any confidence: the first time two patients share a name, this record
 * would show another person's work.
 *
 * So the list is partial and says so. A stated partial list is more useful and more
 * honest than either a name-matched full list or an empty tab.
 */
export function TabTasks({ tasks, failed = false }: { tasks: Task[]; failed?: boolean }) {
  return (
    <div className="space-y-5">
      <PanelSection title="Open tasks for this patient">
        {/* An outage must not print "no open tasks", which is a claim about the work
            rather than about the network. */}
        {failed ? (
          <PanelFailed>{FAILED_COPY.tasks}</PanelFailed>
        ) : tasks.length === 0 ? (
          <PanelEmpty>{EMPTY_COPY.tasks}</PanelEmpty>
        ) : (
          <ul className="divide-y divide-line">
            {tasks.map((t) => (
              <li key={t.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-navy">{t.title}</p>
                  {t.subtitle ? <p className="text-[11.5px] text-muted">{t.subtitle}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <StatusPill tone="neutral">{TASK_KIND_LABEL[t.kind]}</StatusPill>
                  <Link
                    href={t.href}
                    className="rounded-md text-[12px] font-medium text-blue-deep underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/25"
                  >
                    Open worklist
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
        <PanelNote>{CANNOT_READ_COPY.taskScope}</PanelNote>
        <PanelNote>{CANNOT_READ_COPY.dentallyTasks}</PanelNote>
      </PanelSection>
    </div>
  );
}
