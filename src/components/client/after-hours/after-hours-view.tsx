import { PhoneMissed, Inbox, CheckCircle2, CalendarCheck, Clock } from "lucide-react";
import { PageHeader, StatCard, EmptyState } from "@/components/primitives";
import { Worklist } from "./worklist";
import { getClient, getSites } from "@/lib/mock/clients";
import { listCaptures } from "@/lib/after-hours/repository";
import type { AfterHoursCapture } from "@/lib/after-hours/types";

async function loadCaptures(siteIds: string[]): Promise<AfterHoursCapture[]> {
  try {
    return await listCaptures({ siteIds });
  } catch {
    return [];
  }
}

function isToday(iso: string, now: Date): boolean {
  const d = new Date(iso);
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export async function AfterHoursView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="After-hours capture" description="This client could not be found." />;
  }

  const siteIds = getSites(client.id).map((s) => s.id);
  const captures = await loadCaptures(siteIds);
  // After-hours is forward-looking: anchor to the real present, not the mock NOW.
  const now = new Date();
  const nowIso = now.toISOString();

  const newCount = captures.filter((c) => c.status === "new").length;
  const followedUp = captures.filter((c) => c.status === "followed_up").length;
  const booked = captures.filter((c) => c.status === "booked").length;
  const today = captures.filter((c) => isToday(c.capturedAt, now)).length;

  return (
    <>
      <PageHeader
        hero
        title="After-hours capture"
        description="Answers missed and overflow calls out of hours, follows up by text, and logs every one into a worklist the team clears in the morning."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="New" value={newCount} icon={Inbox} hint="Awaiting a follow-up" />
        <StatCard label="Followed up" value={followedUp} icon={CheckCircle2} hint="Team reached back out" />
        <StatCard label="Booked" value={booked} icon={CalendarCheck} hint="Turned into an appointment" />
        <StatCard label="Today" value={today} icon={Clock} hint="Captured today" />
      </div>

      {captures.length === 0 ? (
        <EmptyState
          icon={PhoneMissed}
          title="No after-hours captures yet"
          description="Missed calls and out-of-hours messages will land here. This view is mock safe, so it stays empty until contact arrives while a site is closed."
        />
      ) : (
        <Worklist captures={captures} nowIso={nowIso} />
      )}
    </>
  );
}
