"use client";

import { useState } from "react";

// The interactive part of the /prefs/<token> page. It lets a patient pick how they
// would like the practice to message them (SMS or WhatsApp) and save it, or ask us
// to stop messaging them. Everything POSTs the signed token back to /api/prefs; the
// server is the only authority on which patient this is.

type Channel = "sms" | "whatsapp";
type Status = "idle" | "saving" | "saved" | "stopping" | "stopped" | "error";

const CHANNELS: { value: Channel; label: string; hint: string }[] = [
  { value: "sms", label: "Text message", hint: "We will send a normal SMS to your mobile." },
  { value: "whatsapp", label: "WhatsApp", hint: "We will message you on WhatsApp instead." },
];

export function ChannelPrefForm({ token, practiceName }: { token: string; practiceName: string }) {
  const [choice, setChoice] = useState<Channel | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [confirmStop, setConfirmStop] = useState(false);

  async function post(action: Channel | "stop"): Promise<boolean> {
    try {
      const res = await fetch("/api/prefs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      return res.ok && data?.ok === true;
    } catch {
      return false;
    }
  }

  async function savePreference() {
    if (!choice || status === "saving") return;
    setStatus("saving");
    setStatus((await post(choice)) ? "saved" : "error");
  }

  async function stopMessaging() {
    if (status === "stopping") return;
    setStatus("stopping");
    setStatus((await post("stop")) ? "stopped" : "error");
  }

  if (status === "saved") {
    return (
      <Panel
        title="Thank you"
        body={`We have saved your preference. We will use ${
          choice === "whatsapp" ? "WhatsApp" : "text messages"
        } to reach you from now on.`}
      />
    );
  }

  if (status === "stopped") {
    return (
      <Panel
        title="You are opted out"
        body={`We will stop sending you messages from ${practiceName}. If you booked an appointment, you may still receive essential reminders about it.`}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-line bg-card p-5 shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
        <p className="text-sm font-semibold text-navy">How would you like us to message you?</p>
        <p className="mt-1 text-xs text-muted">Choose the option that suits you best, then save.</p>

        <div className="mt-4 space-y-3">
          {CHANNELS.map((c) => {
            const active = choice === c.value;
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => setChoice(c.value)}
                aria-pressed={active}
                className={`flex w-full items-start gap-3 rounded-xl border p-3.5 text-left transition ${
                  active
                    ? "border-blue-deep bg-[rgba(91,196,247,0.10)] ring-1 ring-blue-deep"
                    : "border-line bg-cream hover:border-blue-deep/50"
                }`}
              >
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${
                    active ? "border-blue-deep bg-blue-deep" : "border-line bg-card"
                  }`}
                >
                  {active ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-navy">{c.label}</span>
                  <span className="block text-xs text-muted">{c.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={savePreference}
          disabled={!choice || status === "saving"}
          className="mt-4 w-full rounded-xl bg-blue-deep px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-deep/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === "saving" ? "Saving..." : "Save my preference"}
        </button>

        {status === "error" ? (
          <p className="mt-3 text-center text-xs font-semibold text-danger">
            Sorry, that did not save. Please try again in a moment.
          </p>
        ) : null}
      </div>

      <div className="rounded-2xl border border-line bg-card p-5 text-center shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
        <p className="text-sm font-semibold text-navy">Would you rather not hear from us?</p>
        {confirmStop ? (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-muted">
              We will stop messaging you. You can always get back in touch with the practice
              directly.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirmStop(false)}
                className="flex-1 rounded-xl border border-line bg-cream px-4 py-2.5 text-sm font-semibold text-navy transition hover:border-blue-deep/50"
              >
                Keep messaging me
              </button>
              <button
                type="button"
                onClick={stopMessaging}
                disabled={status === "stopping"}
                className="flex-1 rounded-xl border border-danger/40 bg-[rgba(239,68,68,0.08)] px-4 py-2.5 text-sm font-semibold text-danger transition hover:bg-[rgba(239,68,68,0.14)] disabled:opacity-50"
              >
                {status === "stopping" ? "Please wait..." : "Yes, stop messaging me"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmStop(true)}
            className="mt-2 text-sm font-semibold text-blue-deep underline-offset-2 hover:underline"
          >
            Stop messaging me
          </button>
        )}
      </div>
    </div>
  );
}

function Panel({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-6 text-center shadow-[0_4px_16px_rgba(10,14,26,0.08)]">
      <p className="text-sm font-semibold text-navy">{title}</p>
      <p className="mt-2 text-sm text-muted">{body}</p>
    </div>
  );
}
