"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { Loader2, Palette, Plus, Trash2, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PALETTES,
  PALETTE_TOKENS,
  paletteVarsFrom,
  swatchFromVars,
  type PaletteToken,
} from "@/lib/assess/palette";
import { MAX_THEME_NAME, type CustomTheme } from "@/lib/assess/custom-theme";

/**
 * "YOUR THEMES": build, rename, re-colour and remove the practice's own colour
 * schemes (migration 0081).
 *
 * WHY THIS IS ITS OWN FILE AND NOT PART OF campaigns-panel.tsx. Two reasons, and
 * the second is load-bearing:
 *
 *   1. The panel is already the create wizard, the campaign list, the funnel
 *      builder's host and the re-colour row. A colour editor with eighteen fields
 *      inside it would be the fourth thing in one file that is about a different
 *      subject from the other three.
 *   2. campaigns-panel.tsx is under a COLOUR-LITERAL BAN (create-experience-shell
 *      .test.ts, campaign-recolour.test.ts): not one hex may appear in it, because
 *      a hand-typed swatch there would be a second copy of the palette free to
 *      drift from the one the public page renders. This file legitimately holds
 *      hexes — an `<input type="color">` speaks nothing else — and keeping it
 *      separate means that ban stays absolute rather than becoming "except here".
 *
 * WHAT IT DOES NOT DO: decide whether a theme is allowed. Every colour is checked
 * by the SERVER — completeness, a strict colour grammar, and the same WCAG AA
 * thresholds the tuned presets clear — and this form's job when that fails is to
 * show the sentences back, pair by pair, not to pre-empt them. A browser-side
 * check would be a second implementation of the bar, and the first one free to
 * disagree with the gate that actually decides.
 */

/* ---------------------------------------------------------------------------
 * What each token IS, in the owner's language.
 * ------------------------------------------------------------------------- */

/**
 * Typed as a complete Record, so adding a token to PALETTE_TOKENS fails tsc here
 * rather than shipping a form with an unlabelled colour field in it.
 */
const TOKEN_LABEL: Record<PaletteToken, string> = {
  cream: "Page background",
  card: "Question card",
  "card-muted": "Inputs and the progress bar",
  navy: "Headings",
  ink: "Body text",
  muted: "Secondary text",
  faint: "Small print",
  "on-navy-muted": "Secondary text on a dark background",
  line: "Hairlines",
  "line-strong": "Stronger borders",
  "blue-light": "Light accent",
  "blue-dark": "Buttons",
  "blue-deep": "Small text in the accent colour",
  "blue-royal": "Lead brand colour",
  "status-royal": "Status text",
  "tint-royal": "Chip background",
  "tint-royal-line": "Chip border",
  "assess-glow": "Glow behind the card",
};

/** The order and grouping the form shows, so eighteen fields read as five decisions. */
const TOKEN_GROUPS: { title: string; tokens: PaletteToken[] }[] = [
  { title: "Surfaces", tokens: ["cream", "card", "card-muted"] },
  { title: "Text", tokens: ["navy", "ink", "muted", "faint", "on-navy-muted"] },
  { title: "Lines", tokens: ["line", "line-strong"] },
  {
    title: "Brand",
    tokens: ["blue-royal", "blue-dark", "blue-deep", "blue-light", "status-royal", "tint-royal", "tint-royal-line"],
  },
  { title: "Glow", tokens: ["assess-glow"] },
];

type Draft = Record<PaletteToken, string>;

/** A six-digit hex for `<input type="color">`, which speaks nothing else. */
function hexForPicker(value: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (match) return `#${match[1]}`;
  const short = /^#([0-9a-f]{3})$/i.exec(value.trim());
  if (short) return `#${[...short[1]].map((c) => c + c).join("")}`;
  // rgba(), #rrggbbaa and anything mid-edit: the swatch shows black and the text
  // field is the source of truth. Never rewrites what the owner typed.
  return "#000000";
}

const inputClass =
  "w-full rounded-lg border border-line bg-card-muted px-2 py-1 text-[11.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";

/* ---------------------------------------------------------------------------
 * The panel.
 * ------------------------------------------------------------------------- */

