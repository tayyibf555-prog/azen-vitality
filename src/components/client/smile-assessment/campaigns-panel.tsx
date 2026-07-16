"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2, Copy, Check, ExternalLink, Megaphone, X, Pause, Play, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { GOAL_CATALOG, BUDGET_CATALOG } from "@/lib/smile-assessment/campaign";
import { getClient } from "@/lib/mock/clients";
import { AssessmentPreview } from "@/components/assess/assessment-preview";

// One campaign as returned by the admin API (GET/POST). Mirrors the toAdminView
// shape on the server: the raw campaign plus labels, the public url/path and a
// response count. We keep it local so this file owns its own contract.
interface AdminCampaign {
  id: string;
  slug: string;
  name: string;
  goal: string;
  goalLabel: string;
  targetBudget: string;
  budgetLabel: string;
  headline: string | null;
  intro: string | null;
  idealCustomer: string | null;
  goalNote: string | null;
  status: "active" | "paused";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  url: string;
  path: string;
  responseCount: number;
}

interface FormState {
  name: string;
  goal: string;
  targetBudget: string;
  idealCustomer: string;
  headline: string;
  intro: string;
  slug: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  goal: GOAL_CATALOG[0]?.key ?? "general",
  targetBudget: "any",
  idealCustomer: "",
  headline: "",
  intro: "",
  slug: "",
};

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card-muted px-3 py-2 text-sm text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-xs font-semibold text-navy";

/** Copy-to-clipboard button with a transient "Copied" confirmation. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
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
      {copied ? "Copied" : label}
    </button>
  );
}

function CopyLink({ url }: { url: string }) {
  return <CopyButton text={url} label="Copy link" />;
}

/** The iframe snippet a web developer pastes into the practice's own website to
 *  embed this assessment where it stands. One line; the quiz page is public and
 *  designed to render inside a frame. */
function embedSnippet(url: string): string {
  return `<iframe src="${url}" style="width:100%;min-height:680px;border:0;border-radius:12px;" title="Smile Assessment" loading="lazy"></iframe>`;
}

/** "Embed on your website" row: shows the one-line iframe snippet with a copy button. */
function EmbedRow({ url }: { url: string }) {
  return (
    <div className="border-t border-line pt-1.5">
      <dt className="text-muted">Embed on your website</dt>
      <dd className="mt-1 space-y-1.5">
        <code className="block max-h-20 overflow-y-auto whitespace-pre-wrap break-all rounded-lg border border-line bg-card-muted px-2 py-1.5 text-[11px] leading-relaxed text-ink">
          {embedSnippet(url)}
        </code>
        <div className="flex items-center gap-2">
          <CopyButton text={embedSnippet(url)} label="Copy embed code" />
          <span className="text-[11px] text-muted">Paste into any page; the assessment appears right there.</span>
        </div>
      </dd>
    </div>
  );
}

