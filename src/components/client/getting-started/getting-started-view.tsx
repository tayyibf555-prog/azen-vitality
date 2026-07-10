"use client";

import { useEffect, useState } from "react";
import { PageHeader, SectionCard, StatCard, StatusPill, ProgressMeter, type Tone } from "@/components/primitives";
import { ListChecks, ShieldAlert, Rocket, Check } from "lucide-react";
import { getClient } from "@/lib/mock/clients";
import { cn } from "@/lib/utils";

// The go-live checklist: what the practice needs to provide before the platform
// stops being read-and-review only and starts contacting patients. The 11 items /
// 3 go-live gates mirror the prepared onboarding sheet exactly. Owners can now TICK
// items off; ticks persist per practice (shared between owners) via
// /api/getting-started. Owner/staff facing, never patient facing.

/** The badges shown against each item, matching the sheet's legend. */
type ItemTag = "gate" | "practice" | "we" | "optional";

interface ChecklistItem {
  /** Stable id for persistence; must not change once shipped, or a tick resets. */
  key: string;
  name: string;
  why: string;
  /** The "More info" disclosure body: one or more paragraphs of plain detail. */
  detail: { lead: string; body: string }[];
  tags: ItemTag[];
  /** Optional label override for the "optional" tag (e.g. "If running ads"). */
  optionalLabel?: string;
}

interface ChecklistSection {
  kicker: string;
  title: string;
  sub: string;
  /** True for the messaging section: nothing sends until its items are in place. */
  gated?: boolean;
  items: ChecklistItem[];
}

