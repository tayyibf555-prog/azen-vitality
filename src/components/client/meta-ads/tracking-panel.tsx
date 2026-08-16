"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_PIXEL_ID_LENGTH } from "@/lib/assess/meta-pixel";

/**
 * TRACKING: the practice's Meta pixel and Conversions API settings (0083).
 *
 * WHAT IT DOES NOT DO: decide whether a setting is allowed. The pixel id's grammar
 * and the "advanced matching cannot be orphaned" rule are enforced by the SERVER
 * (validatePixelConfig), and this form's job when that fails is to show the
 * sentences back. A browser-side copy of the rules would be a second
 * implementation of the gate, free to disagree with the one that actually decides
 * — the same line custom-theme-panel.tsx takes about colour contrast.
 *
 * WHY THE SCREEN SPELLS OUT WHAT THE PATIENT SEES. This is the one control in the
 * platform where an owner's click changes what happens on a stranger's device, and
 * the practice — not us — is the data controller answering for it. So the panel
 * says, in plain words, that visitors are asked first, that a refusal is honoured,
 * and exactly what does and does not leave when they agree. An owner who cannot
 * describe their own tracking to a patient who asks has been badly served by the
 * software.
 */

interface Settings {
  enabled: boolean;
  pixelId: string | null;
  advancedMatching: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

const inputClass =
  "w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-[13px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";

export function TrackingPanel({ clientSlug }: { clientSlug: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [migrationPending, setMigrationPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [pixelId, setPixelId] = useState("");
  const [advancedMatching, setAdvancedMatching] = useState(false);
  const [updatedBy, setUpdatedBy] = useState<string | null>(null);

  // THE READ IS A PLAIN PROMISE AND SETS NO STATE ITSELF. The effect below applies
  // the result in a callback, behind an `active` flag — the house pattern in
  // landing-pages.tsx — so the mount effect never commits a render only to
  // schedule another one, and a tab switched away from mid-request never writes
  // into an unmounted component.
  const load = useCallback(async (): Promise<
    { ok: true; settings: Settings; migrationPending: boolean } | { ok: false; error: string }
  > => {
    try {
      const res = await fetch(`/api/meta-ads/pixel?client=${encodeURIComponent(clientSlug)}`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; settings?: Settings; migrationPending?: boolean; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.settings) {
        return { ok: false, error: data?.error ?? "Could not read your tracking settings." };
      }
      return {
        ok: true,
        settings: data.settings,
        migrationPending: data.migrationPending === true,
      };
    } catch {
      return { ok: false, error: "Could not read your tracking settings." };
    }
  }, [clientSlug]);

  useEffect(() => {
    let active = true;
    void load().then((result) => {
      if (!active) return;
      if (!result.ok) {
        setError(result.error);
      } else {
        setEnabled(result.settings.enabled);
        setPixelId(result.settings.pixelId ?? "");
        setAdvancedMatching(result.settings.advancedMatching);
        setUpdatedBy(result.settings.updatedBy);
        setMigrationPending(result.migrationPending);
      }
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [load]);

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/meta-ads/pixel", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientSlug, enabled, pixelId, advancedMatching }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; settings?: Settings; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.settings) {
        setError(data?.error ?? "Could not save your tracking settings.");
      } else {
        // Re-seed from what was STORED, not from what was typed: switching
        // tracking off clears the pixel id server-side, and the form must show
        // that rather than keeping a number the database no longer holds.
        setEnabled(data.settings.enabled);
        setPixelId(data.settings.pixelId ?? "");
        setAdvancedMatching(data.settings.advancedMatching);
        setUpdatedBy(data.settings.updatedBy);
        setSaved(true);
      }
    } catch {
      setError("Could not save your tracking settings.");
    }
    setSaving(false);
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-line bg-card px-4 py-6 text-xs text-muted">
        <Loader2 size={14} className="animate-spin" />
        Loading your tracking settings...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-[10px] border border-line bg-card p-5">
        <h3 className="text-sm font-semibold text-navy">Meta pixel and Conversions API</h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted">
          Report assessment enquiries back to your Meta ad account, so Facebook and Instagram can
          learn which adverts actually produce patients instead of guessing. This affects your
          public assessment pages only.
        </p>

        {migrationPending ? (
          <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/60 px-4 py-3">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-muted" />
            <p className="text-xs leading-relaxed text-muted">
              Conversion tracking is not set up on this deployment yet, so the switch below will not
              save. Migration <code className="font-mono">0083_assess_meta_pixel.sql</code> needs to
              be applied first.
            </p>
          </div>
        ) : null}

        {/* ---- the switch ------------------------------------------------- */}
        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              // Turning tracking off turns the second switch off with it, so the
              // form can never show a tick that means nothing (the server refuses
              // that combination outright).
              if (!e.target.checked) setAdvancedMatching(false);
              setSaved(false);
            }}
            className="mt-0.5 size-4 shrink-0 accent-[var(--blue-dark)]"
          />
          <span>
            <span className="block text-[13px] font-semibold text-navy">
              Report assessment enquiries to Meta
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              Off by default. When on, visitors to your assessment pages are asked first, and
              nothing is sent to Meta from anyone who says no.
            </span>
          </span>
        </label>

        {/* ---- the id ------------------------------------------------------ */}
        <div className="mt-4 max-w-sm">
          <label htmlFor="meta-pixel-id" className="block text-[12px] font-medium text-navy">
            Meta pixel ID
          </label>
          <input
            id="meta-pixel-id"
            value={pixelId}
            onChange={(e) => {
              setPixelId(e.target.value);
              setSaved(false);
            }}
            inputMode="numeric"
            maxLength={MAX_PIXEL_ID_LENGTH}
            placeholder="e.g. 123456789012345"
            className={`mt-1 ${inputClass}`}
          />
          <p className="mt-1 text-[11px] leading-relaxed text-faint">
            The long number under Events Manager &rarr; Data sources. Digits only.
          </p>
        </div>

        {/* ---- advanced matching ------------------------------------------ */}
        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={advancedMatching}
            disabled={!enabled}
            onChange={(e) => {
              setAdvancedMatching(e.target.checked);
              setSaved(false);
            }}
            className="mt-0.5 size-4 shrink-0 accent-[var(--blue-dark)] disabled:opacity-40"
          />
          <span>
            <span className="block text-[13px] font-semibold text-navy">
              Also send hashed contact details for matching
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              Improves how well Meta can attribute an enquiry to the advert that produced it. The
              email and mobile are irreversibly hashed before they leave, and they are sent only for
              people who agreed to tracking on their own device. Leave this off if you are not sure
              &mdash; enquiries are still reported without it.
            </span>
          </span>
        </label>

        {/* ---- what actually happens --------------------------------------- */}
        <div className="mt-5 flex items-start gap-2.5 rounded-[10px] border border-line bg-card-muted/50 px-4 py-3">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-muted" />
          <div className="text-[11.5px] leading-relaxed text-muted">
            <p className="font-semibold text-navy">What your visitors experience</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>They are asked once, on the page, before anything loads from Meta.</li>
              <li>If they say no, nothing is requested from Meta and no cookie is set.</li>
              <li>The assessment behaves identically either way.</li>
              <li>
                We never send their name, their answers or their score &mdash; only that an enquiry
                happened, and the page it happened on.
              </li>
            </ul>
          </div>
        </div>

        {error ? (
          <p className="mt-4 whitespace-pre-line rounded-lg border border-line bg-card-muted px-3 py-2 text-xs text-ink">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center gap-3">
          <Button onClick={save} disabled={saving || migrationPending}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save tracking settings
          </Button>
          {saved ? <span className="text-xs text-muted">Saved.</span> : null}
          {updatedBy ? (
            <span className="text-[11px] text-faint">Last changed by {updatedBy}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
