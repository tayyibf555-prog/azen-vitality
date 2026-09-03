import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getClient, getSite } from "@/lib/mock/clients";
import { isSystemEnabledStrict } from "@/lib/systems/repository";
import { isMedicalHistoryEnabled } from "@/lib/patient-medical/gate";
import { buildMedicalHistoryLink } from "@/lib/patient-medical/link";
import { isTriageLinkTokenShaped } from "@/lib/triage/link";
import { projectBank } from "@/lib/triage/project";
import { getBank, getTargetByLinkToken } from "@/lib/triage/repository";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";
import { INTEREST_TREATMENTS } from "@/lib/triage/bank";
import { PreVisitForm } from "@/components/previsit/previsit-form";

// ===========================================================================
// The public pre-visit questionnaire: /pv/<token>.
//
// A SERVER component. It resolves the link to its target, decides which bank
// applies from the FORK ON THAT ROW, and renders the questions. The browser is
// handed the projected questions and the opaque token, and nothing else: no
// patient id, no site id, no fork, no plan.
//
// THE PATIENT CANNOT TELL WHICH LIST THEY GOT, and that is the point. The short
// form is simply shorter. There is no note explaining why, no "based on your
// plan", no heading that differs between the two — two patients comparing their
// phones must not be able to work out that they were asked different things
// because of how they are seen. `no-funding-words` in copy.test.ts crawls every
// string this page can render.
//
// A DEAD LINK IS A 404, WHATEVER KILLED IT: a malformed token, an unknown token,
// a spent link, a stopped target, a switched-off system, an unknown site. Same
// page for all of them, so a probe learns nothing about whether a token named a
// real appointment. The /pv/* path is public (the proxy gates only /agency,
// /owner, /c/*), and force-dynamic so a freshly minted link is always honoured
// and the kill-switch state is always fresh.
// ===========================================================================

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Before your visit" };

export default async function PreVisitPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Shape first, so junk never reaches a database query.
  if (!isTriageLinkTokenShaped(token)) notFound();

  const target = await getTargetByLinkToken(token).catch(() => null);
  if (!target) notFound();
  // A spent link ('answered') or a retired one ('stopped') opens nothing. This is
  // what a database-backed id buys that a signed token cannot express.
  if (target.status !== "queued" && target.status !== "sent") notFound();

  const site = getSite(target.siteId);
  if (!site) notFound();
  const client = getClient(site.clientId);
  if (!client) notFound();

  // STRICT, i.e. fail CLOSED. Switching the module off must close the form, and
  // an unreadable switch must too: a form still collecting answers after the
  // owner turned it off is a stop with residue on the screen.
  if (!(await isSystemEnabledStrict(client.id, TRIAGE_SYSTEM_SLUG))) notFound();

  const saved = await getBank(client.id, target.fork).catch(() => null);
  const bank = projectBank(target.fork, saved?.config ?? null);

  // THE ONWARD STEP, and this is where "alongside the medical-history link"
  // actually happens. Two links cannot fit in one SMS credit (the medical-history
  // link is a signed patient token, ~170 characters on its own), so the handover
  // is in the journey rather than in the message: when medical-history capture is
  // switched on, the thank-you screen offers that form as the next tap, minted for
  // THIS patient by the module that owns it. With the feature off there is nothing
  // to hand over to and the screen simply ends.
  const medicalLink = isMedicalHistoryEnabled()
    ? buildMedicalHistoryLink(target.siteId, target.dentallyPatientId)
    : null;

  return (
    <PreVisitForm
      token={token}
      practiceName={site.name}
      questions={bank.questions}
      interest={INTEREST_TREATMENTS}
      medicalLink={medicalLink}
      // The SITE's own number, straight off the site record. Null until the owner
      // supplies it, and passed as null rather than defaulted: urgentHelpLine drops
      // the number clause and keeps 111 rather than inviting a patient in pain to
      // ring a number that is not the practice.
      practicePhone={site.publicPhone ?? null}
    />
  );
}
