import { Clock, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/primitives";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import { DiaryTimeline } from "@/components/client/home/diary-timeline";
import { MiniMonth } from "@/components/client/home/mini-month";
import { NeedsAttention } from "@/components/client/home/needs-attention";
import { OverviewDashboard } from "@/components/client/overview-dashboard";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { getSiteMetrics } from "@/lib/mock";
import { getSessionUser } from "@/lib/auth/session";
import { OWNER_ROLES } from "@/lib/nav";
import { generateBrief } from "@/lib/daily-brief/generate";
import type { DailyBrief } from "@/lib/daily-brief/types";
import { getTodayDiary } from "@/lib/home/diary";
import { gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

// "One Front Door": the landing page IS the working page, arranged to the
// approved aesthetic study. The diary timeline is the hero, a rail carries the
// month at a glance and what needs attention, and the day's numbers, worklist
// and owner band follow as hairline-separated sections. Nothing shown to the
// client before this layout has been removed; it has been repositioned.

function longDate(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}

/** A quiet big-numeral text stat (the aesthetic-shell replacement for stat cards). */
function NumberStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | number;
  hint: string;
}) {
  return (
    <div>
      <p className="text-label text-muted">{label}</p>
      <p className="mt-1 text-display tabular-nums text-navy">{value}</p>
      <p className="mt-0.5 text-caption text-muted">{hint}</p>
    </div>
  );
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
  const scope = await getViewScope(client.id);
  const siteIds = scope.siteIds;

  // Both data loads are best-effort: a failed read renders an empty section, never
  // a broken landing page.
  // The two loads run CONCURRENTLY: the diary no longer waits behind the whole
  // brief (nor behind the brief's slowest builder). Each has its own fallback so a
  // failed read renders empty, never a broken page. They share ONE underlying
  // today-appointments fetch (listAppointments is request-memoized), so running them
  // together does not double the upstream load.
  const [brief, diary] = await Promise.all([
    generateBrief({
      clientId: client.id,
      siteIds,
      role: isOwner ? "client_owner" : "client_coordinator",
      now,
    }).catch(
      (): DailyBrief => ({
        generatedAt: now.toISOString(),
        role: isOwner ? "client_owner" : "client_coordinator",
        appointmentsToday: 0,
        sections: [],
        headline: [],
      }),
    ),
    getTodayDiary(client.id, now, siteIds).catch(() => ({
      slots: [],
      next: null,
      fillPercent: null,
      gapCount: 0,
    })),
  ]);

  // Day figures, computed the same way the Daily brief page computes them.
  const noshowLine = brief.sections.find((s) => s.key === "noshow")?.items[0];
  const overnightLine = brief.sections.find((s) => s.key === "overnight")?.items[0];
  const moneyLine = brief.sections.find((s) => s.key === "money")?.items[0];
  const headline = brief.headline[0] ?? null;
  const riskCount = diary.slots.filter((s) => s.state === "risk").length;
  // Scope the recovered-revenue figure to the selected site(s) (default N15) so it
  // matches the rest of the dashboard rather than always summing every practice.
  const recovered = getSiteMetrics(siteIds).reduce((sum, s) => sum + s.recoveredRevenue, 0);
  const briefHref = `/c/${clientSlug}/daily-brief`;

  return (
    <>
      {/* Day header: the 3-second answer. */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-display text-navy">{longDate(now)}</h1>
            <p className="mt-1 text-body text-muted">
              {isOwner
                ? scope.isAllSites
                  ? "Here is the morning picture across your sites. Start at the top."
                  : `Here is the morning picture for ${scope.siteName}. Start at the top.`
                : "Here is your morning. Start at the top."}
            </p>
          </div>
          {diary.next ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-tint-blue-line bg-tint-blue px-3.5 py-1.5 text-sm font-semibold text-status-blue">
              <Clock size={15} className="shrink-0" />
              Next: {diary.next.time} · {diary.next.label}
            </span>
          ) : null}
        </div>

        <p className="text-body text-muted">
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

      {/* Hero: the diary timeline beside the month + needs-attention rail. */}
      <div className="grid items-start gap-x-10 gap-y-8 lg:grid-cols-[minmax(0,1fr)_332px]">
        <DiaryTimeline
          diary={diary}
          clientSlug={clientSlug}
          stats={{
            booked: brief.appointmentsToday,
            toConfirm: noshowLine?.count ?? 0,
            gaps: diary.gapCount,
          }}
        />
        <aside className="space-y-6">
          <MiniMonth
            now={now}
            counts={{
              booked: brief.appointmentsToday,
              toConfirm: noshowLine?.count ?? 0,
              risk: riskCount,
            }}
          />
          <NeedsAttention sections={brief.sections} fallbackHref={briefHref} />
        </aside>
      </div>

      {/* The day's numbers: the previous stat cards as quiet big-numeral text
          stats, always visible whatever the brief contains. */}
      <section className="border-t border-line pt-5">
        <div className="flex flex-wrap gap-x-14 gap-y-5">
          <NumberStat
            label="Overnight"
            value={overnightLine?.count ?? 0}
            hint="Missed after hours"
          />
          <NumberStat
            label="Outstanding"
            value={moneyLine?.value !== undefined ? gbp(moneyLine.value) : gbp(0)}
            hint="Owed across plans"
          />
          {isOwner ? (
            <NumberStat
              label="Recovered this month"
              value={gbp(recovered)}
              hint="Pilot figure until live data connects"
            />
          ) : null}
        </div>
      </section>

      {/* The working centre: the live queue as a hairline section. */}
      <TaskQueueBoard
        plain
        clientSlug={clientSlug}
        maxRows={8}
        title="Next actions"
        description="The highest-priority work across every module. Finish one and the next slides in."
      />

      {/* Owner band: is it paying off. Server-gated, coordinators never receive it. */}
      {isOwner ? (
        <section className="space-y-5 border-t border-line pt-5">
          <h2 className="text-title text-navy">This month</h2>
          <OverviewDashboard hideHero variant="embedded" siteIds={siteIds} />
        </section>
      ) : null}
    </>
  );
}
