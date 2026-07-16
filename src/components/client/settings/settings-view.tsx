import type { LucideIcon } from "lucide-react";
import {
  Plug,
  Send,
  ShieldCheck,
  Building2,
  CheckCircle2,
  Circle,
  Database,
  MessageSquare,
  Mail,
  Star,
  Megaphone,
  Lock,
  Clock,
} from "lucide-react";
import { PageHeader, SectionCard, StatCard, StatusPill, type Tone } from "@/components/primitives";
import { getClient, getSites } from "@/lib/mock";
import { authEnforced } from "@/lib/auth/guard";
import { isDryRun } from "@/lib/messaging/types";

// Settings: the practice's "connect your services and go live" hub. It surfaces
// each integration and whether it is configured (presence of the relevant
// environment key only, never the value), the messaging mode (test vs live),
// the practice and its sites, and a go-live checklist derived from the same
// booleans. Nothing here is editable: connection is done by setting the keys
// before go-live, so this is a read-only status and path-to-live view.

type ConnState = "connected" | "test" | "missing";

interface Integration {
  name: string;
  icon: LucideIcon;
  /** One line: what this integration powers. */
  powers: string;
  state: ConnState;
  /** When connected/test, a short status note. */
  detail: string;
  /** Environment key name(s) to set when not configured. Names only, never values. */
  envKeys: string[];
}

const STATE_PILL: Record<ConnState, { tone: Tone; label: string }> = {
  connected: { tone: "success", label: "Connected" },
  test: { tone: "warning", label: "Test mode" },
  missing: { tone: "neutral", label: "Not connected" },
};

