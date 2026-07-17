import type { Metadata } from "next";
import { getClient, getSite } from "@/lib/mock/clients";
import { verifyPrefToken } from "@/lib/messaging/pref-token";
import { ChannelPrefForm } from "@/components/prefs/channel-pref-form";

// Public patient channel-preference page (/prefs/<token>). The token is signed and
// carries the (site, patient) pair, so this page needs no auth: an invalid or
// tampered token simply shows a friendly "link not valid" message. A valid token
// resolves the practice for branding and renders the choice form, which POSTs the
// same token to /api/prefs.
//
// SERVER component. The /prefs/* paths are public (proxy gates only /agency,
// /owner, /c/*).

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your messaging preferences" };

interface Params {
  token: string;
}

export default async function PrefsPage({ params }: { params: Promise<Params> }) {
  const { token } = await params;
  const payload = verifyPrefToken(token);
  const client = payload ? getClient(getSite(payload.siteId)?.clientId ?? "") : undefined;
  const practiceName = client?.name ?? "our practice";

  return (
    <main className="relative mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <header className="mb-6 flex flex-col items-center gap-3 text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-card shadow-[0_4px_16px_rgba(10,14,26,0.10)]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/copilot-logo.png"
            alt={`${practiceName} logo`}
            width={44}
            height={44}
            className="h-11 w-11 object-contain"
          />
        </span>
        <div className="space-y-0.5">
          <p className="text-lg font-bold tracking-tight text-navy">{practiceName}</p>
          <p className="text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
            Messaging preferences
          </p>
        </div>
      </header>

      {payload ? (
        <ChannelPrefForm token={token} practiceName={practiceName} />
      ) : (
        <div className="rounded-2xl border border-line bg-card p-6 text-center shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
          <p className="text-sm font-semibold text-navy">This link is not valid</p>
          <p className="mt-2 text-sm text-muted">
            The preferences link you followed has expired or is not recognised. If you would like to
            update how we contact you, please reply to a recent message from the practice or give us
            a call and the team will help.
          </p>
        </div>
      )}
    </main>
  );
}
