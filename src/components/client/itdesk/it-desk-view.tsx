import { Info } from "lucide-react";
import { PageHeader } from "@/components/primitives";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { getClient } from "@/lib/mock/clients";
import { OWNER_ROLES } from "@/lib/nav";
import { playbooksByArea } from "@/lib/itdesk/playbooks";
import { getItContact } from "@/lib/itdesk/repository";
import { isSystemEnabled } from "@/lib/systems/repository";
import { IT_DESK_SLUG } from "@/lib/itdesk/types";
import type { ContactForm } from "@/lib/itdesk/view";
import { ItDeskWorkspace } from "./it-desk-workspace";

/**
 * The IT desk module, in BOTH trees (/c/[client]/it-desk and the owner tree's
 * [module] if-chain).
 *
 * WHY THE OWNER CHECK IS HERE AND WHY IT IS NOT A LOCK. Setting the IT contact
 * is owner + agency only, because who the practice escalates to changes what
 * every member of staff is told to do. This line decides whether the fields are
 * EDITABLE on screen; /api/itdesk/set-contact derives the same answer again from
 * the session with `requireOwnerRole` on every request. If this line were
 * deleted, a practice manager would see enabled inputs and get a polite 403 —
 * she would not change anything.
 *
 * `getSessionUser` is React-cached per request and the shell's guard has already
 * called it, so this costs no extra round-trip; it is skipped entirely where
 * sign-in is not configured, matching every other guard in the codebase.
 */
export async function ItDeskView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="IT desk" description="This client could not be found." />;
  }

  const [contact, systemEnabled] = await Promise.all([
    getItContact(client.id),
    isSystemEnabled(client.id, IT_DESK_SLUG),
  ]);

  const role = authEnforced() ? (await getSessionUser())?.role : null;
  const canEditContact = !role || OWNER_ROLES.includes(role);

  const form: ContactForm = {
    name: contact?.name ?? "",
    company: contact?.company ?? "",
    phone: contact?.phone ?? "",
    email: contact?.email ?? "",
    hours: contact?.hours ?? "",
    notes: contact?.notes ?? "",
  };

  return (
    <>
      <PageHeader
        title="IT desk"
        description="A first responder for the practice's everyday IT: the internet, printers, logins, getting into Dentally, and the iPads and form kiosks."
      />

      <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-muted" />
        <p className="text-xs leading-relaxed text-muted">
          The desk walks staff through the troubleshooting playbooks below and hands over to the practice&rsquo;s named
          IT contact when they run out. It never handles a password, PIN or access code, never turns off antivirus, a
          firewall, encryption or two-factor sign-in, and has no way to see, reach or control any computer in the
          practice &mdash; there is no software of ours on any machine.
        </p>
      </div>

      <ItDeskWorkspace
        clientSlug={clientSlug}
        playbooksByArea={playbooksByArea()}
        contact={form}
        contactUnavailable={contact === null}
        canEditContact={canEditContact}
        systemEnabled={systemEnabled}
      />
    </>
  );
}
