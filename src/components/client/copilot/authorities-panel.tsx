"use client";

import { useCallback, useState } from "react";
import { BookMarked, ChevronDown, Loader2, Plus, X, Archive } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/components/primitives";
import {
  AUTHORITY_BODY_MAX_CHARS,
  AUTHORITY_FIELD_MAX_CHARS,
  COPYRIGHT_RULE,
  citationFor,
} from "@/lib/knowledge/authorities";
// What the co-pilot is actually handed, said in the owner's words. The bound is
// the brief's own (AUTHORITY_BRIEF_MAX), imported there and never retyped.
import {
  NOT_IN_USE_LABEL,
  authoritiesBoundNote,
  authoritiesInScope,
  authoritiesSubtitle,
} from "./authorities-scope";
import {
  AUTHORITY_KINDS,
  AUTHORITY_KIND_LABELS,
  type ApprovedAuthority,
  type AuthorityKind,
} from "@/lib/knowledge/types";
// One first step, shared with Home's Operating system band, so the band and the
// panel ask for the same thing. See src/lib/systems/first-steps.ts.
import { firstStepFor } from "@/lib/systems/first-steps";

// ===========================================================================
// THE OWNER'S APPROVED-AUTHORITIES PANEL.
//
// It sits UNDER the co-pilot chat, collapsed, because it is a setup surface and
// the chat is the working one: an owner opens this page to ask a question, not to
// curate a reading list, and a permanently open form would push the composer down
// the screen for a job done three times a year.
//
// WHERE THE VALUES COME FROM. Every rule this panel shows — the copyright
// sentence, the two ceilings, the list of kinds — is imported from the PURE
// modules (@/lib/knowledge/authorities and .../types), never restated here. A
// character counter that counted against a number typed into this file would go
// stale the day the ceiling moved, and would then be telling the owner they had
// room the server was about to refuse.
//
// RSC: this is a `"use client"` module, so it may hand a server file NOTHING but
// components. It exports one component and no constants, per the rule pinned by
// src/components/client/reports/rsc-value-import.test.ts. The page that renders
// it resolves the owner role on the SERVER and simply does not render this at all
// for anybody else; nothing here is the lock (the four guards on
// /api/authorities/[action] are).
// ===========================================================================

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

interface FormState {
  name: string;
  kind: AuthorityKind;
  publisher: string;
  reference: string;
  summary: string;
  principles: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  kind: "guideline",
  publisher: "",
  reference: "",
  summary: "",
  principles: "",
};

/**
 * The live count, against the ceiling the SERVER will apply.
 *
 * It turns red at the limit rather than blocking the keystroke, and the copy says
 * what happens next: the save is refused, nothing is shortened. Silently clamping
 * the textarea's length would be the same defect as a silent truncation server
 * side — the owner would watch their sentence stop mid-word and not know why.
 */
function CharCount({ value, max }: { value: string; max: number }) {
  const used = value.trim().length;
  const over = used > max;
  return (
    <span
      className={cn("text-[11px] tabular-nums", over ? "font-semibold text-status-red" : "text-faint")}
      aria-live="polite"
    >
      {used.toLocaleString()} / {max.toLocaleString()}
      {over ? " — too long to save" : ""}
    </span>
  );
}

