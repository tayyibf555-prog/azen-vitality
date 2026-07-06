import {
  Sunrise,
  CalendarDays,
  PoundSterling,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  PhoneMissed,
  ListChecks,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PageHeader, StatCard, SectionCard, StatusPill, EmptyState, type Tone } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getSessionUser } from "@/lib/auth/session";
import { generateBrief } from "@/lib/daily-brief/generate";
import type { BriefContext, BriefSection, DailyBrief } from "@/lib/daily-brief/types";
import type { Role } from "@/lib/types";
import { gbp } from "@/lib/utils";

const PRIORITY_TONE: Record<"high" | "medium" | "low", Tone> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};
const PRIORITY_LABEL: Record<"high" | "medium" | "low", string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};
const SECTION_ICON: Record<string, LucideIcon> = {
  diary: CalendarDays,
  noshow: ShieldAlert,
  arriving: Sparkles,
  chase: ListChecks,
  overnight: PhoneMissed,
  money: Wallet,
  compliance: ShieldCheck,
};

const ROLE_GREETING: Record<Role, string> = {
  agency_admin: "Here is the morning brief across the network.",
  client_owner: "Here is the morning brief across your sites.",
  client_coordinator: "Here is your morning brief. Start at the top.",
};

function longDate(now: Date): string {
  return now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "Europe/London",
  });
}

const SECTION_ROW_CAP = 5;

function SectionBlock({ section, clientSlug }: { section: BriefSection; clientSlug: string }) {
  const Icon = SECTION_ICON[section.key] ?? ListChecks;
  const visible = section.items.slice(0, SECTION_ROW_CAP);
  const hiddenCount = section.items.length - visible.length;
  // Prefer a deep link into the owning module for the overflow row, if the
  // section's lines carry one. The brief lines hold a bare module slug (e.g.
  // "recall"), so build the full client-scoped path. Falls back to a plain
  // summary row so this stays a server component.
  const moreSlug = section.items.find((line) => line.href)?.href;
  const moreHref = moreSlug ? `/c/${clientSlug}/${moreSlug}` : undefined;
  return (
    <SectionCard title={section.title} bodyClassName="p-0">
      <ul className="divide-y divide-line">
        {visible.map((line, i) => (
          <li key={`${section.key}-${i}`} className="flex items-start gap-3 px-5 py-3">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card-muted text-blue-dark">
              <Icon size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-snug text-navy">{line.title}</p>
              <p className="mt-0.5 text-xs text-muted">{line.detail}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {line.value !== undefined ? (
                <span className="text-sm font-semibold tabular-nums text-navy">{gbp(line.value)}</span>
              ) : null}
              <StatusPill tone={PRIORITY_TONE[line.priority]}>{PRIORITY_LABEL[line.priority]}</StatusPill>
            </div>
          </li>
        ))}
        {hiddenCount > 0 ? (
          <li>
            {moreHref ? (
              <a
                href={moreHref}
                className="flex min-h-[44px] items-center px-5 py-2.5 text-xs font-semibold text-blue-dark transition-colors hover:bg-card-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark"
              >
                View all {section.items.length}
              </a>
            ) : (
              <p className="px-5 py-2.5 text-xs font-medium text-muted">
                {hiddenCount} more in this section
              </p>
            )}
          </li>
        ) : null}
      </ul>
    </SectionCard>
  );
}

export async function DailyBriefView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Daily brief" description="This client could not be found." />;
  }

  // Role from the verified session; fall back to client_owner when auth is not
  // enforced (pilot) so the full brief renders.
  let role: Role = "client_owner";
  try {
    const user = await getSessionUser();
    if (user) role = user.role;
  } catch {
    // unenforced / no session: keep the owner default.
  }

  const siteIds = getSites(client.id).map((s) => s.id);
  const now = new Date();
  const ctx: BriefContext = { clientId: client.id, siteIds, role, now };

  let brief: DailyBrief;
  try {
    brief = await generateBrief(ctx);
  } catch {
    brief = { generatedAt: now.toISOString(), role, appointmentsToday: 0, sections: [], headline: [] };
  }

  // Headline KPIs for the "Your day" summary.
  const moneyLine = brief.sections.find((s) => s.key === "money")?.items[0];
  const noshowLine = brief.sections.find((s) => s.key === "noshow")?.items[0];
  const overnightLine = brief.sections.find((s) => s.key === "overnight")?.items[0];

  return (
    <>
      <PageHeader title="Daily brief" description={`${longDate(now)}. ${ROLE_GREETING[role]}`} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Appointments today"
          value={brief.appointmentsToday}
          icon={CalendarDays}
          hint="Across your sites"
        />
        <StatCard
          label="To confirm"
          value={noshowLine?.count ?? 0}
          icon={ShieldAlert}
          hint="High no-show risk"
        />
        <StatCard
          label="Overnight"
          value={overnightLine?.count ?? 0}
          icon={PhoneMissed}
          hint="Missed after hours"
        />
        <StatCard
          label="Outstanding"
          value={moneyLine?.value !== undefined ? gbp(moneyLine.value) : gbp(0)}
          icon={PoundSterling}
          hint="Owed across plans"
        />
      </div>

      {brief.sections.length === 0 ? (
        <EmptyState
          icon={Sunrise}
          title="Nothing needs you right now"
          description="When the diary fills up and work lands across your modules, your prioritised brief appears here every morning."
        />
      ) : (
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          {brief.sections.map((section) => (
            <SectionBlock key={section.key} section={section} clientSlug={clientSlug} />
          ))}
        </div>
      )}
    </>
  );
}
