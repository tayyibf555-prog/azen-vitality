"use client";

import { useState, type FormEvent } from "react";
import { newSessionId } from "@/lib/landing/track";
import type { VariantKey } from "@/lib/landing/winner";
import type { FormCopy } from "@/lib/landing/bespoke/copy";

// The embedded consultation form for the bespoke Invisalign landing hero. A CLIENT
// component: it owns the field state and the submit, and posts to the public
// /api/landing-lead endpoint, which records a Speed-to-lead lead (feeding the
// worklist) and emits the funnel `lead` event (feeding the A/B Leads column).
//
// It carries NO secrets: the endpoint resolves the site + does all the sensitive
// work server-side. The only ids it sends are the public clientSlug/landingSlug,
// the A/B variant it was served, and a client-generated, PII-free sessionId.
//
// It renders with the design's own `.form` / `.field` / `.btn-blue` classes (styled
// by the page's scoped `.vd-landing` CSS) so it looks native to the ported design,
// and adds a channel selector, a consent checkbox, and success / error states.

type Channel = "whatsapp" | "sms" | "email";
type Status = "idle" | "submitting" | "success";

interface Props {
  variant: VariantKey;
  clientSlug: string;
  landingSlug: string;
  /** Ignored by the endpoint (it resolves the site from the live page), sent as a hint. */
  siteId?: string | null;
  /** Primary CTA label (the A/B-tested label), used on the submit button. */
  submitLabel: string;
  copy: FormCopy;
}

export function ConsultationForm({
  variant,
  clientSlug,
  landingSlug,
  siteId,
  submitLabel,
  copy,
}: Props) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<Channel>("whatsapp");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Stable per-mount session id (runs once). Correlates this lead's funnel event.
  const [sessionId] = useState<string>(() => newSessionId());

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === "submitting") return;
    setError(null);

    // Client-side validation mirrors the server's, for a fast, friendly message.
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const trimmedEmail = email.trim();
    if (!trimmedName) {
      setError(copy.errorName);
      return;
    }
    if (!trimmedPhone && !trimmedEmail) {
      setError(copy.errorContact);
      return;
    }
    if (!consent) {
      setError(copy.errorConsent);
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/landing-lead", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          landingSlug,
          variant,
          siteId: siteId ?? undefined,
          name: trimmedName,
          phone: trimmedPhone || undefined,
          email: trimmedEmail || undefined,
          channel,
          message: message.trim() || undefined,
          consent,
          sessionId,
        }),
      });
      let ok = res.ok;
      try {
        const body = (await res.json()) as { success?: boolean };
        ok = ok && body.success !== false;
      } catch {
        // Non-JSON body: fall back to the HTTP status.
      }
      if (!ok) {
        setStatus("idle");
        setError(copy.errorGeneric);
        return;
      }
      setStatus("success");
    } catch {
      setStatus("idle");
      setError(copy.errorGeneric);
    }
  }

  if (status === "success") {
    return (
      <div className="form" id="consultation">
        <div className="success">
          <div className="tick" aria-hidden>
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h3>{copy.successTitle}</h3>
          <p>{copy.successBody}</p>
        </div>
      </div>
    );
  }

  const submitting = status === "submitting";

  return (
    <form className="form" id="consultation" onSubmit={onSubmit} noValidate>
      <div className="fe">{copy.eyebrow}</div>
      <h3>{copy.heading}</h3>
      <p>{copy.subheading}</p>

      <label className="sr-only" htmlFor="lp-name">{copy.nameLabel}</label>
      <input
        id="lp-name"
        className="field"
        type="text"
        name="name"
        autoComplete="name"
        placeholder={copy.namePlaceholder}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={120}
      />

      <label className="sr-only" htmlFor="lp-phone">{copy.phoneLabel}</label>
      <input
        id="lp-phone"
        className="field"
        type="tel"
        name="phone"
        autoComplete="tel"
        inputMode="tel"
        placeholder={copy.phonePlaceholder}
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        maxLength={40}
      />

      <label className="sr-only" htmlFor="lp-email">{copy.emailLabel}</label>
      <input
        id="lp-email"
        className="field"
        type="email"
        name="email"
        autoComplete="email"
        inputMode="email"
        placeholder={copy.emailPlaceholder}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        maxLength={160}
      />

      <span className="clab" id="lp-channel-label">{copy.channelLabel}</span>
      <div className="channels" role="radiogroup" aria-labelledby="lp-channel-label">
        {([
          ["whatsapp", copy.channelWhatsApp],
          ["sms", copy.channelSms],
          ["email", copy.channelEmail],
        ] as [Channel, string][]).map(([value, label]) => (
          <label className="channel" key={value}>
            <input
              type="radio"
              name="channel"
              value={value}
              checked={channel === value}
              onChange={() => setChannel(value)}
            />
            {label}
          </label>
        ))}
      </div>

      <label className="sr-only" htmlFor="lp-message">{copy.messageLabel}</label>
      <textarea
        id="lp-message"
        className="field"
        name="message"
        placeholder={copy.messagePlaceholder}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        maxLength={1000}
      />

      <div className="consent">
        <input
          id="lp-consent"
          type="checkbox"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <label htmlFor="lp-consent">{copy.consentLabel}</label>
      </div>

      {error ? (
        <p className="err" role="alert">{error}</p>
      ) : null}

      <button type="submit" className="btn-blue block" disabled={submitting}>
        {submitting ? "Sending..." : submitLabel}
      </button>
      <p className="fine">{copy.fineprint}</p>
    </form>
  );
}