const SECTIONS: ChecklistSection[] = [
  {
    kicker: "01",
    title: "Switch messaging on",
    sub: "Nothing contacts a patient until these three are in place.",
    gated: true,
    items: [
      {
        key: "consent",
        name: "Patient consent and opt-out list",
        why: "Confirm which patients may be contacted for recall and reactivation, the lawful basis, and any do-not-contact list. The single most important item before anything sends.",
        detail: [
          {
            lead: "What it means for you.",
            body: "Before we message anyone on your behalf, we need to know who has agreed to hear from the practice and who has asked not to. This is a GDPR requirement, and it protects the practice.",
          },
          {
            lead: "How to do it.",
            body: "Dentally already stores each patient's SMS and email preferences and we read those automatically, so mostly we just need you to confirm they are kept up to date. Separately, send us any do-not-contact list you hold outside Dentally (complaints, bereavements, explicit opt-outs). If you are unsure of your lawful basis for recall or marketing messages, your practice manager or data-protection lead can confirm it in a sentence.",
          },
        ],
        tags: ["gate", "practice"],
      },
      {
        key: "email-domain",
        name: "Email sending domain",
        why: "Access to your domain's DNS so emails send from your own address, for example hello@vitalitydental.co.uk, not a generic one. You grant access, we do the technical setup.",
        detail: [
          {
            lead: "What it means for you.",
            body: "So patient emails clearly come from your practice and reliably reach the inbox instead of the spam folder. It does not change or read your existing email, it only authorises us to send on your behalf from your domain.",
          },
          {
            lead: "How to do it.",
            body: "Give whoever manages your website domain (often your web designer or IT provider, on GoDaddy, Cloudflare, 123-reg or similar) the few DNS records we send, or add us as a user so we add them. It takes about ten minutes at their end. If you are not sure who manages the domain, your web person will know.",
          },
        ],
        tags: ["gate", "practice"],
      },
      {
        key: "approve-tone",
        name: "Approve the message tone and templates",
        why: "Sign off how the AI speaks to patients, across recall, reactivation, reminders and replies, before a single message goes out.",
        detail: [
          {
            lead: "What it means for you.",
            body: "You have the final say over how the platform talks to your patients: the wording, the warmth, and what it will and will not say. Nothing is sent that you have not seen.",
          },
          {
            lead: "How to do it.",
            body: "We share the draft messages for each situation (recall due, lapsed patient, appointment reminder, reply to a question). You read them, change anything that does not sound like your practice, and approve. Fifteen minutes, once.",
          },
        ],
        tags: ["gate", "practice"],
      },
    ],
  },
  {
    kicker: "02",
    title: "Make the content real",
    sub: "Replaces the sample content with your practice's own.",
    items: [
      {
        key: "usps",
        name: "Reasons to choose the practice",
        why: "Your genuine selling points. The AI weaves these into its messages, so the same true reasons show up across every channel.",
        detail: [
          {
            lead: "What it means for you.",
            body: "The real reasons a patient should choose you (for example: same-day emergency slots, gentle care for nervous patients, established twenty years, easy parking, evening appointments). The AI uses these so its messages sound like your practice, not a generic template.",
          },
          {
            lead: "How to do it.",
            body: "Jot down five to ten true selling points, or simply point us at the \"About\" or \"Why choose us\" page on your website and we will pull them from there. A quick bullet list or voice note is perfectly fine.",
          },
        ],
        tags: ["practice"],
      },
      {
        key: "knowledge",
        name: "Practice knowledge",
        why: "Services, price ranges, opening hours per site, dentist bios and common questions, so the AI answers patients accurately.",
        detail: [
          {
            lead: "What it means for you.",
            body: "The facts patients actually ask about, so the AI answers correctly rather than guessing: what treatments you offer, rough prices, opening hours at each site, who the dentists are, and the questions you hear most often.",
          },
          {
            lead: "How to do it.",
            body: "Send whatever you already have, a price list, your services page, an existing FAQ, or fill in the short questionnaire we provide. The more you share, the sharper and safer the answers.",
          },
        ],
        tags: ["practice"],
      },
      {
        key: "rota-details",
        name: "Staff rota details",
        why: "Staff list, availability and working hours, so the rota generates correctly and texts each person their shifts.",
        detail: [
          {
            lead: "What it means for you.",
            body: "So the rota tool can build the weekly shifts and text each team member, it needs to know who works, when, and where.",
          },
          {
            lead: "How to do it.",
            body: "Send your staff list with each person's role, mobile number and normal availability or working hours per site. Your current rota or a simple spreadsheet is ideal, we will take it from there.",
          },
        ],
        tags: ["practice"],
      },
      {
        key: "compliance-docs",
        name: "Compliance documents",
        why: "Your real policies, audit dates and training records. The compliance dashboard currently runs on sample data.",
        detail: [
          {
            lead: "What it means for you.",
            body: "The compliance area (CQC and GDC readiness, audits, staff training) is showing example data. To make it genuinely useful, it needs your real policies, audit schedule and training log.",
          },
          {
            lead: "How to do it.",
            body: "Share your existing compliance folder however you keep it, documents, a shared drive, or a spreadsheet, and we load it in. Nothing new to create; we just want what you already hold.",
          },
        ],
        tags: ["practice"],
      },
    ],
  },
  {
    kicker: "03",
    title: "Access and sign-off",
    sub: "Your calls, made when you are ready.",
    items: [
      {
        key: "go-live-decision",
        name: "Go-live decision, per system",
        why: "Turn each system on when you are ready. You hold the on and off switches, so you can start with one and add the rest.",
        detail: [
          {
            lead: "What it means for you.",
            body: "You decide when each part starts working for real, and you are never forced to switch everything on at once. Many practices start with one system, such as recall, watch it for a week, then add the next.",
          },
          {
            lead: "How to do it.",
            body: "Once the go-live gates above are cleared, just tell us which system to activate first. As the owner you have simple on and off switches inside the platform, so you stay in control day to day.",
          },
        ],
        tags: ["practice"],
      },
      {
        key: "dpa",
        name: "Data-processing agreement",
        why: "The GDPR paperwork covering how patient data is stored and used. We provide the template, you review and sign.",
        detail: [
          {
            lead: "What it means for you.",
            body: "The standard, and legally required, agreement that sets out how patient data is handled whenever a third party processes it on your behalf. It protects the practice and your patients.",
          },
          {
            lead: "How to do it.",
            body: "We send you the agreement ready to review. Your practice manager or data-protection lead reads and signs it. No cost, just a signature.",
          },
        ],
        tags: ["practice", "we"],
      },
      {
        key: "staff-logins",
        name: "Staff logins and roles",
        why: "Tell us who needs access and at what level. We create the accounts.",
        detail: [
          {
            lead: "What it means for you.",
            body: "Each team member gets their own secure login with the right level of access, so reception sees the day's worklists while the owner sees everything.",
          },
          {
            lead: "How to do it.",
            body: "Send us a list of who needs access and their role (owner, manager, reception). We create the accounts and send each person their login. Add or remove people any time.",
          },
        ],
        tags: ["practice", "we"],
      },
      {
        key: "meta-access",
        name: "Meta Ads account access",
        why: "If you want us to run and track Facebook and Instagram campaigns, grant access to your ad account so we can report real return on spend.",
        detail: [
          {
            lead: "What it means for you.",
            body: "Only needed if you would like us to run and measure paid Facebook and Instagram ads. Campaigns then run under your own business, and the platform shows what each pound of spend brings back.",
          },
          {
            lead: "How to do it.",
            body: "Add us as a partner or user on your Meta Business account (or share the relevant access). If you are not doing ads yet, simply skip this one and come back to it later.",
          },
        ],
        tags: ["practice", "optional"],
        optionalLabel: "If running ads",
      },
    ],
  },
];

