"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Loader2, Copy, Check, ExternalLink, UserPlus, X, Pause, Play, Search, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { getClient } from "@/lib/mock/clients";
import { resolveSteps } from "@/lib/onboarding/resolve";
import { OnboardingPreview } from "@/components/onboarding/onboarding-preview";
import type { OnboardingConfig, OnboardingStep } from "@/lib/onboarding/types";

// The Forms tab: owner-created onboarding forms, each a shareable /onboard/<client>/<slug>
// link to send to patients. Mirrors the Smile Assessment campaigns panel: create a named
// form (with optional public headline/intro + custom URL), get its shareable URL with a
// copy button, and manage a searchable list with copy/open/pause per form. Submissions
// come back under the Submissions tab, attributed to the form.

/** One form as returned by the admin API (GET/POST). Mirrors the server toAdminView. */
interface AdminForm {
  id: string;
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  status: "active" | "paused";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  path: string;
  submissionCount: number;
}

interface FormState {
  name: string;
  headline: string;
  intro: string;
  slug: string;
}

const EMPTY_FORM: FormState = { name: "", headline: "", intro: "", slug: "" };

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

/** Copy-to-clipboard button with a transient "Copied" confirmation. */
function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be blocked (no permission / insecure context); fail quietly.
    }
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card-muted"
    >
      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

/** A small branded preview of how the form's hero copy reads to a patient. */
function FormPreview({ practiceName, headline, intro }: { practiceName: string; headline: string; intro: string }) {
  return (
    <div className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
      <p className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted">Preview</p>
      <div className="mt-3 rounded-xl border border-line bg-card p-5 text-center shadow-[0_1px_2px_rgba(10,14,26,0.04)]">
        <p className="text-sm font-bold text-navy">{practiceName || "Your practice"}</p>
        <p className="text-[0.65rem] font-semibold uppercase tracking-[0.2em] text-blue-deep">
          New patient onboarding
        </p>
        <p className="mt-3 text-base font-semibold text-navy">
          {headline.trim() || "Welcome"}
        </p>
        {intro.trim() ? <p className="mt-1 text-xs text-muted">{intro.trim()}</p> : null}
      </div>
    </div>
  );
}