export function CustomThemePanel({
  clientSlug,
  themes,
  migrationPending,
  onChanged,
}: {
  clientSlug: string;
  themes: CustomTheme[];
  /** 0081 has not been applied here; say so instead of offering a form that 503s. */
  migrationPending?: boolean;
  /** Re-fetch the list after a write, so every picker on the screen agrees. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** The theme being edited, or null when the form is building a new one. */
  const [editing, setEditing] = useState<CustomTheme | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(theme: CustomTheme) {
    setBusyId(theme.id);
    setError(null);
    try {
      const res = await fetch(
        `/api/smile-assessment/theme/${encodeURIComponent(theme.id)}?client=${encodeURIComponent(clientSlug)}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // THE 409 IS THE POINT, not an inconvenience: it names the assessments still
      // wearing this scheme, because deleting it would silently re-colour every one
      // of their public pages.
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not remove it (${res.status}).`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove it.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="rounded-xl border border-line bg-card-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12.5px] font-semibold text-navy">
            <Palette size={14} /> Your colour schemes
          </p>
          <p className="mt-0.5 text-[11px] text-muted">
            Build the practice&rsquo;s own colours once and pick them on any assessment. Every scheme has
            to stay readable, so the colours are checked before they are saved.
          </p>
        </div>
        {migrationPending ? null : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(null);
              setError(null);
              setOpen((o) => !o);
            }}
          >
            {open ? <X size={14} /> : <Plus size={14} />}
            {open ? "Close" : "New scheme"}
          </Button>
        )}
      </div>

      {migrationPending ? (
        <p className="mt-2 rounded-lg border border-warning/25 bg-tint-amber px-3 py-2 text-[11.5px] text-status-amber">
          Your own colour schemes need migration 0081_assessment_custom_theme.sql to be applied to this
          deployment. The seven named schemes work as they always have.
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 whitespace-pre-line rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}

      {themes.length > 0 ? (
        <ul className="mt-2.5 space-y-1.5">
          {themes.map((theme) => (
            <li
              key={theme.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5"
            >
              <span aria-hidden className="flex shrink-0 items-center -space-x-1">
                {swatchFromVars(theme.vars).map((colour, i) => (
                  <span
                    key={colour + String(i)}
                    className="h-4 w-4 rounded-full border border-line-strong"
                    style={{ background: colour }}
                  />
                ))}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-ink">{theme.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setEditing(theme);
                  setError(null);
                  setOpen(true);
                }}
              >
                <Pencil size={12} /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={busyId !== null}
                onClick={() => void remove(theme)}
                aria-label={`Remove ${theme.name}`}
              >
                {busyId === theme.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {open && !migrationPending ? (
        <ThemeForm
          key={editing?.id ?? "new"}
          clientSlug={clientSlug}
          theme={editing}
          onDone={() => {
            setOpen(false);
            setEditing(null);
            onChanged();
          }}
          onCancel={() => {
            setOpen(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The form.
 * ------------------------------------------------------------------------- */

function ThemeForm({
  clientSlug,
  theme,
  onDone,
  onCancel,
}: {
  clientSlug: string;
  /** null = building a new scheme. */
  theme: CustomTheme | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  // A NEW SCHEME STARTS FROM A PRESET, never from a blank grid. Eighteen empty
  // colour fields is not a starting point an owner can use, and a preset is
  // guaranteed to be a map that already passes the server's gate — so the first
  // save an owner attempts succeeds, and each edit from there is one colour they
  // can reason about.
  const [startKey, setStartKey] = useState(PALETTES[2]?.key ?? PALETTES[0].key);
  const startPalette = useMemo(
    () => PALETTES.find((p) => p.key === startKey) ?? PALETTES[0],
    [startKey],
  );

  const [name, setName] = useState(theme?.name ?? "");
  const [draft, setDraft] = useState<Draft>(() => ({ ...(theme?.vars ?? startPalette.vars) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set(token: PaletteToken, value: string) {
    setDraft((d) => ({ ...d, [token]: value }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const url = theme
        ? `/api/smile-assessment/theme/${encodeURIComponent(theme.id)}?client=${encodeURIComponent(clientSlug)}`
        : `/api/smile-assessment/theme?client=${encodeURIComponent(clientSlug)}`;
      const res = await fetch(url, {
        method: theme ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, name, vars: draft }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // THE SERVER'S SENTENCES, VERBATIM. A 422 here names the failing pair and the
      // ratio it scored ("--muted on --card is 3.12:1, below the 4.5:1 minimum"),
      // which is the whole reason the gate reports pairs rather than "invalid".
      // Rewording it into "something went wrong" would throw away the only thing
      // that tells an owner which of eighteen colours to move.
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not save it (${res.status}).`);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save it.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-2.5 rounded-xl border border-line bg-card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-navy">Name</span>
          <input
            className={`mt-1 ${inputClass} py-1.5 text-[12.5px]`}
            value={name}
            maxLength={MAX_THEME_NAME}
            placeholder="Practice brand"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {theme ? null : (
          <label className="min-w-0">
            <span className="block text-xs font-semibold text-navy">Start from</span>
            <select
              className={`mt-1 ${inputClass} py-1.5 text-[12.5px]`}
              value={startKey}
              onChange={(e) => {
                setStartKey(e.target.value);
                const next = PALETTES.find((p) => p.key === e.target.value);
                if (next) setDraft({ ...next.vars });
              }}
            >
              {PALETTES.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/* WHAT THE COLOURS DO, on the colours themselves. The pairs the server
          measures are exactly the ones on show here — a heading, body copy,
          secondary copy, small print and the label on the button — so an owner
          adjusting a colour watches the thing the gate is about to judge. */}
      <div
        className="mt-3 rounded-xl border border-line p-3"
        style={paletteVarsFrom(draft) as CSSProperties}
      >
        <div className="rounded-lg bg-cream p-3">
          <div className="rounded-lg bg-card p-3">
            <p className="text-[13px] font-semibold text-navy">Is this treatment right for you?</p>
            <p className="mt-1 text-[11.5px] text-ink">
              Answer a few questions and the practice will come back to you.
            </p>
            <p className="mt-1 text-[11px] text-muted">It takes about a minute.</p>
            <div className="mt-2 rounded-lg bg-card-muted px-2 py-1.5 text-[11px] text-muted">
              Your answer goes here
            </div>
            <span className="mt-2 inline-block rounded-lg bg-blue-dark px-3 py-1.5 text-[11.5px] font-semibold text-card">
              Continue
            </span>
            <p className="mt-2 text-[10.5px] text-faint">We will never share your details.</p>
          </div>
        </div>
      </div>

      <div className="mt-3 space-y-2.5">
        {TOKEN_GROUPS.map((group) => (
          <div key={group.title}>
            <p className="text-[11px] font-semibold text-muted">{group.title}</p>
            <div className="mt-1 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.tokens.map((token) => (
                <label key={token} className="flex items-center gap-1.5">
                  <input
                    type="color"
                    aria-label={`${TOKEN_LABEL[token]} colour picker`}
                    className="h-6 w-7 shrink-0 cursor-pointer rounded border border-line-strong bg-card"
                    value={hexForPicker(draft[token])}
                    onChange={(e) => set(token, e.target.value)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[10.5px] text-muted">{TOKEN_LABEL[token]}</span>
                    <input
                      className={inputClass}
                      aria-label={TOKEN_LABEL[token]}
                      value={draft[token]}
                      onChange={(e) => set(token, e.target.value)}
                    />
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      {error ? (
        <p className="mt-2.5 whitespace-pre-line rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {theme ? "Save changes" : "Create scheme"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted">
          Checked for readability when you save. Every colour in the set is required.
        </span>
      </div>
    </div>
  );
}

/**
 * Every token the form actually renders a field for, in the order it renders them.
 *
 * EXPORTED FOR THE SUITE, and it is not a formality. The server refuses a theme
 * that is missing any token, so a form that quietly dropped one would produce a
 * save that can never succeed and an owner with no way to see why. The test
 * asserts this is exactly PALETTE_TOKENS; the Record type above catches an
 * unlabelled token, and this catches a labelled one nobody grouped.
 */
export const THEME_FORM_TOKENS: readonly PaletteToken[] = TOKEN_GROUPS.flatMap((g) => g.tokens);