const ALL_ITEMS = SECTIONS.flatMap((s) => s.items);
const TOTAL_ITEMS = ALL_ITEMS.length;
const GATE_COUNT = ALL_ITEMS.filter((i) => i.tags.includes("gate")).length;

/** The legend / tag styling, mapped onto the shared StatusPill tones. */
const TAG_META: Record<ItemTag, { label: string; tone: Tone }> = {
  gate: { label: "Go-live gate", tone: "warning" },
  practice: { label: "Practice provides", tone: "info" },
  we: { label: "We set up", tone: "success" },
  optional: { label: "Optional", tone: "neutral" },
};

/** Compact tag label used against each item (shorter than the legend label). */
const ITEM_TAG_LABEL: Record<ItemTag, string> = {
  gate: "Gate",
  practice: "Practice",
  we: "We set up",
  optional: "Optional",
};

function ItemTags({ item }: { item: ChecklistItem }) {
  return (
    <div className="flex flex-wrap justify-start gap-1.5 sm:justify-end">
      {item.tags.map((tag) => (
        <StatusPill key={tag} tone={TAG_META[tag].tone}>
          {tag === "optional" ? (item.optionalLabel ?? ITEM_TAG_LABEL.optional) : ITEM_TAG_LABEL[tag]}
        </StatusPill>
      ))}
    </div>
  );
}

