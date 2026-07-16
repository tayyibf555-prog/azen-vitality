import { PageHeader } from "@/components/primitives";
import { TaskQueueBoard } from "@/components/client/task-queue/task-queue-board";
import { DiaryTimeline } from "@/components/client/home/diary-timeline";
import { MiniMonth } from "@/components/client/home/mini-month";
import { NeedsAttention } from "@/components/client/home/needs-attention";
import { getClient } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { getSiteMetrics } from "@/lib/mock";
import { getSessionUser } from "@/lib/auth/session";
import { OWNER_ROLES } from "@/lib/nav";
import { generateBrief } from "@/lib/daily-brief/generate";
import type { DailyBrief } from "@/lib/daily-brief/types";
import { getTodayDiary } from "@/lib/home/diary";
import { cn, gbp } from "@/lib/utils";

export const dynamic = "force-dynamic";

// "One Front Door", arranged exactly as the locked mock (aesthetic-mock2):
// greeting, dot-prefixed day numerals, the diary as flat hairline slot rows
// beside a Needs-attention + mini-month rail, then the numbers band (the
// page's ONE blue moment) carrying the money/priority figures with a Reports
// link through to the full charts. Nothing shown to the client before this
// layout has been removed; it has been repositioned or sits one click away.

function longDate(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}

/** A dot-prefixed big numeral (the mock's day stats). 700 is reserved for these. */
function DayStat({ dot, value, label }: { dot: string; value: string | number; label: string }) {
  return (
    <div>
      <p className="text-[20px] font-bold tracking-[-0.3px] tabular-nums text-navy">
        <i aria-hidden className={cn("mr-1.5 inline-block h-[7px] w-[7px] rounded-full align-[2px]", dot)} />
        {value}
      </p>
      <p className="mt-0.5 text-[11px] font-medium text-muted">{label}</p>
    </div>
  );
}

/** A numbers-band figure: big quiet numeral + small label (+ optional footnote). */
function BandStat({
  value,
  label,
  hint,
  valueClassName,
}: {
  value: string | number;
  label: string;
  hint?: string;
  valueClassName?: string;
}) {
  return (
    <div>
      <b className={cn("text-[24px] font-bold tracking-[-0.4px] tabular-nums text-navy", valueClassName)}>
        {value}
      </b>
      <span className="block text-[11px] font-medium text-muted">{label}</span>
      {hint ? <span className="block text-[10.5px] font-normal text-faint">{hint}</span> : null}
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
  // Scope the recovered-revenue figure to the selected site(s) (default N15) so it
  // matches the rest of the dashboard rather than always summing every practice.
  const recovered = getSiteMetrics(siteIds).reduce((sum, s) => sum + s.recoveredRevenue, 0);
  const briefHref = `/c/${clientSlug}/daily-brief`;
  // The full charts live one click away: owners get the overview console, the
  // coordinator view gets the reports module.
  const reportsHref = isOwner ? `/owner/${clientSlug}/overview` : `/c/${clientSlug}/reports`;

  return (
    <>
      {/* Greeting: the 3-second answer. */}
      <section>
        <h1 className="text-display text-navy">{longDate(now)}</h1>
        <p className="mt-1.5 text-[13px] font-normal text-muted">
          {headline ? (
            <>
              <span className="font-medium text-ink">{headline.title}.</span> {headline.detail}{" "}
            </>
          ) : (
            <>Nothing is on fire this morning. </>
          )}
          <a href={briefHref} className="font-medium text-blue-royal hover:underline">
            Morning brief
          </a>
        </p>
      </section>

      {/* Day stats: dot-prefixed numerals, never stat cards. */}
      <div className="flex flex-wrap gap-x-7 gap-y-4">
        <DayStat dot="bg-status-blue" value={brief.appointmentsToday} label="Booked today" />
        <DayStat dot="bg-status-amber" value={noshowLine?.count ?? 0} label="To confirm" />
        <DayStat dot="bg-status-red" value={diary.gapCount} label="Open slots" />
        {diary.fillPercent !== null ? (
          <DayStat dot="bg-status-green" value={`${diary.fillPercent}%`} label="Diary full" />
        ) : null}
      </div>

      {/* Hero: the diary rows beside the attention + month rail. */}
      <div className="grid items-start gap-x-11 gap-y-8 lg:grid-cols-[minmax(0,1fr)_288px]">
        <DiaryTimeline diary={diary} clientSlug={clientSlug} />
        <aside className="space-y-7">
          <NeedsAttention sections={brief.sections} fallbackHref={briefHref} />
          <MiniMonth now={now} />
        </aside>
      </div>

      {/* The numbers band: the page's one blue moment. The owner band's charts
          moved behind the Reports link (the full overview keeps them). */}
      <div className="flex flex-wrap items-center gap-x-11 gap-y-4 rounded-[10px] border border-band-line bg-band px-6 py-5">
        <BandStat value={overnightLine?.count ?? 0} label="Overnight enquiries" />
        <BandStat value={moneyLine?.value !== undefined ? gbp(moneyLine.value) : gbp(0)} label="Outstanding balances" />
        {isOwner ? (
          <BandStat
            value={gbp(recovered)}
            label="Recovered this month"
            hint="Pilot figure until live data connects"
            valueClassName="text-status-green"
          />
        ) : null}
        <a href={reportsHref} className="ml-auto text-xs font-semibold text-blue-royal hover:underline">
          Reports →
        </a>
      </div>

      {/* The working centre: the live queue as a hairline section. */}
      <TaskQueueBoard
        plain
        clientSlug={clientSlug}
        maxRows={8}
        title="Next actions"
        description="The highest-priority work across every module. Finish one and the next slides in."
      />
    </>
  );
}