export function FormsPanel({ clientSlug }: { clientSlug: string }) {
  const [forms, setForms] = useState<AdminForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  // The form whose preview is open at the side. The list does not carry the question
  // config, so on select we fetch the form and resolve its config into the steps a
  // patient would actually see.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [previewSteps, setPreviewSteps] = useState<OnboardingStep[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/onboarding/form?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; forms?: AdminForm[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load forms (${res.status}).`);
      setForms(data.forms ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load forms.");
      setForms([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  useEffect(() => {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreatedUrl(null);
    setQuery("");
    setSelectedSlug(null);
    void load();
  }, [load]);

  // Fetch + resolve the selected form's question config for the side preview.
  useEffect(() => {
    if (!selectedSlug) {
      setPreviewSteps(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewSteps(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/onboarding/form/${encodeURIComponent(selectedSlug)}?client=${encodeURIComponent(clientSlug)}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          form?: { config?: OnboardingConfig };
        };
        if (cancelled) return;
        const config = res.ok && data.ok ? data.form?.config ?? null : null;
        setPreviewSteps(resolveSteps(config));
      } catch {
        if (!cancelled) setPreviewSteps(resolveSteps(null));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, clientSlug]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/onboarding/form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          name: form.name,
          headline: form.headline || undefined,
          intro: form.intro || undefined,
          slug: form.slug || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; form?: AdminForm; error?: string };
      if (!res.ok || !data.ok || !data.form) {
        throw new Error(data.error || `Could not create the form (${res.status}).`);
      }
      setForms((prev) => [data.form as AdminForm, ...prev]);
      setCreatedUrl(data.form.url);
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the form.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(f: AdminForm) {
    if (togglingId) return;
    const next = f.status === "active" ? "paused" : "active";
    setTogglingId(f.id);
    setForms((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: next } : x)));
    try {
      const res = await fetch(
        `/api/onboarding/form/${encodeURIComponent(f.slug)}?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, status: next }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "status update failed");
    } catch {
      setForms((prev) => prev.map((x) => (x.id === f.id ? { ...x, status: f.status } : x)));
    } finally {
      setTogglingId(null);
    }
  }

  const practiceName = getClient(clientSlug)?.name ?? "";
  const selected = forms.find((f) => f.slug === selectedSlug) ?? null;

  const slugPreview = (form.slug || form.name)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return forms;
    return forms.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.slug.toLowerCase().includes(q) ||
        f.url.toLowerCase().includes(q),
    );
  }, [forms, query]);

  return (
    <SectionCard
      title="Forms"
      description="Create a form, then share its link with patients. Every submission comes back under Submissions, attributed to the form it came from."
      actions={
        <Button
          variant={showForm ? "secondary" : "primary"}
          size="sm"
          onClick={() => {
            setFormError(null);
            setCreatedUrl(null);
            setShowForm((s) => !s);
          }}
        >
          {showForm ? <X size={15} /> : <Plus size={15} />}
          {showForm ? "Cancel" : "New form"}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Create form, with a live preview of the public landing header. */}
        {showForm ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <form onSubmit={submit} className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
              <div className="grid gap-4">
                <div>
                  <label htmlFor="of-name" className={labelClass}>
                    Name <span className="text-danger">*</span>
                  </label>
                  <input
                    id="of-name"
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => set("name", e.target.value)}
                    placeholder="New patient registration"
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-muted">An internal label, only your team sees this.</p>
                </div>

                <div>
                  <label htmlFor="of-headline" className={labelClass}>
                    Public headline
                  </label>
                  <input
                    id="of-headline"
                    type="text"
                    value={form.headline}
                    onChange={(e) => set("headline", e.target.value)}
                    placeholder="Welcome to Vitality Dental"
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="of-intro" className={labelClass}>
                    Public intro
                  </label>
                  <textarea
                    id="of-intro"
                    rows={2}
                    value={form.intro}
                    onChange={(e) => set("intro", e.target.value)}
                    placeholder="A few quick details so we can register you and arrange your first visit."
                    className={inputClass}
                  />
                </div>

                <div>
                  <label htmlFor="of-slug" className={labelClass}>
                    Custom URL (optional)
                  </label>
                  <input
                    id="of-slug"
                    type="text"
                    value={form.slug}
                    onChange={(e) => set("slug", e.target.value)}
                    placeholder="new-patients"
                    className={inputClass}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Becomes{" "}
                    <span className="font-semibold text-ink">
                      /onboard/{clientSlug}/{slugPreview || "your-slug"}
                    </span>
                  </p>
                </div>
              </div>

              {formError ? (
                <p className="mt-4 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">
                  {formError}
                </p>
              ) : null}

              <div className="mt-4 flex items-center gap-2">
                <Button type="submit" variant="primary" size="sm" disabled={submitting || form.name.trim().length === 0}>
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                  Create form
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={submitting}
                  onClick={() => {
                    setShowForm(false);
                    setFormError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>

            <FormPreview practiceName={practiceName} headline={form.headline} intro={form.intro} />
          </div>
        ) : null}

        {/* Just-created confirmation with the shareable URL. */}
        {createdUrl && !showForm ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/20 bg-success/10 px-3 py-2.5">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
                <Check size={15} /> Form created, share this link
              </p>
              <p className="mt-0.5 truncate text-xs text-ink">{createdUrl}</p>
            </div>
            <CopyLink url={createdUrl} />
          </div>
        ) : null}

        {/* Search (only meaningful once there are forms). */}
        {!loading && !loadError && forms.length > 0 ? (
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search forms by name or link"
              aria-label="Search forms"
              className="w-full rounded-lg border border-line bg-card-muted py-2 pl-9 pr-3 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30"
            />
          </div>
        ) : null}

        {/* List */}
        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading forms...
          </div>
        ) : forms.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="No forms yet"
            description="Create your first onboarding form to get a shareable link. Send it to patients, and every submission lands under Submissions."
          >
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              <Plus size={15} /> New form
            </Button>
          </EmptyState>
        ) : filtered.length === 0 ? (
          <p className="rounded-lg border border-line bg-card-muted/50 px-3 py-6 text-center text-sm text-muted">
            No forms match your search.
          </p>
        ) : (
          <div className={cn("grid gap-4", selected ? "lg:grid-cols-[minmax(0,1fr)_300px]" : "")}>
            <ul className="space-y-3">
              {filtered.map((f) => {
                const isSel = f.slug === selectedSlug;
                return (
                  <li
                    key={f.id}
                    className={cn(
                      "rounded-xl border bg-card px-4 py-3.5 shadow-[0_1px_2px_rgba(10,14,26,0.04)] transition-colors",
                      isSel ? "border-blue-dark/50 ring-1 ring-blue-dark/20" : "border-line",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      {/* Click the name/meta to open its preview at the side. */}
                      <button
                        type="button"
                        onClick={() => setSelectedSlug(isSel ? null : f.slug)}
                        aria-pressed={isSel}
                        aria-label={`Preview ${f.name}`}
                        className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <ChevronRight
                            size={14}
                            className={cn("shrink-0 text-muted transition-transform", isSel && "rotate-90 text-blue-dark")}
                          />
                          <span className="font-semibold text-navy">{f.name}</span>
                          <StatusPill tone={f.status === "active" ? "success" : "neutral"}>
                            {f.status === "active" ? "Active" : "Paused"}
                          </StatusPill>
                        </div>
                        <p className="mt-1 pl-5 text-xs text-muted">
                          <span className="font-semibold tabular-nums text-ink">{f.submissionCount}</span>{" "}
                          {f.submissionCount === 1 ? "submission" : "submissions"}
                          {f.headline ? (
                            <>
                              <span className="px-1.5 text-line-strong">/</span>
                              <span className="text-ink">{f.headline}</span>
                            </>
                          ) : null}
                        </p>
                      </button>

                      <Button variant="secondary" size="sm" onClick={() => toggleStatus(f)} disabled={togglingId !== null}>
                        {togglingId === f.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : f.status === "active" ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {f.status === "active" ? "Pause" : "Activate"}
                      </Button>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                      <span className={cn("truncate text-xs text-muted", "min-w-0 flex-1")}>{f.url}</span>
                      <CopyLink url={f.url} />
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card-muted"
                      >
                        <ExternalLink size={13} /> Open
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Side preview of the selected form: the questions a patient answers + details. */}
            {selected ? (
              <div className="lg:sticky lg:top-4 lg:self-start">
                <div className="mb-2 flex items-center justify-between">
                  <p className="truncate text-xs font-semibold text-navy">{selected.name}</p>
                  <button
                    type="button"
                    onClick={() => setSelectedSlug(null)}
                    aria-label="Close preview"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-card-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                  >
                    <X size={14} />
                  </button>
                </div>
                {previewLoading || !previewSteps ? (
                  <div className="flex items-center justify-center gap-2 rounded-[2rem] border border-line-strong bg-card py-16 text-sm text-muted">
                    <Loader2 size={16} className="animate-spin" />
                    Loading preview...
                  </div>
                ) : (
                  <OnboardingPreview practiceName={practiceName} steps={previewSteps} />
                )}
                <dl className="mt-3 space-y-1.5 rounded-xl border border-line bg-card-muted/40 p-3 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Questions</dt>
                    <dd className="text-right font-semibold tabular-nums text-ink">
                      {previewSteps ? Math.max(0, previewSteps.length - 1) : "..."}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Submissions</dt>
                    <dd className="text-right font-semibold tabular-nums text-ink">{selected.submissionCount}</dd>
                  </div>
                  {selected.intro ? (
                    <div className="border-t border-line pt-1.5">
                      <dt className="text-muted">Intro</dt>
                      <dd className="mt-0.5 text-ink">{selected.intro}</dd>
                    </div>
                  ) : null}
                  <div className="border-t border-line pt-1.5">
                    <dt className="text-muted">Link</dt>
                    <dd className="mt-0.5 flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ink">{selected.url}</span>
                      <CopyLink url={selected.url} />
                    </dd>
                  </div>
                </dl>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
