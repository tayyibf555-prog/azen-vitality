import {
  CalendarDays,
  PhoneMissed,
  PoundSterling,
  ShieldAlert,
  Clock,
  Sparkles,
} from "lucide-react";
import { PageHeader, StatCard } from "@/components/primitives";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import { DiaryRail } from "@/components/client/home/diary-rail";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { getClient, getSites } from "@/lib/mock/clients";
import { getClientMetrics } from "@/lib/mock";
import { getSessionUser } from "@/lib/auth/session";
import { OWNER_ROLES } from "@/lib/nav";
import { generateBrief } from "@/lib/daily-brief/generate";
import type { DailyBrief } from "@/lib/daily-brief/types";
import { getTodayDiary } from "@/lib/home/diary";
import { gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

// "One Front Door": the landing page IS the working page. The old Today page and
// the Daily brief's day summary fold in here; the live task queue is the centre.
// A receptionist gets "what now" in one glance and the list refreshes as she
// works it; the owner additionally gets the proof-of-value band below (server-
// gated — coordinators never receive that markup).

function longDate(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}

export default async function ClientHomePage({
  params,
}: {
  params: Promise<{ client: string }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Home" description="This client could not be found." />;
  }

  // Role from the verified session; when auth is unenforced (pilot/dev) fall back
  // to the owner view, matching every other page's behaviour.
  let isOwner = true;
  try {
    const user = await getSessionUser();
    if (user) isOwner = OWNER_ROLES.includes(user.role);
  } catch {
    // unenforced / no session: keep the owner default.
  }

  const now = new Date();
  const siteIds = getSites(client.id).map((s) => s.id);

  // Both data loads are best-effort: a failed read renders an empty section, never
  // a broken landing page.
  let brief: DailyBrief;
  try {
    brief = await generateBrief({
      clientId: client.id,
      siteIds,
      role: isOwner ? "client_owner" : "client_coordinator",
      now,
    });
  } catch {
    brief = {
      generatedAt: now.toISOString(),
      role: isOwner ? "client_owner" : "client_coordinator",
      appointmentsToday: 0,
      sections: [],
      headline: [],
    };
  }
  const diary = await getTodayDiary(client.id, now);

  // Day stats, computed the same way the Daily brief page computes them.
  const noshowLine = brief.sections.find((s) => s.key === "noshow")?.items[0];
  const overnightLine = brief.sections.find((s) => s.key === "overnight")?.items[0];
  const moneyLine = brief.sections.find((s) => s.key === "money")?.items[0];
  const headline = brief.headline[0] ?? null;
  const recovered = getClientMetrics(client.id)?.recoveredRevenue ?? 0;
  const briefHref = `/c/${clientSlug}/daily-brief`;

  return (
    <>
      {/* Day header: the 3-second answer. */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-navy">{longDate(now)}</h1>
            <p className="mt-0.5 text-sm text-muted">
              {isOwner
                ? "Here is the morning picture across your sites. Start at the top."
                : "Here is your morning. Start at the top."}
            </p>
          </div>
          {diary.next ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-blue-dark/20 bg-blue-dark/10 px-3.5 py-1.5 text-sm font-semibold text-blue-dark">
              <Clock size={15} className="shrink-0" />
              Next: {diary.next.time} · {diary.next.label}
            </span>
          ) : null}
        </div>

        <div className={isOwner ? "grid grid-cols-2 gap-4 lg:grid-cols-5" : "grid grid-cols-2 gap-4 lg:grid-cols-4"}>
          <StatCard
            label="Appointments today"
            value={String(brief.appointmentsToday)}
            icon={CalendarDays}
            hint="Across your sites"
          />
          <StatCard
            label="To confirm"
            value={String(noshowLine?.count ?? 0)}
            icon={ShieldAlert}
            hint="High no-show risk"
          />
          <StatCard
            label="Overnight"
            value={String(overnightLine?.count ?? 0)}
            icon={PhoneMissed}
            hint="Missed after hours"
          />
          <StatCard
            label="Outstanding"
            value={moneyLine?.value !== undefined ? gbp(moneyLine.value) : gbp(0)}
            icon={PoundSterling}
            hint="Owed across plans"
          />
          {isOwner ? (
            <StatCard
              emphasis
              label="Recovered this month"
              value={gbp(recovered)}
              icon={PoundSterling}
              hint="Pilot figure until live data connects"
            />
          ) : null}
        </div>

        <p className="text-sm text-muted">
          <Sparkles size={14} className="mr-1.5 inline-block align-[-2px] text-blue-dark" aria-hidden="true" />
          {headline ? (
            <>
              <span className="font-semibold text-navy">{headline.title}.</span> {headline.detail}{" "}
            </>
          ) : (
            <>Nothing is on fire this morning. </>
          )}
          <a href={briefHref} className="font-semibold text-blue-dark hover:underline">
            Morning brief
          </a>
        </p>
      </section>

      {/* The working centre: the live queue beside today's diary. */}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TaskQueueBoard
            clientSlug={clientSlug}
            maxRows={8}
            title="Next actions"
            description="The highest-priority work across every module. Finish one and the next slides in."
          />
        </div>
        <DiaryRail diary={diary} clientSlug={clientSlug} />
      </div>

      {/* Owner band: is it paying off. Server-gated — coordinators never receive it. */}
      {isOwner ? <OverviewDashboard hideHero variant="embedded" /> : null}
    </>
  );
}