export function GettingStartedView({ clientSlug }: { clientSlug: string }) {
  const client = getClient(clientSlug);

  // Ticked state, shared per practice. Loaded from the API; toggles persist there
  // so both owners see the same progress. Optimistic: the box flips instantly and
  // reverts if the save fails.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/getting-started?client=${encodeURIComponent(clientSlug)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("state fetch failed"))))
      .then((j: { ok?: boolean; state?: Record<string, boolean> }) => {
        if (active && j.ok) setChecked(j.state ?? {});
      })
      .catch(() => {
        // Keep everything un-ticked on error; the checklist still works.
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [clientSlug]);

  async function toggle(key: string) {
    if (!loaded) return;
    const next = !checked[key];
    setChecked((c) => ({ ...c, [key]: next })); // optimistic
    try {
      const res = await fetch("/api/getting-started", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, key, checked: next }),
      });
      if (!res.ok) throw new Error("save failed");
    } catch {
      // Re-sync from the server rather than blind-reverting: overlapping toggles
      // (or the other owner saving concurrently) make a blind !next wrong.
      try {
        const r = await fetch(`/api/getting-started?client=${encodeURIComponent(clientSlug)}`);
        const j = (await r.json()) as { ok?: boolean; state?: Record<string, boolean> };
        if (j.ok) setChecked(j.state ?? {});
      } catch {
        setChecked((c) => ({ ...c, [key]: !next })); // last resort: local revert
      }
    }
  }

  if (!client) {
    return <PageHeader title="Getting started" description="This client could not be found." />;
  }

  const doneCount = ALL_ITEMS.filter((i) => checked[i.key]).length;
  const fraction = TOTAL_ITEMS ? doneCount / TOTAL_ITEMS : 0;

  return (
    <>
      <PageHeader
        title="Getting started"
        description="Your go-live checklist. The platform, your data and every feature are already built and running, in read and review mode. This short list is only what we need from the practice to go fully live. Tick items off as you send them, both owners share the same list."
      />

      <SectionCard bodyClassName="p-5">
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          Right now the platform is in <span className="font-semibold text-navy">read and review mode</span>: it shows
          every patient, worklist and draft, but it does not contact patients or run campaigns until the items below are
          in place. We handle all the technical connections ourselves (your phone and WhatsApp senders, Google reviews,
          website form and domain). Open <span className="font-semibold text-navy">More info</span> on any item for what
          it means and how to do it, and <span className="font-semibold text-navy">tick the box</span> once you have sent it.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">Key</span>
          {(["gate", "practice", "we", "optional"] as ItemTag[]).map((tag) => (
            <StatusPill key={tag} tone={TAG_META[tag].tone}>
              {TAG_META[tag].label}
            </StatusPill>
          ))}
        </div>
      </SectionCard>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          emphasis
          label="Ticked off"
          value={`${doneCount} / ${TOTAL_ITEMS}`}
          icon={ListChecks}
          hint={doneCount === TOTAL_ITEMS ? "All items done" : "Items you have sent"}
        />
        <StatCard label="Go-live gates" value={GATE_COUNT} icon={ShieldAlert} hint="Block messaging until cleared" />
        <StatCard label="Platform" value="Built" icon={Rocket} hint="Data and features already live" />
      </div>

      <SectionCard bodyClassName="p-4">
        <div className="flex items-center gap-3">
          <ProgressMeter value={fraction} className="flex-1" />
          <span className="shrink-0 text-sm font-semibold text-navy tabular-nums">
            {doneCount} of {TOTAL_ITEMS} done
          </span>
        </div>
      </SectionCard>

      {SECTIONS.map((section) => (
        <SectionCard
          key={section.kicker}
          title={`${section.kicker}. ${section.title}`}
          description={section.sub}
          bodyClassName="p-0"
          className={section.gated ? "ring-warning/30" : undefined}
        >
          <ul className="divide-y divide-line">
            {section.items.map((item) => {
              const isChecked = Boolean(checked[item.key]);
              return (
                <li key={item.key} className="flex items-start gap-3.5 px-5 py-4">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={isChecked}
                    aria-label={isChecked ? `Mark "${item.name}" not done` : `Mark "${item.name}" done`}
                    disabled={!loaded}
                    onClick={() => toggle(item.key)}
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40",
                      isChecked
                        ? "border-success bg-success text-white"
                        : "border-line-strong bg-card hover:border-blue-royal/60",
                      !loaded && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {isChecked ? <Check size={13} strokeWidth={3} /> : null}
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p
                          className={cn(
                            "text-sm font-semibold text-navy transition-colors",
                            isChecked && "text-muted line-through decoration-muted/50",
                          )}
                        >
                          {item.name}
                        </p>
                        <p className="max-w-2xl text-sm leading-relaxed text-muted">{item.why}</p>
                      </div>
                      <ItemTags item={item} />
                    </div>
                    <details className="group mt-3">
                      <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-full bg-blue-royal/10 px-3 py-1 text-xs font-semibold text-blue-royal transition-colors hover:bg-blue-royal/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-royal/40">
                        <span className="text-[9px] leading-none transition-transform group-open:rotate-90">&#9656;</span>
                        <span>More info</span>
                      </summary>
                      <div className="mt-2.5 max-w-2xl space-y-2 rounded-xl bg-card-muted px-4 py-3 text-sm leading-relaxed text-muted">
                        {item.detail.map((para) => (
                          <p key={para.lead}>
                            <span className="font-semibold text-navy">{para.lead}</span> {para.body}
                          </p>
                        ))}
                      </div>
                    </details>
                  </div>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ))}

      <SectionCard bodyClassName="p-5">
        <p className="max-w-3xl text-sm leading-relaxed text-muted">
          In short: the product, your data and every feature are{" "}
          <span className="font-semibold text-navy">already built and live</span>, and we handle the technical
          connections ourselves. All that is left from the practice is consent, your email sender, your own selling
          points and knowledge, and the go-live sign-off. Clear the three go-live gates and the platform starts working
          for real.
        </p>
      </SectionCard>
    </>
  );
}
