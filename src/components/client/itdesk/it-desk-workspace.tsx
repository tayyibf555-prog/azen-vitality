"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, Loader2, MessageSquare, Phone } from "lucide-react";
import { DeskChat } from "@/components/client/desk/desk-chat";
import { cn } from "@/lib/utils";
import { AREA_LABELS, type Playbook, type PlaybookArea } from "@/lib/itdesk/types";
import type { ContactForm } from "@/lib/itdesk/view";
// One first step, shared with Home's Operating system band. See
// src/lib/systems/first-steps.ts.
import { firstStepFor } from "@/lib/systems/first-steps";

// ===========================================================================
// THE IT DESK'S WORKSPACE: three tabs.
//
//   Ask         the agent
//   Playbooks   the same steps the agent walks, readable by a person — because
//               the desk being switched off, or the model being slow, must not
//               be the reason nobody can find out how to clear a print queue
//   IT contact  who to ring, and (owner only) setting it
//
// The playbooks and the contact arrive as props from the server view. Nothing
// here is exported but the component.
// ===========================================================================

type TabKey = "ask" | "playbooks" | "contact";

export function ItDeskWorkspace({
  clientSlug,
  playbooksByArea,
  contact,
  contactUnavailable,
  canEditContact,
  systemEnabled,
}: {
  clientSlug: string;
  playbooksByArea: { area: PlaybookArea; playbooks: Playbook[] }[];
  contact: ContactForm;
  /** True when the contact could not be READ — not the same as none being set. */
  contactUnavailable: boolean;
  /** Owner + agency only. Reading it is for everyone with the module. */
  canEditContact: boolean;
  systemEnabled: boolean;
}) {
  const router = useRouter();
  // WHICH TAB A PRACTICE THAT HAS NOT SET ANYTHING UP OPENS ON.
  //
  // It used to be "ask", always, which meant a practice with no IT contact set
  // landed on a chat whose entire purpose at the end of a playbook is to hand
  // somebody a phone number it does not have — and the sentence saying so sat
  // one tab away, unread. So an unconfigured desk opens on the thing that
  // configures it, exactly as the equipment register does (it opens on Register
  // when there is no equipment). A configured one is unchanged and still opens
  // on the chat, which is what it is for.
  //
  // `contact`, not `form`: the prop is the server's answer, and the initial
  // state is computed once, so a person clearing the phone field mid-edit does
  // not throw themselves onto another tab.
  const [tab, setTab] = useState<TabKey>(
    contact.phone?.trim() || contact.email?.trim() ? "ask" : "contact",
  );
  const [form, setForm] = useState<ContactForm>(contact);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openPlaybook, setOpenPlaybook] = useState<string | null>(null);

  const hasContact = Boolean(form.phone?.trim() || form.email?.trim());

  const saveContact = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/itdesk/set-contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: clientSlug, ...form }),
      });
      const data = ((await response.json()) ?? {}) as Record<string, unknown>;
      setMessage(data.ok ? "Saved." : String(data.error ?? "We could not save that."));
      if (data.ok) router.refresh();
    } catch {
      setMessage("We could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof ContactForm, label: string, placeholder = "") => (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">{label}</span>
      <input
        type="text"
        value={form[key] ?? ""}
        placeholder={placeholder}
        disabled={!canEditContact}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong disabled:bg-tile disabled:text-muted"
      />
    </label>
  );

  const TABS: { key: TabKey; label: string; icon: typeof Phone }[] = [
    { key: "ask", label: "Ask the desk", icon: MessageSquare },
    { key: "playbooks", label: "Playbooks", icon: BookOpen },
    { key: "contact", label: "IT contact", icon: Phone },
  ];

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="IT desk sections" className="inline-flex flex-wrap gap-0.5 rounded-lg border border-line-strong bg-card p-[3px]">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "pressable inline-flex items-center gap-2 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition-colors",
              tab === key ? "bg-navy font-semibold text-white" : "text-muted hover:text-navy",
            )}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {message ? (
        <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] text-navy">{message}</p>
      ) : null}

      {tab === "ask" ? (
        <DeskChat
          endpoint="/api/itdesk/ask"
          clientSlug={clientSlug}
          emptyHeading="What is not working?"
          emptyBody="I help with the practice's day-to-day IT: the internet and network, printers and scanning, being locked out, getting into Dentally, and the iPads and form kiosks. Tell me what you see on the screen and I will walk you through it one step at a time. I never handle passwords, never turn off antivirus or two-factor sign-in, and I cannot reach or control any computer — when the steps run out I hand you over to the practice's IT contact."
          placeholder="Describe what is happening, and what is on the screen"
          starters={[
            "Nothing will print from the front desk computer.",
            "Dentally will not load on any machine.",
            "The iPad patients use for the form is frozen.",
          ]}
          disabledNote={
            systemEnabled
              ? undefined
              : "The IT desk is switched off. The practice owner can switch it on in System controls; the playbooks stay readable either way."
          }
        />
      ) : null}

      {tab === "playbooks" ? (
        <div className="space-y-5">
          <p className="text-[12.5px] leading-relaxed text-muted">
            The steps the desk walks you through, written so anybody at the front desk can follow them. Every one ends
            by handing over to the practice&rsquo;s IT contact rather than trailing off.
          </p>
          {playbooksByArea.map(({ area, playbooks }) => (
            <div key={area}>
              <h3 className="text-title text-navy">{AREA_LABELS[area]}</h3>
              <ul className="mt-2 divide-y divide-line rounded-[10px] border border-line">
                {playbooks.map((p) => {
                  const open = openPlaybook === p.id;
                  return (
                    <li key={p.id} className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setOpenPlaybook(open ? null : p.id)}
                        aria-expanded={open}
                        className="w-full text-left"
                      >
                        <span className="text-[13px] font-medium text-navy">{p.title}</span>
                        <span className="mt-0.5 block text-[12px] text-muted">{p.symptoms.slice(0, 3).join(" · ")}</span>
                      </button>
                      {open ? (
                        <div className="mt-3 space-y-2">
                          <ol className="list-decimal space-y-1.5 pl-5 text-[12.5px] leading-relaxed text-navy">
                            {p.steps.map((step) => (
                              <li key={step}>{step}</li>
                            ))}
                          </ol>
                          <p className="rounded-[8px] bg-tile px-3 py-2 text-[12.5px] leading-relaxed text-muted">
                            {p.escalation}
                          </p>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "contact" ? (
        <div className="space-y-4">
          {contactUnavailable ? (
            <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] text-navy">
              We could not read the IT contact just now, so this is showing blank rather than showing that none is set.
              Nothing has been lost — try again in a moment.
            </p>
          ) : !hasContact ? (
            <p className="rounded-[8px] border border-line bg-tile px-3 py-2 text-[12.5px] leading-relaxed text-navy">
              <span className="font-semibold">No IT contact has been added yet.</span>{" "}
              {firstStepFor("it-desk")?.step} Until one is set, the desk says so plainly when it runs out of steps
              rather than inventing a number.
            </p>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2">
            {field("name", "Contact name", "e.g. Sam Patel")}
            {field("company", "Company", "e.g. Northline IT")}
            {field("phone", "Phone", "e.g. 020 7000 0000")}
            {field("email", "Email", "e.g. support@northline.co.uk")}
            {field("hours", "Hours", "e.g. Mon-Fri 8am-6pm")}
          </div>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium uppercase tracking-[0.04em] text-faint">
              What staff should be told before they ring
            </span>
            <textarea
              value={form.notes ?? ""}
              disabled={!canEditContact}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={2}
              placeholder="e.g. quote the practice name and our support reference"
              className="rounded-[8px] border border-line px-2.5 py-1.5 text-[13px] text-navy outline-none focus:border-line-strong disabled:bg-tile disabled:text-muted"
            />
          </label>

          {canEditContact ? (
            <button
              type="button"
              onClick={() => void saveContact()}
              disabled={busy}
              className="pressable inline-flex items-center gap-1.5 rounded-[8px] bg-navy px-3 py-1.5 text-[12.5px] font-medium text-white disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              Save IT contact
            </button>
          ) : (
            <p className="text-[12.5px] text-muted">
              Only the practice owner can change who the desk escalates to.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
