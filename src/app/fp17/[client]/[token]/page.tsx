import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClient, getSite } from "@/lib/mock/clients";
import { verifyPatientToken } from "@/lib/public-link/patient-token";
import { isSystemEnabled } from "@/lib/systems/repository";
import { FP17_COPY, FP17_SYSTEM_SLUG } from "@/lib/fp17/copy";
import { Fp17Form } from "@/components/fp17/fp17-form";

// Public, branded FP17 / PR consent + exemption declaration page
// (/fp17/<client>/<token>). The token is signed and PURPOSE-SCOPED to 'fp17' (an
// 'mh' token cannot be replayed here), and carries the (site, patient) pair, so this
// page needs no auth. A missing PRACTICE 404s (like /onboard); a bad/expired TOKEN
// shows a friendly "link not valid" panel (like /prefs) rather than a bare 404.
//
// The /fp17/* paths are public (the proxy gates only /agency, /owner, /c/*).
// force-dynamic so the kill-switch state is always fresh. Nothing here is submitted
// to the NHS (Compass).

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "NHS dental declaration" };

interface Params {
  client: string;
  token: string;
}

function Shell({ practiceName, children }: { practiceName: string; children: React.ReactNode }) {
  return (
    <main className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <header className="mb-6 flex flex-col items-center gap-3 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-card shadow-[0_4px_16px_rgba(10,14,26,0.10)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/copilot-logo.png" alt={`${practiceName} logo`} width={44} height={44} className="h-11 w-11 object-contain" />
        </span>
        <div className="space-y-0.5">
          <p className="text-lg font-bold tracking-tight text-navy">{practiceName}</p>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
            NHS dental declaration
          </p>
        </div>
      </header>
      {children}
    </main>
  );
}

export default async function Fp17Page({ params }: { params: Promise<Params> }) {
  const { client: clientSlug, token } = await params;

  // Unknown practice: 404, matching /onboard.
  const client = getClient(clientSlug);
  if (!client) notFound();

  const practiceName = client.name;

  // Bad / expired / wrong-purpose token: friendly panel, not a 404.
  const payload = verifyPatientToken(token, "fp17");
  const site = payload ? getSite(payload.siteId) : undefined;
  if (!payload || !site || site.clientId !== client.id) {
    return (
      <Shell practiceName={practiceName}>
        <div className="rounded-2xl border border-line bg-card p-6 text-center shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
          <p className="text-sm font-semibold text-navy">This link is not valid</p>
          <p className="mt-2 text-sm text-muted">
            The declaration link you followed has expired or is not recognised. Please ask the
            practice team for a new link.
          </p>
          <p className="mt-3 text-xs text-muted">{FP17_COPY.notCompass}</p>
        </div>
      </Shell>
    );
  }

  // Feature switched off for this practice: say so plainly rather than collecting a
  // declaration the submit endpoint would reject.
  let enabled = false;
  try {
    enabled = await isSystemEnabled(client.id, FP17_SYSTEM_SLUG);
  } catch {
    enabled = false;
  }
  if (!enabled) {
    return (
      <Shell practiceName={practiceName}>
        <div className="rounded-2xl border border-line bg-card p-6 text-center shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
          <p className="text-sm font-semibold text-navy">This form is not available right now</p>
          <p className="mt-2 text-sm text-muted">
            The practice is not currently collecting declarations through this link. Please speak to
            the practice team.
          </p>
          <p className="mt-3 text-xs text-muted">{FP17_COPY.notCompass}</p>
        </div>
      </Shell>
    );
  }

  return <Fp17Form clientSlug={client.slug} token={token} practiceName={practiceName} />;
}