export function CampaignsPanel({ clientSlug }: { clientSlug: string }) {
  const [campaigns, setCampaigns] = useState<AdminCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // The campaign whose URL we just created, so we can surface it with a copy button.
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);

  // Per-row "status change in flight" guard, keyed by campaign id.
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // The campaign whose preview is open at the side (click a row to toggle).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/smile-assessment/campaign?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; campaigns?: AdminCampaign[]; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `Could not load assessments (${res.status}).`);
      setCampaigns(data.campaigns ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load assessments.");
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  }, [clientSlug]);

  // Reset + refetch whenever the client changes.
  useEffect(() => {
    setShowForm(false);
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreatedUrl(null);
    setSelectedId(null);
    void load();
  }, [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch("/api/smile-assessment/campaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientSlug,
          name: form.name,
          goal: form.goal,
          targetBudget: form.targetBudget,
          idealCustomer: form.idealCustomer || undefined,
          headline: form.headline || undefined,
          intro: form.intro || undefined,
          slug: form.slug || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; campaign?: AdminCampaign; error?: string };
      if (!res.ok || !data.ok || !data.campaign) {
        throw new Error(data.error || `Could not create the assessment (${res.status}).`);
      }
      setCampaigns((prev) => [data.campaign as AdminCampaign, ...prev]);
      setCreatedUrl(data.campaign.url);
      setForm(EMPTY_FORM);
      setShowForm(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the assessment.");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(campaign: AdminCampaign) {
    if (togglingId) return;
    const next = campaign.status === "active" ? "paused" : "active";
    setTogglingId(campaign.id);
    // Optimistic flip; revert on failure.
    setCampaigns((prev) => prev.map((c) => (c.id === campaign.id ? { ...c, status: next } : c)));
    try {
      const res = await fetch(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, status: next }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || "status update failed");
    } catch {
      setCampaigns((prev) => prev.map((c) => (c.id === campaign.id ? { ...c, status: campaign.status } : c)));
    } finally {
      setTogglingId(null);
    }
  }

  const practiceName = getClient(clientSlug)?.name ?? "";
  const selected = campaigns.find((c) => c.id === selectedId) ?? null;

  const slugPreview = (form.slug || form.name)
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return (
    <SectionCard
      title="Assessments"
      description="Create a targeted assessment, then use its custom URL as the destination for an ad. Each one tunes the scoring and the AI follow-up to its goal."
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
          {showForm ? "Cancel" : "New assessment"}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* Create form, with a live preview of the public funnel's landing screen. */}
        {showForm ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <form onSubmit={submit} className="rounded-xl border border-line-strong bg-card-muted/40 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <label htmlFor="ca-name" className={labelClass}>
                  Name (where will this link be used?) <span className="text-danger">*</span>
                </label>
                <input
                  id="ca-name"
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="Website, Instagram bio, Google profile, Spring Invisalign ads..."
                  className={inputClass}
                />
                <p className="mt-1 text-[11px] text-muted">
                  This becomes the source label on every lead it brings in, so name it after the
                  place the link or embed will live.
                </p>
              </div>

              <div>
                <label htmlFor="ca-goal" className={labelClass}>
                  Goal
                </label>
                <select
                  id="ca-goal"
                  value={form.goal}
                  onChange={(e) => set("goal", e.target.value)}
                  className={inputClass}
                >
                  {GOAL_CATALOG.map((g) => (
                    <option key={g.key} value={g.key}>
                      {g.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="ca-budget" className={labelClass}>
                  Target budget
                </label>
                <select
                  id="ca-budget"
                  value={form.targetBudget}
                  onChange={(e) => set("targetBudget", e.target.value)}
                  className={inputClass}
                >
                  {BUDGET_CATALOG.map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="ca-ideal" className={labelClass}>
                  Ideal customer (internal, used to tailor the AI follow-up)
                </label>
                <textarea
                  id="ca-ideal"
                  rows={2}
                  value={form.idealCustomer}
                  onChange={(e) => set("idealCustomer", e.target.value)}
                  placeholder="Professionals in their 30s and 40s who want a straighter smile without braces."
                  className={inputClass}
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="ca-headline" className={labelClass}>
                  Public headline
                </label>
                <input
                  id="ca-headline"
                  type="text"
                  value={form.headline}
                  onChange={(e) => set("headline", e.target.value)}
                  placeholder="Is Invisalign right for you?"
                  className={inputClass}
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="ca-intro" className={labelClass}>
                  Public intro
                </label>
                <textarea
                  id="ca-intro"
                  rows={2}
                  value={form.intro}
                  onChange={(e) => set("intro", e.target.value)}
                  placeholder="Answer a few quick questions and we will tell you if you are a good fit."
                  className={inputClass}
                />
              </div>

              <div className="sm:col-span-2">
                <label htmlFor="ca-slug" className={labelClass}>
                  Custom URL (optional)
                </label>
                <input
                  id="ca-slug"
                  type="text"
                  value={form.slug}
                  onChange={(e) => set("slug", e.target.value)}
                  placeholder="spring-invisalign"
                  className={inputClass}
                />
                <p className="mt-1 text-xs text-muted">
                  Becomes <span className="font-semibold text-ink">/assess/{clientSlug}/{slugPreview || "your-slug"}</span>
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
                Create assessment
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

            <AssessmentPreview practiceName={practiceName} headline={form.headline} intro={form.intro} />
          </div>
        ) : null}

        {/* Just-created confirmation with the public URL. */}
        {createdUrl && !showForm ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/20 bg-success/10 px-3 py-2.5">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
                <Check size={15} /> Assessment created
              </p>
              <p className="mt-0.5 truncate text-xs text-ink">{createdUrl}</p>
            </div>
            <div className="flex items-center gap-2">
              <CopyLink url={createdUrl} />
              <CopyButton text={embedSnippet(createdUrl)} label="Copy embed code" />
            </div>
          </div>
        ) : null}

        {/* List */}
        {loadError ? (
          <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-sm text-danger">{loadError}</p>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" />
            Loading assessments...
          </div>
        ) : campaigns.length === 0 ? (
          <EmptyState
            icon={Megaphone}
            title="No assessments yet"
            description="Create your first assessment to get a custom public URL. Use that URL as the destination for an ad, and every submission lands here, scored to the goal you set."
          >
            <Button variant="primary" size="sm" onClick={() => setShowForm(true)}>
              <Plus size={15} /> New assessment
            </Button>
          </EmptyState>
        ) : (
          <div className={cn("grid gap-4", selected ? "lg:grid-cols-[minmax(0,1fr)_300px]" : "")}>
            <ul className="space-y-3">
              {campaigns.map((c) => {
                const isSel = c.id === selectedId;
                return (
                  <li
                    key={c.id}
                    className={cn(
                      "rounded-xl border bg-card px-4 py-3.5 transition-colors",
                      isSel ? "border-blue-dark/50 ring-1 ring-blue-dark/20" : "border-line",
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      {/* Click the name/meta to open its preview at the side. */}
                      <button
                        type="button"
                        onClick={() => setSelectedId(isSel ? null : c.id)}
                        aria-pressed={isSel}
                        aria-label={`Preview ${c.name}`}
                        className="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <ChevronRight
                            size={14}
                            className={cn("shrink-0 text-muted transition-transform", isSel && "rotate-90 text-blue-dark")}
                          />
                          <span className="font-semibold text-navy">{c.name}</span>
                          <StatusPill tone={c.status === "active" ? "success" : "neutral"}>
                            {c.status === "active" ? "Active" : "Paused"}
                          </StatusPill>
                        </div>
                        <p className="mt-1 pl-5 text-xs text-muted">
                          <span className="text-ink">{c.goalLabel}</span>
                          <span className="px-1.5 text-line-strong">/</span>
                          <span className="text-ink">{c.budgetLabel}</span>
                          <span className="px-1.5 text-line-strong">/</span>
                          <span className="font-semibold tabular-nums text-ink">{c.responseCount}</span>{" "}
                          {c.responseCount === 1 ? "response" : "responses"}
                        </p>
                      </button>

                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => toggleStatus(c)}
                        disabled={togglingId !== null}
                      >
                        {togglingId === c.id ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : c.status === "active" ? (
                          <Pause size={14} />
                        ) : (
                          <Play size={14} />
                        )}
                        {c.status === "active" ? "Pause" : "Activate"}
                      </Button>
                    </div>

                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
                      <span className={cn("truncate text-xs text-muted", "min-w-0 flex-1")}>{c.url}</span>
                      <CopyLink url={c.url} />
                      <a
                        href={c.url}
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

            {/* Side preview of the selected assessment: its landing screen + details. */}
            {selected ? (
              <div className="lg:sticky lg:top-4 lg:self-start">
                <div className="mb-2 flex items-center justify-between">
                  <p className="truncate text-xs font-semibold text-navy">{selected.name}</p>
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    aria-label="Close preview"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-card-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/40"
                  >
                    <X size={14} />
                  </button>
                </div>
                <AssessmentPreview
                  practiceName={practiceName}
                  headline={selected.headline ?? ""}
                  intro={selected.intro ?? ""}
                />
                <dl className="mt-3 space-y-1.5 rounded-xl border border-line bg-card-muted/40 p-3 text-xs">
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Goal</dt>
                    <dd className="text-right font-semibold text-ink">{selected.goalLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Budget</dt>
                    <dd className="text-right font-semibold text-ink">{selected.budgetLabel}</dd>
                  </div>
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Responses</dt>
                    <dd className="text-right font-semibold tabular-nums text-ink">{selected.responseCount}</dd>
                  </div>
                  {selected.idealCustomer ? (
                    <div className="border-t border-line pt-1.5">
                      <dt className="text-muted">Ideal customer</dt>
                      <dd className="mt-0.5 text-ink">{selected.idealCustomer}</dd>
                    </div>
                  ) : null}
                  <div className="border-t border-line pt-1.5">
                    <dt className="text-muted">Link</dt>
                    <dd className="mt-0.5 flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-ink">{selected.url}</span>
                      <CopyLink url={selected.url} />
                    </dd>
                  </div>
                  <EmbedRow url={selected.url} />
                </dl>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
