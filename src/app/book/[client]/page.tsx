import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BookingCalendar } from "@/components/book/booking-calendar";
import { getClient, getSites } from "@/lib/mock/clients";

// Public booking page (/book/<client>?site=<siteId>): a patient picks a live
// appointment time and books it, reached from the Smile Assessment thank-you
// screen or a direct link. A SERVER component wrapper: it resolves the practice
// (unknown slug 404s) and the site (a missing or foreign ?site= falls back to
// the practice's first site; the server re-validates on every API call), then
// renders the client-side calendar. Availability itself is fetched client-side
// from /api/booking/slots so the page shell stays instant.

interface Params {
  client: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { client } = await params;
  const record = getClient(client);
  if (!record) return { title: "Book an appointment" };
  return {
    title: `Book an appointment | ${record.name}`,
    description: `Choose an appointment time that suits you at ${record.name}.`,
  };
}

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { client: clientSlug } = await params;
  const client = getClient(clientSlug);
  if (!client) notFound();

  const sites = getSites(client.id);
  if (sites.length === 0) notFound();

  // Display-only site resolution: an unknown ?site= quietly falls back to the
  // first site rather than erroring on a public link. The server re-validates.
  const rawSite = (await searchParams).site;
  const requestedSite = typeof rawSite === "string" ? rawSite : undefined;
  const site = sites.find((s) => s.id === requestedSite) ?? sites[0];

  return (
    <main className="relative mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
      {/* Soft brand glow behind the card, matching the assess pages. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-80 bg-[radial-gradient(58%_70%_at_50%_0%,rgba(91,196,247,0.20),transparent_72%)]"
      />

      <header className="mb-6 flex flex-col items-center gap-3 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-card shadow-[0_4px_16px_rgba(10,14,26,0.10)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/copilot-logo.png"
            alt={`${client.name} logo`}
            width={44}
            height={44}
            className="h-11 w-11 object-contain"
          />
        </span>
        <div className="space-y-0.5">
          <p className="text-lg font-bold tracking-tight text-navy">{client.name}</p>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
            Book an appointment
          </p>
        </div>
        <p className="max-w-sm text-sm text-muted">
          Pick a day and time that suits you and we&apos;ll hold it for you. It only takes a
          minute.
        </p>
      </header>

      <BookingCalendar
        clientSlug={client.slug}
        siteId={site.id}
        siteName={site.name}
      />

      <p className="mt-5 text-center text-[0.7rem] text-muted">
        Need help, or can&apos;t see a time that works? Call the practice and the team will find
        one for you.
      </p>
    </main>
  );
}