export function SettingsView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);
  if (!client) {
    return <PageHeader title="Settings" description="This client could not be found." />;
  }

  const sites = getSites(client.id);

  // Read every integration's status SERVER-SIDE as a boolean from env presence.
  // We never read or render the value itself, only whether a key is set.
  const dentallyKey = Boolean(process.env.DENTALLY_API_KEY);
  const dentallyBaseSet = Boolean(process.env.DENTALLY_BASE_URL);
  const twilioSid = Boolean(process.env.TWILIO_ACCOUNT_SID);
  const twilioApiKey = Boolean(process.env.TWILIO_API_KEY_SID);
  const twilioSmsFrom = Boolean(process.env.TWILIO_SMS_FROM);
  const resendKey = Boolean(process.env.RESEND_API_KEY);
  const reviewLink = Boolean(process.env.REVIEW_LINK_URL);
  const cronSecret = Boolean(process.env.CRON_SECRET);
  const authOn = authEnforced();
  const dryRun = isDryRun();

  // Messaging counts as "connected" once a provider is wired (Twilio for
  // SMS/WhatsApp). Test mode is a separate dimension shown on its own card.
  const messagingConnected = twilioSid;

  const integrations: Integration[] = [
    {
      name: "Dentally",
      icon: Database,
      powers: "The live practice diary, patients, recalls and payments.",
      state: dentallyKey ? "connected" : "missing",
      detail: dentallyKey
        ? dentallyBaseSet
          ? "Live API base configured."
          : "Key set, using the default API base."
        : "Running on mock data until a real key is connected.",
      envKeys: dentallyKey ? ["DENTALLY_BASE_URL"] : ["DENTALLY_API_KEY", "DENTALLY_BASE_URL"],
    },
    {
      name: "Messaging (SMS and WhatsApp)",
      icon: MessageSquare,
      powers: "Outbound SMS and the WhatsApp agent, via Twilio.",
      state: messagingConnected ? "connected" : "missing",
      detail: messagingConnected
        ? [
            twilioApiKey ? "API key set" : "API key not set",
            twilioSmsFrom ? "sender number set" : "sender number not set",
          ].join(", ") + "."
        : "Provider not wired; messages cannot be delivered.",
      envKeys: messagingConnected
        ? [
            ...(twilioApiKey ? [] : ["TWILIO_API_KEY_SID"]),
            ...(twilioSmsFrom ? [] : ["TWILIO_SMS_FROM"]),
          ]
        : ["TWILIO_ACCOUNT_SID", "TWILIO_API_KEY_SID", "TWILIO_SMS_FROM"],
    },
    {
      name: "Email (Resend)",
      icon: Mail,
      powers: "Transactional and lifecycle email to patients.",
      state: resendKey ? "connected" : "missing",
      detail: resendKey ? "Email provider connected." : "No email provider connected yet.",
      envKeys: resendKey ? [] : ["RESEND_API_KEY"],
    },
    {
      name: "Reviews link",
      icon: Star,
      powers: "The Google review destination used in review requests.",
      state: reviewLink ? "connected" : "missing",
      detail: reviewLink ? "Review link set." : "Set the practice's Google review link.",
      envKeys: reviewLink ? [] : ["REVIEW_LINK_URL"],
    },
    {
      name: "Meta Ads",
      icon: Megaphone,
      powers: "Facebook and Instagram campaign data and analytics.",
      state: "missing",
      detail: "Planned. Connect the Meta account to pull live campaign data.",
      envKeys: [],
    },
    {
      name: "Authentication and security",
      icon: Lock,
      powers: "Sign-in enforcement and the server-only database lock.",
      state: authOn ? "connected" : "missing",
      detail: authOn
        ? "Enforcement is on; the database is locked to the server."
        : "Pilot mode: enforcement is off until the service role key is set.",
      envKeys: authOn ? [] : ["SUPABASE_SERVICE_ROLE_KEY"],
    },
    {
      name: "Scheduler",
      icon: Clock,
      powers: "The 24/7 background jobs (recalls, reminders, drains).",
      state: cronSecret ? "connected" : "missing",
      detail: cronSecret
        ? "Scheduler secret set; jobs can run securely."
        : "Set a scheduler secret to protect the job endpoints.",
      envKeys: cronSecret ? [] : ["CRON_SECRET"],
    },
  ];

  const totalIntegrations = integrations.length;
  const connectedCount = integrations.filter((i) => i.state === "connected").length;

  // Go-live checklist: each item is satisfied straight from the booleans above,
  // giving the owner a clear path from demo to live.
  const checklist: { label: string; done: boolean; hint: string }[] = [
    {
      label: "Real Dentally key connected",
      done: dentallyKey,
      hint: "Moves the diary, patients and payments off mock data.",
    },
    {
      label: "Messaging provider connected",
      done: messagingConnected,
      hint: "Twilio wired so SMS and WhatsApp can be delivered.",
    },
    {
      label: "Messaging switched to live",
      done: !dryRun,
      hint: "Messages are actually delivered, not just recorded.",
    },
    {
      label: "Review link set",
      done: reviewLink,
      hint: "Review requests point at the practice's Google listing.",
    },
    {
      label: "Authentication enforcement on",
      done: authOn,
      hint: "Sign-in is required and the database is locked down.",
    },
    {
      label: "Scheduler secret set",
      done: cronSecret,
      hint: "Background jobs run on a protected endpoint.",
    },
    {
      label: "Meta account connected",
      done: false,
      hint: "Pulls live Facebook and Instagram campaign data.",
    },
  ];

  const checklistDone = checklist.filter((c) => c.done).length;

  const integrationsPanel = (
    <div className="divide-y divide-line">
      {integrations.map((it) => {
        const pill = STATE_PILL[it.state];
        const Icon = it.icon;
        return (
          <div
            key={it.name}
            className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
                <Icon size={17} />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-navy">{it.name}</p>
                <p className="text-xs text-muted">{it.powers}</p>
                <p className="text-xs text-muted">{it.detail}</p>
                {it.envKeys.length > 0 ? (
                  <p className="text-xs text-muted">
                    {it.envKeys.map((k, idx) => (
                      <span key={k}>
                        {idx > 0 ? " " : ""}Set{" "}
                        <code className="rounded bg-card-muted px-1 py-0.5 font-mono text-[11px] text-ink">
                          {k}
                        </code>
                      </span>
                    ))}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="pl-12 sm:pl-0">
              <StatusPill tone={pill.tone}>{pill.label}</StatusPill>
            </div>
          </div>
        );
      })}
    </div>
  );

  const goLivePanel = (
    <ul className="divide-y divide-line">
      {checklist.map((item) => (
        <li key={item.label} className="flex items-start gap-3 px-5 py-3">
          {item.done ? (
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
          ) : (
            <Circle size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          )}
          <div className="space-y-0.5">
            <p
              className={
                item.done
                  ? "text-sm font-medium text-navy"
                  : "text-sm font-medium text-ink"
              }
            >
              {item.label}
            </p>
            <p className="text-xs text-muted">{item.hint}</p>
          </div>
          <span className="ml-auto self-center">
            <StatusPill tone={item.done ? "success" : "neutral"}>
              {item.done ? "Done" : "To do"}
            </StatusPill>
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your integrations, messaging mode and go-live checklist in one place."
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Integrations connected"
          value={`${connectedCount} of ${totalIntegrations}`}
          icon={Plug}
          hint={`${totalIntegrations - connectedCount} still to connect`}
        />
        <StatCard
          label="Messaging mode"
          value={dryRun ? "Test" : "Live"}
          icon={Send}
          hint={dryRun ? "Recorded, not delivered" : "Messages are delivered"}
        />
        <StatCard
          label="Authentication"
          value={authOn ? "Enforced" : "Pilot"}
          icon={ShieldCheck}
          hint={authOn ? "Sign-in required" : "Open until go-live"}
        />
        <StatCard
          label="Go-live checklist"
          value={`${checklistDone} of ${checklist.length}`}
          icon={CheckCircle2}
          hint={checklistDone === checklist.length ? "Ready to go live" : "Items outstanding"}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <SectionCard
          title="Integrations"
          description={`${connectedCount} of ${totalIntegrations} connected.`}
          bodyClassName="p-0"
        >
          {integrationsPanel}
        </SectionCard>
        <SectionCard
          title="Go-live checklist"
          description={`${checklistDone} of ${checklist.length} complete.`}
          bodyClassName="p-0"
        >
          {goLivePanel}
        </SectionCard>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SectionCard title="Messaging mode" description="Test records, live delivers.">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-base font-semibold text-navy">
                {dryRun ? "Test mode (dry run)" : "Live"}
              </span>
              <StatusPill tone={dryRun ? "warning" : "success"}>
                {dryRun ? "Test mode" : "Live"}
              </StatusPill>
            </div>
            <p className="text-xs text-muted">
              {dryRun
                ? "In test mode every message is recorded so you can review it, but nothing is delivered to patients. Going live flips MESSAGING_DRY_RUN, after which messages are sent for real through the consent-aware messaging layer."
                : "Messages are being delivered to patients for real through the consent-aware messaging layer. To return to recording only, set MESSAGING_DRY_RUN back to true."}
            </p>
            <span className="flex w-fit items-center gap-1.5 rounded-lg bg-card-muted px-3 py-2 text-xs text-muted">
              <Send size={14} />
              Environment setting, not a runtime toggle
            </span>
          </div>
        </SectionCard>

        <SectionCard title="Practice" description="Team and roles are coming.">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f0f4f9] text-side-ink">
                <Building2 size={17} />
              </span>
              <div>
                <p className="text-sm font-semibold text-navy">{client.name}</p>
                <p className="text-xs text-muted">
                  {sites.length} {sites.length === 1 ? "site" : "sites"}
                </p>
              </div>
            </div>
            <ul className="grid gap-2 sm:grid-cols-2">
              {sites.map((site) => (
                <li
                  key={site.id}
                  className="rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-navy"
                >
                  {site.name}
                  <span className="block text-xs text-muted">{site.timezone}</span>
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
