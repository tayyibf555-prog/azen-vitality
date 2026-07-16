import { Info, CheckCircle2, ExternalLink, CalendarDays, MousePointerClick, CalendarCheck2 } from "lucide-react";
import { PageHeader, SectionCard } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock/clients";
import { getViewScope } from "@/lib/site-view";
import { DEFAULT_VIEW_SITE } from "@/lib/site-view-shared";
import { getDisabledSlugs } from "@/lib/systems/repository";
import { CopyButton } from "./copy-button";

// The Booking tab: the patient-facing online booking link for the currently
// selected site (src/lib/site-view.ts, same switcher every sibling page reads),
// with a ready-to-send share message and the other sites' links kept one section
// down. No table of its own — this only surfaces the PUBLIC /book page
// (src/app/book/[client]/page.tsx) that already exists, plus the owner kill
// switch's honest state (src/lib/systems/repository.ts, slug "online-booking").
//
// URL shape confirmed from the public page + the smile-assessment bridge
// (src/app/api/smile-assessment/submit/route.ts): `/book/<clientSlug>?site=<siteId>`.

/** The full, shareable public booking URL for one site. */
function publicBookingUrl(clientSlug: string, siteId: string): string {
  const base = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";
  return `${base}/book/${clientSlug}?site=${siteId}`;
}

const HOW_IT_WORKS = [
  {
    icon: CalendarDays,
    title: "A live diary",
    body: "The link reads real-time availability straight from your Dentally diary, so a patient never sees a slot that is already taken.",
  },
  {
    icon: MousePointerClick,
    title: "Patient picks a time",
    body: "They choose a day and time that suits them, no phone call or back-and-forth needed.",
  },
  {
    icon: CalendarCheck2,
    title: "Straight into the diary",
    body: "The appointment is created in Dentally the moment they confirm, exactly as if your team had booked it.",
  },
];

export async function BookingView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Booking" description="This client could not be found." />;
  }

  const sites = getSites(client.id);
  if (sites.length === 0) {
    return (
      <>
        <PageHeader title="Booking" description="The patient-facing online booking link." />
        <SectionCard>
          <p className="text-sm text-muted">No sites are configured for this practice yet.</p>
        </SectionCard>
      </>
    );
  }

  const [scope, disabled] = await Promise.all([
    getViewScope(client.id),
    getDisabledSlugs(client.id),
  ]);

  // A booking link is inherently per-site (there is no "all sites" public page),
  // so when the switcher is on "All sites" we fall back to the flagship site and
  // say so; every other site's link is still one section down.
  const primarySiteId = scope.isAllSites
    ? (sites.some((s) => s.id === DEFAULT_VIEW_SITE) ? DEFAULT_VIEW_SITE : sites[0].id)
    : scope.selection;
  const primarySite = sites.find((s) => s.id === primarySiteId) ?? sites[0];
  const otherSites = sites.filter((s) => s.id !== primarySite.id);

  const primaryUrl = publicBookingUrl(client.slug, primarySite.id);
  const shareMessage = `Book your appointment online here: ${primaryUrl}`;
  const bookingOff = disabled.has("online-booking");

  return (
    <>
      <PageHeader
        title="Booking"
        description={
          scope.isAllSites
            ? `"All sites" is selected, so this shows ${primarySite.name}'s link (a booking page is always for one site). Pick a specific site above for its own link, or use the list below.`
            : `The patient-facing online booking link for ${primarySite.name}.`
        }
      />

      {bookingOff ? (
        <div className="flex items-start gap-2.5 rounded-xl border border-warning/25 bg-warning/10 px-4 py-2.5">
          <Info size={16} className="mt-0.5 shrink-0 text-[#9a6700]" />
          <p className="text-xs font-medium leading-relaxed text-[#9a6700]">
            Online booking is currently switched off. Patients can still browse available times on this
            link, but final confirmation is paused until you switch it back on in{" "}
            <a href={`/c/${client.slug}/controls`} className="font-semibold underline underline-offset-2">
              Operations Controls
            </a>
            .
          </p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 rounded-xl border border-success/20 bg-success/10 px-4 py-2.5">
          <CheckCircle2 size={16} className="shrink-0 text-success" />
          <p className="text-xs font-medium leading-relaxed text-success">
            Online booking is live: patients can browse times and confirm an appointment instantly.
          </p>
        </div>
      )}

      <SectionCard
        title={`${primarySite.name} booking link`}
        description="Share it directly, add it to your website or socials, or text it to a patient."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 truncate rounded-lg border border-line bg-card-muted px-3 py-2 font-mono text-sm text-ink">
            {primaryUrl}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <CopyButton value={primaryUrl} label="Copy link" />
            <a
              href={primaryUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-semibold text-navy transition-colors hover:bg-card-muted"
            >
              <ExternalLink size={13} /> Open
            </a>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Share message"
        description="A ready-to-send message with the link already in it, for a text, email or social post."
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink">
            {shareMessage}
          </p>
          <CopyButton value={shareMessage} label="Copy message" variant="secondary" className="shrink-0" />
        </div>
      </SectionCard>

      <SectionCard title="How it works">
        <div className="grid gap-4 sm:grid-cols-3">
          {HOW_IT_WORKS.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
                  <Icon size={15} />
                </span>
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  Step {i + 1}
                </span>
              </div>
              <p className="text-sm font-semibold text-navy">{title}</p>
              <p className="text-xs leading-relaxed text-muted">{body}</p>
            </div>
          ))}
        </div>
      </SectionCard>

      {otherSites.length > 0 ? (
        <SectionCard title="Other sites" description="Each site has its own booking link.">
          <ul className="divide-y divide-line">
            {otherSites.map((site) => {
              const url = publicBookingUrl(client.slug, site.id);
              return (
                <li key={site.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                  <span className="min-w-0 truncate text-sm font-medium text-navy">{site.name}</span>
                  <CopyButton value={url} label="Copy link" variant="secondary" className="shrink-0" />
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}