export function AuthoritiesPanel({ clientSlug }: { clientSlug: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ApprovedAuthority[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const call = useCallback(
    async (action: string, body: object) => {
      const res = await fetch(`/api/authorities/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: clientSlug, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        authorities?: ApprovedAuthority[];
        authority?: ApprovedAuthority;
      };
      if (!res.ok || !data.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
      return data;
    },
    [clientSlug],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await call("list", {});
      setRows(data.authorities ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the approved sources.");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [call]);

  // NOTHING IS FETCHED UNTIL THE OWNER OPENS THE PANEL: the co-pilot page's job is
  // the chat, and a closed drawer should cost no round-trip. The fetch hangs off the
  // OPENING GESTURE rather than off an effect watching `open`, which is both the
  // simpler shape and the one the house lint rule requires (an effect body that
  // calls setState synchronously is a cascading render — react-hooks/set-state-in-effect).
  // The fetch is deliberately OUTSIDE the state updater: React may invoke an
  // updater twice (StrictMode, and any re-render it decides to replay), and a
  // network call in one would fire twice for one click.
  const toggle = useCallback(() => {
    if (!open) void load();
    setOpen(!open);
  }, [open, load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      // The server validates again and is the authority on every rule here; this
      // call simply carries what was typed.
      await call("create", form);
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "That could not be saved.");
    } finally {
      setSubmitting(false);
    }
  }

  async function archive(id: string) {
    setBusyId(id);
    try {
      await call("archive", { id });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "That could not be archived.");
    } finally {
      setBusyId(null);
    }
  }

  // WHAT IS STORED IS NOT WHAT IS IN SCOPE. `authoritiesBrief` is handed the
  // first AUTHORITY_BRIEF_MAX active sources and no more, so the count on this
  // panel and the sentence attached to it have to come apart above that bound.
  // See authorities-scope.ts for why the rows in scope are the ones at the top
  // of this list.
  const { active, inBrief, overBound } = authoritiesInScope(rows);
  const boundNote = authoritiesBoundNote(active.length);

  return (
    <section className="rounded-card bg-card ring-1 ring-line">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="pressable flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left sm:px-5"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <BookMarked size={15} className="shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[13px] font-semibold text-navy">
              Approved sources
            </span>
            <span className="block truncate text-[11.5px] text-muted">
              {open
                ? "Outside sources the co-pilot may lean on, in your own words."
                : authoritiesSubtitle(active.length)}
            </span>
          </span>
        </span>
        <ChevronDown
          size={16}
          aria-hidden
          className={cn("shrink-0 text-muted transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <div className="border-t border-line px-4 py-4 sm:px-5">
          {/* WHAT THE LIST IS, said once, in the place the owner is deciding what
              to put in it. The default posture is the first sentence because it is
              the thing most likely to be misunderstood: an empty list is not a
              gap, it is the platform working from the practice's own records. */}
          <p className="max-w-2xl text-[12.5px] leading-5 text-muted">
            The co-pilot answers from this practice&apos;s own records. If there are outside sources you want it
            to take account of — a regulator&apos;s standards, a guideline, a textbook, a course you sat — list
            them here and it will cite them by name when they inform an answer. Nothing is fetched from the
            internet: what the co-pilot reads is what you write below.
          </p>

          {/* AND THE BOUND, ON THE SCREEN AND NOT ONLY IN THE PROMPT. The brief
              carries at most AUTHORITY_BRIEF_MAX sources; above that the honest
              "Showing 8 of 12" line goes into the system prompt, where nobody
              can read it. This is the same fact where the owner is. */}
          {boundNote ? (
            <p className="mt-2 max-w-2xl rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-5 text-status-amber">
              {boundNote}
            </p>
          ) : null}

          {loadError ? (
            <p className="mt-3 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[12.5px] text-status-red">
              {loadError}
            </p>
          ) : null}

          {/* --- the list ------------------------------------------------- */}
          <div className="mt-4">
            {loading ? (
              <p className="flex items-center gap-2 text-[12.5px] text-muted">
                <Loader2 size={13} className="animate-spin" aria-hidden /> Loading…
              </p>
            ) : rows.length === 0 ? (
              <p className="max-w-2xl text-[12.5px] leading-5 text-faint">
                <span className="font-medium text-muted">No approved sources yet.</span>{" "}
                {firstStepFor("authorities")?.step}
              </p>
            ) : (
              <ul className="divide-y divide-line border-y border-line">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-navy">
                        <span className="truncate">{citationFor(row)}</span>
                        <StatusPill tone={row.status === "active" ? "info" : "neutral"}>
                          {row.status === "active" ? AUTHORITY_KIND_LABELS[row.kind] : "Archived"}
                        </StatusPill>
                        {/* THE ROWS THE MODEL WILL NOT SEE, marked where the
                            owner is looking at them. Only above the bound: with
                            eight or fewer every row is in scope and a marker on
                            none of them would be noise. */}
                        {overBound && row.status === "active" && !inBrief.has(row.id) ? (
                          <StatusPill tone="warning">{NOT_IN_USE_LABEL}</StatusPill>
                        ) : null}
                      </p>
                      {row.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-[12px] leading-5 text-muted">{row.summary}</p>
                      ) : null}
                      {row.reference ? (
                        // Plain text, never a link: it is a citation, and the
                        // platform does not fetch it.
                        <p className="mt-0.5 truncate text-[11px] text-faint">{row.reference}</p>
                      ) : null}
                    </div>
                    {row.status === "active" ? (
                      <button
                        type="button"
                        onClick={() => void archive(row.id)}
                        disabled={busyId === row.id}
                        className="pressable flex shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-medium text-muted transition-colors hover:bg-row-hover hover:text-navy disabled:opacity-45"
                      >
                        {busyId === row.id ? (
                          <Loader2 size={13} className="animate-spin" aria-hidden />
                        ) : (
                          <Archive size={13} aria-hidden />
                        )}
                        Archive
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* --- the form -------------------------------------------------- */}
          {showForm ? (
            <form onSubmit={submit} className="mt-4 rounded-lg border border-line bg-card-muted/40 p-3.5">
              {/* THE COPYRIGHT RULE, VERBATIM, above the two body fields and not
                  buried in a tooltip. It is imported, never retyped. */}
              <p className="rounded-lg border border-tint-amber-line bg-tint-amber px-3 py-2 text-[12px] leading-5 text-status-amber">
                {COPYRIGHT_RULE}
              </p>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass} htmlFor="authority-name">
                    Name
                  </label>
                  <input
                    id="authority-name"
                    className={inputClass}
                    value={form.name}
                    maxLength={AUTHORITY_FIELD_MAX_CHARS.name}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="Standards for the Dental Team"
                    required
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="authority-kind">
                    Kind
                  </label>
                  <select
                    id="authority-kind"
                    className={inputClass}
                    value={form.kind}
                    onChange={(e) => set("kind", e.target.value as AuthorityKind)}
                  >
                    {AUTHORITY_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {AUTHORITY_KIND_LABELS[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass} htmlFor="authority-publisher">
                    Publisher
                  </label>
                  <input
                    id="authority-publisher"
                    className={inputClass}
                    value={form.publisher}
                    maxLength={AUTHORITY_FIELD_MAX_CHARS.publisher}
                    onChange={(e) => set("publisher", e.target.value)}
                    placeholder="General Dental Council"
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="authority-reference">
                    Reference
                  </label>
                  <input
                    id="authority-reference"
                    className={inputClass}
                    value={form.reference}
                    maxLength={AUTHORITY_FIELD_MAX_CHARS.reference}
                    onChange={(e) => set("reference", e.target.value)}
                    placeholder="A link, an ISBN, or an edition and page range"
                  />
                  <p className="mt-1 text-[11px] text-faint">
                    Stored so you can find the source again. It is never opened or downloaded.
                  </p>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex items-end justify-between gap-3">
                  <label className={labelClass} htmlFor="authority-summary">
                    Your summary of it
                  </label>
                  <CharCount value={form.summary} max={AUTHORITY_BODY_MAX_CHARS.summary} />
                </div>
                <textarea
                  id="authority-summary"
                  rows={3}
                  className={cn(inputClass, "resize-y")}
                  value={form.summary}
                  onChange={(e) => set("summary", e.target.value)}
                  placeholder="In your own words: what this source covers and why the practice works to it."
                />
              </div>

              <div className="mt-3">
                <div className="flex items-end justify-between gap-3">
                  <label className={labelClass} htmlFor="authority-principles">
                    The principles you take from it
                  </label>
                  <CharCount value={form.principles} max={AUTHORITY_BODY_MAX_CHARS.principles} />
                </div>
                <textarea
                  id="authority-principles"
                  rows={5}
                  className={cn(inputClass, "resize-y")}
                  value={form.principles}
                  onChange={(e) => set("principles", e.target.value)}
                  placeholder="The practice's own distilled points, one per line."
                />
              </div>

              {formError ? (
                <p className="mt-3 rounded-lg border border-tint-red-line bg-tint-red px-3 py-2 text-[12.5px] leading-5 text-status-red">
                  {formError}
                </p>
              ) : null}

              <div className="mt-3 flex items-center gap-2">
                <Button type="submit" size="sm" disabled={submitting}>
                  {submitting ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
                  Save source
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setShowForm(false);
                    setFormError(null);
                  }}
                >
                  <X size={14} aria-hidden />
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={() => setShowForm(true)}>
              <Plus size={14} aria-hidden />
              Add a source
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
