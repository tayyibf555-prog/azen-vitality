"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useState,
  type CSSProperties,
} from "react";
import {
  Plus,
  Loader2,
  Copy,
  Check,
  ChevronLeft,
  ExternalLink,
  Megaphone,
  X,
  Pause,
  Play,
  GitBranch,
  AlertTriangle,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, StatusPill, EmptyState, Tabs, type TabItem } from "@/components/primitives";
import { GOAL_CATALOG, BUDGET_CATALOG, goalLabel } from "@/lib/smile-assessment/campaign";
import { DEFAULT_PALETTE_KEY, PALETTES, paletteFor, paletteVars } from "@/lib/assess/palette";
import { groupCampaignsByGoal } from "@/lib/smile-assessment/grouping";
import { nodeMap, normaliseFlow, type FlowGraph } from "@/lib/smile-assessment/flow";
import { phoneFlowLayout } from "@/lib/smile-assessment/flow-phone-layout";
import { screenFor, type PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import {
  SCRATCH_FLOW_KEY,
  flowTemplate,
  templateForGoal,
} from "@/lib/smile-assessment/flow-templates";
import {
  INITIAL_WIZARD,
  isDetailsOpen,
  isGalleryOpen,
  isListVisible,
  lockedGoal,
  wizardReducer,
  type TemplateChoice,
} from "@/lib/smile-assessment/wizard-state";
import { AssessmentLivePreview } from "./assessment-live-preview";
import { TemplateGallery } from "./template-gallery";
import { FlowBuilder } from "./flow-builder";
import { FlowPhoneCanvas } from "./flow-phone-canvas";

/**
 * THE ASSESSMENTS PANEL, and the staged create wizard inside it.
 *
 * THREE SCREENS, ONE AT A TIME (wizard-state.ts owns the transitions):
 *   1. Templates - a takeover of this section: search, categories, and a card per
 *      starter funnel showing the actual shape of the funnel it would give you.
 *   2. Details   - a short form ABOUT that choice. The goal is pre-filled and
 *      locked to the template's own goal, with a back-link to change template.
 *   3. The canvas - opened on the new campaign's card the moment it is created,
 *      seeded with the funnel that was chosen.
 *
 * THE CREATE PATH IS NOT FORKED. Stage 2 fires the same POST, with the same body,
 * to the same route as before; the funnel is a SECOND write afterwards, as a
 * draft. The seeded campaigns and the duplicate-slug 409 (campaign-repository.ts:88)
 * all depend on that one path, so the staging is presentation and nothing else.
 *
 * WHY A CHOICE IS NOW REQUIRED. There is no "skip" on stage 1, and that costs a
 * practice nothing: the funnel is saved UNPUBLISHED, so the public link keeps
 * running the adaptive funnel until the owner reads the canvas and switches it
 * on. Start From Scratch is the escape hatch for someone who wants to draw their
 * own, and it starts from the smallest funnel that is still legal rather than an
 * empty canvas.
 */

// One campaign as returned by the admin API (GET/POST). Mirrors the toAdminView
// shape on the server: the raw campaign plus labels, the public url/path and a
// response count. We keep it local so this file owns its own contract.
//
// The three funnel fields are OPTIONAL on purpose. They arrive from the campaign
// row once the flow columns exist; until then they are simply absent, every card
// reads "Adaptive", and that is not a degraded display - it is the truth, because
// a campaign with no authored funnel runs the adaptive one.
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
  flow?: unknown;
  flowVersion?: number;
  flowPublished?: boolean;
  /**
   * The chosen colour scheme: a key from PALETTES, or null for "exactly as it
   * shipped". OPTIONAL for the same reason the funnel fields above are — on a
   * deployment where 0079 has not been applied the column is not read back at
   * all, and an absent theme and a null theme must render the same page
   * (palette.ts, paletteFor).
   */
  theme?: string | null;
}

interface FormState {
  name: string;
  goal: string;
  targetBudget: string;
  idealCustomer: string;
  headline: string;
  intro: string;
  slug: string;
  /** A key from PALETTES (src/lib/assess/palette.ts). Never a colour. */
  theme: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  goal: GOAL_CATALOG[0]?.key ?? "general",
  targetBudget: "any",
  idealCustomer: "",
  headline: "",
  intro: "",
  slug: "",
  // Starts on the unchanged look, so an owner who never notices the picker gets
  // exactly what every assessment before this one got.
  theme: DEFAULT_PALETTE_KEY,
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

/** "Embed on your website" row: shows the one-line iframe snippet with a copy
 *  button. `noDivider` drops the top hairline when this is the only row in its
 *  <dl> (e.g. no ideal customer note precedes it). */
function EmbedRow({ url, noDivider }: { url: string; noDivider?: boolean }) {
  return (
    <div className={noDivider ? "" : "border-t border-line pt-1.5"}>
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

export function CampaignsPanel({
  clientSlug,
  practiceName,
}: {
  clientSlug: string;
  /** For the phone minis' branded header - the name the patient really sees. */
  practiceName?: string;
}) {
  const [campaigns, setCampaigns] = useState<AdminCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // WHICH SCREEN IS ON, and what carries between them. The transitions are a
  // pure, tested reducer (wizard-state.ts) rather than a handful of booleans, so
  // "details is unreachable without a choice" is a rule something holds.
  const [wizard, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [flowNote, setFlowNote] = useState<string | null>(null);

  // The campaign whose URL we just created, so we can surface it with a copy button.
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  // STAGE 3: the campaign whose canvas opens by itself, because it was just made.
  const [openCanvasFor, setOpenCanvasFor] = useState<string | null>(null);

  // Per-row "status change in flight" guard, keyed by campaign id.
  const [togglingId, setTogglingId] = useState<string | null>(null);

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
    dispatch({ type: "cancel" });
    setForm(EMPTY_FORM);
    setFormError(null);
    setCreatedUrl(null);
    setOpenCanvasFor(null);
    setFlowNote(null);
    void load();
  }, [load]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  /**
   * Stage 1 -> stage 2. The choice decides the goal, so the details screen opens
   * with it filled in; a template IS a goal, and leaving the field free would let
   * an Invisalign funnel be attached to a whitening assessment and ask the wrong
   * question on the very first screen.
   */
  function choose(choice: TemplateChoice) {
    setFormError(null);
    setForm((f) => ({ ...f, goal: choice.goal ?? f.goal }));
    dispatch({ type: "choose", choice });
  }

  /**
   * Attach the chosen funnel to a just-created campaign, as a DRAFT.
   *
   * The version it comes back at is carried into the card, because the builder
   * sends it as its concurrency check: keeping the row's pre-save version here
   * would make the very first edit of a brand-new funnel collide with itself.
   */
  async function saveDraftFlow(
    campaign: AdminCampaign,
    graph: FlowGraph,
  ): Promise<{ note: string | null; version: number | null }> {
    try {
      const res = await fetch(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}/flow?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, flow: graph, published: false }),
        },
      );
      if (res.status === 404 || res.status === 503) {
        return {
          note: "The assessment was created, but funnels cannot be stored on this deployment yet, so it runs the adaptive funnel for now.",
          version: null,
        };
      }
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        flowVersion?: number;
      };
      if (!res.ok || !data.ok) {
        return {
          note: `The assessment was created, but its funnel could not be saved${data.error ? `: ${data.error}` : "."} Open “Edit funnel” to try again.`,
          version: null,
        };
      }
      return {
        note: null,
        version: typeof data.flowVersion === "number" ? data.flowVersion : null,
      };
    } catch {
      return {
        note: "The assessment was created, but its funnel could not be saved. Open “Edit funnel” to try again.",
        version: null,
      };
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    const choice = wizard.choice;
    setSubmitting(true);
    setFormError(null);
    setFlowNote(null);
    try {
      // UNCHANGED CREATE CONTRACT. Same route, same body, same field names as
      // before the wizard existed.
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
          theme: form.theme,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; campaign?: AdminCampaign; error?: string };
      if (!res.ok || !data.ok || !data.campaign) {
        throw new Error(data.error || `Could not create the assessment (${res.status}).`);
      }
      const created = data.campaign;

      // The funnel is a SECOND write, after the campaign exists to hang it on.
      // It is saved unpublished, so creating an assessment can never change what
      // a patient sees until the owner has read the funnel and switched it on.
      let note: string | null = null;
      if (choice) {
        const saved = await saveDraftFlow(created, choice.graph);
        note = saved.note;
        if (!note) {
          created.flow = choice.graph;
          created.flowPublished = false;
          if (saved.version !== null) created.flowVersion = saved.version;
          note =
            "Its funnel is below, saved as a draft. Read it through and switch it on when you are happy.";
        }
      }

      setCampaigns((prev) => [created, ...prev]);
      setCreatedUrl(created.url);
      setFlowNote(note);
      setForm(EMPTY_FORM);
      // STAGE 3: straight onto the canvas, seeded with what was chosen.
      setOpenCanvasFor(created.id);
      dispatch({ type: "created" });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the assessment.");
    } finally {
      setSubmitting(false);
    }
  }

  const updateCampaign = useCallback((id: string, patch: Partial<AdminCampaign>) => {
    setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

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

  const gallery = isGalleryOpen(wizard);
  const details = isDetailsOpen(wizard);
  const creating = gallery || details;
  const locked = lockedGoal(wizard);

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
          variant={creating ? "secondary" : "primary"}
          size="sm"
          onClick={() => {
            setFormError(null);
            setCreatedUrl(null);
            setFlowNote(null);
            dispatch(creating ? { type: "cancel" } : { type: "open" });
          }}
        >
          {creating ? <X size={15} /> : <Plus size={15} />}
          {creating ? "Cancel" : "New assessment"}
        </Button>
      }
    >
      <div className="space-y-5">
        {/* STAGE 1. Takes the section over: one decision, one screen. */}
        {gallery ? (
          <TemplateGallery
            clientSlug={clientSlug}
            idealCustomer={form.idealCustomer}
            targetBudget={form.targetBudget}
            chosenKey={wizard.choice?.key ?? null}
            onChoose={choose}
            onClose={() => dispatch({ type: "cancel" })}
          />
        ) : null}

        {/* STAGE 2. Only reachable with a choice behind it, so the goal always
            has something to lock to. */}
        {details && wizard.choice ? (
          <DetailsStage
            clientSlug={clientSlug}
            practiceName={practiceName}
            choice={wizard.choice}
            lockedGoalKey={locked}
            form={form}
            set={set}
            slugPreview={slugPreview}
            submitting={submitting}
            formError={formError}
            onBack={() => dispatch({ type: "back" })}
            onCancel={() => {
              dispatch({ type: "cancel" });
              setFormError(null);
            }}
            onSubmit={submit}
          />
        ) : null}

        {/* Just-created confirmation with the public URL. */}
        {createdUrl && !creating ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/20 bg-success/10 px-3 py-2.5">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-success">
                <Check size={15} /> Assessment created
              </p>
              <p className="mt-0.5 truncate text-xs text-ink">{createdUrl}</p>
              {flowNote ? <p className="mt-1 text-xs text-ink">{flowNote}</p> : null}
            </div>
            <div className="flex items-center gap-2">
              <CopyLink url={createdUrl} />
              <CopyButton text={embedSnippet(createdUrl)} label="Copy embed code" />
            </div>
          </div>
        ) : null}

        {/* The list, hidden while a wizard screen is up: one screen at a time. */}
        {!isListVisible(wizard) ? null : loadError ? (
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
            <Button variant="primary" size="sm" onClick={() => dispatch({ type: "open" })}>
              <Plus size={15} /> New assessment
            </Button>
          </EmptyState>
        ) : (
          <CampaignTabs
            clientSlug={clientSlug}
            campaigns={campaigns}
            togglingId={togglingId}
            openCanvasFor={openCanvasFor}
            onToggleStatus={toggleStatus}
            onCampaignUpdated={updateCampaign}
          />
        )}
      </div>
    </SectionCard>
  );
}

/* ---------------------------------------------------------------------------
 * STAGE 2 - the details screen.
 * ------------------------------------------------------------------------- */

function DetailsStage({
  clientSlug,
  practiceName,
  choice,
  lockedGoalKey,
  form,
  set,
  slugPreview,
  submitting,
  formError,
  onBack,
  onCancel,
  onSubmit,
}: {
  clientSlug: string;
  practiceName?: string;
  choice: TemplateChoice;
  lockedGoalKey: string | null;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  slugPreview: string;
  submitting: boolean;
  formError: string | null;
  onBack: () => void;
  onCancel: () => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  // THE FUNNEL AS THE SCREENS A PATIENT SEES, not as cards about them. There is
  // one funnel here and one question about it ("is this the one I want
  // attached?"), and that question is answered by the words a patient reads -
  // the prompts, the answers they tap, the result they land on. An abstract card
  // can name a step; it cannot show it.
  //
  // THE SAME LAYOUT ENGINE, at another size. phoneFlowLayout IS layoutFlow, run
  // with phone metrics and no text (flow-phone-layout.ts), so the strip cannot
  // show a shape the builder's canvas contradicts. The EDIT canvas on stage 3
  // keeps its compact cards - that is the drawing you want while wiring, and
  // flow-canvas.tsx is untouched by this.
  //
  // READ-ONLY BY OMISSION, still: nothing in the strip is focusable and there is
  // no select callback, because the funnel has no campaign to be saved against
  // yet. Editing happens on stage 3, on a funnel that exists.
  const canvasId = useId().replace(/:/g, "");
  const layout = useMemo(() => phoneFlowLayout(choice.graph), [choice.graph]);
  // The hero line is LIVE. The headline and intro being typed below are shown
  // where a patient actually reads them - above the first question's prompt, on
  // screen one (deterministic-assessment-quiz.tsx:549-555) - rather than as a
  // standalone mockup of an opening screen the runtime does not have.
  const screens = useMemo(() => {
    const byId = nodeMap(choice.graph);
    const out = new Map<string, PhoneScreen>();
    for (const n of layout.nodes) {
      const node = byId.get(n.id);
      if (!node) continue;
      out.set(
        n.id,
        screenFor(node, choice.graph, { headline: form.headline, intro: form.intro }, n.step),
      );
    }
    return out;
  }, [choice.graph, layout, form.headline, form.intro]);
  const questions = choice.graph.nodes.filter((n) => n.kind === "question").length;

  return (
    <form onSubmit={onSubmit} className="rounded-2xl border border-line-strong bg-card p-4">
      {/* The choice, still on screen and still changeable. A back-link rather
          than a re-opened gallery inline: one screen at a time, both ways. */}
      <div className="rounded-xl border border-line bg-card-muted/50 p-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] font-semibold text-navy">{choiceLabel(choice)}</p>
            <p className="mt-0.5 text-[11px] text-muted">
              {questions} {questions === 1 ? "question" : "questions"}. Saved as a draft when you
              create this, so the public link keeps running the adaptive funnel until you switch
              it on.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11.5px]"
            onClick={onBack}
          >
            <ChevronLeft size={13} /> Change template
          </Button>
        </div>
        {/* THE SCHEME, ON THE CARD THAT NAMES THE TEMPLATE - not down among the
            details fields. It belongs to the choice, the way the template's name
            and its question count do, and it is the only control here whose
            effect is visible on this card: the strip immediately below repaints
            as it is picked. A divider rather than a second card, because it is
            the same decision continued, not a new one. */}
        <div className="mt-2.5 border-t border-line pt-2.5">
          <span className={labelClass}>Colour scheme</span>
          <ThemePicker value={form.theme} onChange={(key) => set("theme", key)} />
          <p className="mt-1.5 text-[11px] text-muted">
            Colour only — the questions, the wording and the layout are the same on every
            scheme. Pick the one that matches wherever the link is going.
          </p>
        </div>

        {/* The funnel itself, every screen readable: this is the confirmation
            that what was picked is what is about to be attached. Its own scroll
            box, capped, so a nine-step funnel never pushes the form it belongs to
            off the bottom of the screen.

            THE SCHEME IS WORN HERE. paletteVars re-declares the raw tokens on
            this wrapper, and because globals.css maps them with @theme inline,
            every `text-navy` and `bg-card` beneath it repaints - so the picker
            directly above re-themes the whole strip live, with no state and no
            prop threading (palette.ts:5-17). The cast is because paletteVars is
            React-free by design (palette.ts:340). */}
        <div className="mt-2" style={paletteVars(form.theme) as CSSProperties}>
          <FlowPhoneCanvas idPrefix={canvasId} layout={layout} screens={screens} practiceName={practiceName} />
        </div>
      </div>

      {choice.note ? (
        <p className={noteToneClass(choice.source)}>
          {choice.source === "ai" ? (
            <Sparkles size={13} className="mt-px shrink-0" />
          ) : (
            <AlertTriangle size={13} className="mt-px shrink-0" />
          )}
          <span>{choice.note}</span>
        </p>
      ) : null}

      <div className="mb-4 mt-4 border-b border-line pb-2.5">
        <h4 className="text-title text-navy">Details</h4>
        <p className="mt-0.5 text-caption font-normal text-muted">
          Where this link will live, and what a patient sees when they land on it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="ca-name" className={labelClass}>
            Name (where will this link be used?) <span className="text-danger">*</span>
          </label>
          <input
            id="ca-name"
            type="text"
            required
            autoFocus
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
          <span className={labelClass}>Goal</span>
          {lockedGoalKey ? (
            // LOCKED, because the funnel branches on it. The way to change it is
            // to change the template, which is what the back-link above is for.
            <div className="mt-1 flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm text-ink">
                {goalLabel(lockedGoalKey)}
              </span>
              <button
                type="button"
                onClick={onBack}
                className="shrink-0 text-[11.5px] font-semibold text-status-royal underline-offset-2 hover:underline"
              >
                Change template
              </button>
            </div>
          ) : (
            <select
              id="ca-goal"
              aria-label="Goal"
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
          )}
          <p className="mt-1 text-[11px] text-muted">
            {lockedGoalKey
              ? "Set by the template you picked, because its questions branch on it."
              : "A funnel built from scratch asks about any treatment, so pick whichever this link is for."}
          </p>
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

      <div className="mt-4 flex items-center gap-2 border-t border-line pt-4">
        <Button type="submit" variant="primary" size="sm" disabled={submitting || form.name.trim().length === 0}>
          {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Create assessment
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={submitting} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * One palette, as the three chips both controls below wear.
 *
 * EVERY COLOUR ON SCREEN HERE COMES OUT OF THE CATALOGUE MODULE. Not one hex
 * literal in this file, which is a rule the shell suite enforces
 * (create-experience-shell.test.ts:363) — and a rule with a point beyond tidiness:
 * a swatch hand-typed here would be a SECOND copy of the palette, free to drift
 * from the one the public page actually renders, so the owner would be choosing
 * from colours that are no longer the colours. `palette.swatch` is derived from
 * the same `vars` map the page wears (palette.ts, definePalette), so the chips
 * cannot be wrong.
 *
 * ONE COMPONENT FOR BOTH PICKERS, deliberately: the create picker and the
 * re-colour row on a card have to show the SAME scheme as the same three chips,
 * or an owner would be told a colour was one thing at creation and another
 * afterwards.
 */
function PaletteChips({ palette }: { palette: (typeof PALETTES)[number] }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center -space-x-1">
      {palette.swatch.map((colour, i) => (
        <span
          key={colour + String(i)}
          className="h-4 w-4 rounded-full border border-line-strong"
          style={{ background: colour }}
        />
      ))}
    </span>
  );
}

/**
 * The colour-scheme picker: one chip-stack per palette, each with its name.
 *
 * A radiogroup, not a row of toggles: exactly one scheme is in force, and arrow
 * keys should move between them.
 */
function ThemePicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Colour scheme" className="mt-1.5 flex flex-wrap gap-2">
      {PALETTES.map((palette) => {
        const selected = palette.key === value;
        return (
          <button
            key={palette.key}
            type="button"
            role="radio"
            aria-checked={selected}
            title={palette.description}
            onClick={() => onChange(palette.key)}
            className={[
              "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition",
              selected
                ? "border-blue-royal bg-tint-royal ring-2 ring-blue-royal/25"
                : "border-line bg-card hover:border-line-strong",
            ].join(" ")}
          >
            <PaletteChips palette={palette} />
            <span
              className={[
                "text-[11.5px] font-semibold",
                selected ? "text-status-royal" : "text-ink",
              ].join(" ")}
            >
              {palette.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * THE RE-COLOUR ROW: the same catalogue, on a campaign that already exists.
 *
 * WHY A SECOND CONTROL AND NOT THE PICKER ITSELF. ThemePicker names every scheme,
 * because at creation the owner is meeting them for the first time and a colour
 * with no name is not a choice. On a card, seven named buttons would be the
 * tallest thing on it — taller than the campaign's own header — for a decision
 * that is already made and is only occasionally revisited. So the labels come off
 * and the chips stay: the row is one line, the current scheme is named ONCE
 * beside it, and every button still carries its palette's name as its accessible
 * name and its description in the tooltip. Nothing is hidden, only unrepeated.
 *
 * SAME CATALOGUE, SAME CHIPS, SAME ORDER — PALETTES and PaletteChips, never a
 * local list. A hand-kept row here would be the third copy of the palette and the
 * first one free to be wrong.
 *
 * A radiogroup for the same reason as the picker: exactly one scheme is in force.
 */
function ThemeSwatchRow({
  campaignName,
  value,
  busy,
  onChange,
}: {
  /** Names the group, so a page of cards has one distinguishable control each. */
  campaignName: string;
  value: string;
  busy: boolean;
  onChange: (key: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={`Colour scheme for ${campaignName}`}
      className="flex flex-wrap items-center gap-1.5"
    >
      {PALETTES.map((palette) => {
        const selected = palette.key === value;
        return (
          <button
            key={palette.key}
            type="button"
            role="radio"
            aria-checked={selected}
            // The name the picker prints under the chips, carried as the
            // accessible name instead: a row of unlabelled swatches must still
            // read as "Clinical teal", not "button".
            aria-label={palette.label}
            title={`${palette.label} — ${palette.description}`}
            disabled={busy}
            onClick={() => onChange(palette.key)}
            className={[
              "rounded-lg border p-1 transition disabled:opacity-60",
              selected
                ? "border-blue-royal bg-tint-royal ring-2 ring-blue-royal/25"
                : "border-line bg-card hover:border-line-strong",
            ].join(" ")}
          >
            <PaletteChips palette={palette} />
          </button>
        );
      })}
    </div>
  );
}

/** The degradation banner's classes. Warning when something fell back, quiet
 *  blue when the writer succeeded - the tone has to match the news. */
function noteToneClass(source: TemplateChoice["source"]): string {
  return source === "ai"
    ? "mt-2.5 flex items-start gap-1.5 rounded-lg border border-blue-royal/20 bg-tint-royal px-3 py-2 text-[11.5px] text-status-royal"
    : "mt-2.5 flex items-start gap-1.5 rounded-lg border border-warning/25 bg-tint-amber px-3 py-2 text-[11.5px] text-status-amber";
}

/** What the owner picked, in words. */
function choiceLabel(choice: TemplateChoice): string {
  if (choice.key === SCRATCH_FLOW_KEY) return "Built from scratch";
  if (choice.source === "ai") return "Written for this goal";
  return flowTemplate(choice.key)?.label ?? "Starter funnel";
}

/* ---------------------------------------------------------------------------
 * Treatment tabs: one per goal, plus an "All" tab once there's more than one
 * goal represented (mirrors src/components/client/landing-pages/landing-pages
 * -view.tsx's groupRowsByTreatment tabs exactly, using the Smile Assessment
 * equivalent groupCampaignsByGoal). This lives here (inside CampaignsPanel, a
 * client component) rather than in the server SmileAssessmentView, because the
 * campaigns are fetched CLIENT-SIDE by this component — grouping them needs
 * that already-fetched state, so there is no RSC boundary to cross.
 * ------------------------------------------------------------------------- */

interface ListProps {
  clientSlug: string;
  campaigns: AdminCampaign[];
  togglingId: string | null;
  /** The campaign whose canvas opens on mount, because it was just created. */
  openCanvasFor: string | null;
  onToggleStatus: (c: AdminCampaign) => void;
  onCampaignUpdated: (id: string, patch: Partial<AdminCampaign>) => void;
}

function CampaignTabs({ campaigns, ...rest }: ListProps) {
  const groups = groupCampaignsByGoal(campaigns);
  const goalTabs: TabItem[] = groups.map((group) => ({
    key: group.key,
    label: group.label,
    badge: group.campaigns.length,
    content: <CampaignList campaigns={group.campaigns} {...rest} />,
  }));
  const tabs: TabItem[] =
    groups.length > 1
      ? [
          {
            key: "all",
            label: "All",
            badge: campaigns.length,
            content: <CampaignList campaigns={campaigns} {...rest} />,
          },
          ...goalTabs,
        ]
      : goalTabs;

  return <Tabs tabs={tabs} />;
}

function CampaignList({ campaigns, ...rest }: ListProps) {
  return (
    <ul className="space-y-3">
      {campaigns.map((c) => (
        <CampaignCard key={c.id} campaign={c} {...rest} />
      ))}
    </ul>
  );
}

/** One campaign: header + meta, its public URL, its colour scheme, an embedded
 *  live preview (Classic/Guided), the funnel builder, and any extra detail.
 *
 *  EXPORTED FOR THE SUITE. vitest renders this card for real
 *  (campaign-recolour.test.ts) to hold the one thing source-reading cannot show:
 *  that the re-colour row on a card is checked against THAT campaign's stored
 *  scheme. Nothing else imports it. */
export function CampaignCard({
  clientSlug,
  campaign,
  togglingId,
  openCanvasFor,
  onToggleStatus,
  onCampaignUpdated,
}: {
  clientSlug: string;
  campaign: AdminCampaign;
  togglingId: string | null;
  openCanvasFor: string | null;
  onToggleStatus: (c: AdminCampaign) => void;
  onCampaignUpdated: (id: string, patch: Partial<AdminCampaign>) => void;
}) {
  // STAGE 3. A campaign that was just created lands with its canvas already open,
  // seeded with the funnel that was chosen for it - the wizard's last step, not a
  // separate errand the owner has to remember to go on.
  const [editing, setEditing] = useState(openCanvasFor === campaign.id);

  // THE RE-COLOUR, in flight. The key being written (so the row can be locked
  // while it lands), and the reason if it did not.
  const [themeSaving, setThemeSaving] = useState<string | null>(null);
  const [themeError, setThemeError] = useState<string | null>(null);
  // Bumped after a successful re-colour so the live preview below re-fetches the
  // public page and shows the new scheme. Without it the one thing on the card
  // that renders the colours would keep rendering the old ones, and a change that
  // DID land would read as a change that did not.
  const [previewNonce, setPreviewNonce] = useState(0);

  // null is every campaign made before the picker existed, and every campaign on
  // a deployment where 0079 has not been applied. Both are the default scheme -
  // the same resolution paletteFor makes for the public page (palette.ts), so the
  // card cannot claim a colour the patient is not seeing.
  const currentTheme = campaign.theme ?? DEFAULT_PALETTE_KEY;

  /**
   * Re-colour an existing assessment: the SAME PATCH the pause/activate toggle
   * uses, on the same route, with the same optimistic-then-revert shape. Only the
   * field differs — `theme` alone, never restated alongside `status`, because the
   * route reads presence rather than truthiness and an absent status means "leave
   * it running" (campaign/[slug]/route.ts).
   *
   * The failure is SPOKEN, not swallowed. The toggle can revert in silence — a
   * pill that flips back says what happened — but a swatch that quietly un-picks
   * itself does not explain that 0079 has not been applied on this deployment,
   * which is the one failure this path actually has and the one the route
   * answers 503 with a sentence for.
   */
  async function recolour(key: string) {
    if (themeSaving || key === currentTheme) return;
    const previous = campaign.theme ?? null;
    setThemeSaving(key);
    setThemeError(null);
    // Optimistic: the card wears the new scheme at once, and is put back if the
    // write fails.
    onCampaignUpdated(campaign.id, { theme: key });
    try {
      const res = await fetch(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientSlug, theme: key }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `The colour scheme could not be saved (${res.status}).`);
      }
      setPreviewNonce((n) => n + 1);
    } catch (err) {
      onCampaignUpdated(campaign.id, { theme: previous });
      setThemeError(err instanceof Error ? err.message : "The colour scheme could not be saved.");
    } finally {
      setThemeSaving(null);
    }
  }

  // SHAPE ONLY, deliberately. normaliseFlow says "can this be read as a graph";
  // whether it is a LEGAL funnel is validateFlow's business, and the builder is
  // exactly where a legal-but-broken funnel needs to be opened and repaired. A
  // blob that cannot even be read is a different thing, and it is said out loud
  // rather than quietly replaced.
  const stored = useMemo(() => {
    const raw = campaign.flow;
    if (raw === undefined || raw === null) return { graph: null, unreadable: false };
    const graph = normaliseFlow(raw);
    return { graph, unreadable: !graph };
  }, [campaign.flow]);

  const published = campaign.flowPublished === true;
  const hasFunnel = stored.graph !== null || stored.unreadable;
  const funnelTone = published ? "success" : hasFunnel ? "info" : "neutral";
  const funnelLabel = published ? "Funnel live" : hasFunnel ? "Funnel draft" : "Adaptive";

  return (
    <li className="rounded-xl border border-line bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-navy">{campaign.name}</span>
            <StatusPill tone={campaign.status === "active" ? "success" : "neutral"}>
              {campaign.status === "active" ? "Active" : "Paused"}
            </StatusPill>
            <StatusPill tone={funnelTone}>{funnelLabel}</StatusPill>
          </div>
          <p className="mt-1 text-xs text-muted">
            <span className="text-ink">{campaign.goalLabel}</span>
            <span className="px-1.5 text-line-strong">/</span>
            <span className="text-ink">{campaign.budgetLabel}</span>
            <span className="px-1.5 text-line-strong">/</span>
            <span className="font-semibold tabular-nums text-ink">{campaign.responseCount}</span>{" "}
            {campaign.responseCount === 1 ? "response" : "responses"}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setEditing((e) => !e)}>
            {editing ? <X size={14} /> : <GitBranch size={14} />}
            {editing ? "Close funnel" : "Edit funnel"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onToggleStatus(campaign)}
            disabled={togglingId !== null}
          >
            {togglingId === campaign.id ? (
              <Loader2 size={14} className="animate-spin" />
            ) : campaign.status === "active" ? (
              <Pause size={14} />
            ) : (
              <Play size={14} />
            )}
            {campaign.status === "active" ? "Pause" : "Activate"}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{campaign.url}</span>
        <CopyLink url={campaign.url} />
        <a
          href={campaign.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-card px-2.5 py-1 text-xs font-semibold text-navy transition-colors hover:bg-card-muted"
        >
          <ExternalLink size={13} /> Open
        </a>
      </div>

      {/* THE RE-COLOUR ROW, directly above the preview it repaints - the same
          reason the create picker sits on the summary card above its strip
          (DetailsStage). This is the only control on the card whose effect is
          visible from the card, and putting it anywhere else would mean picking a
          colour with nothing on screen showing what the colour does.

          One line, under the link rather than up in the header: the header is
          what this assessment IS and whether it is running; the colour is how it
          looks, which belongs with the link and the preview of the page it
          paints. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3">
        <span className="text-xs font-semibold text-navy">Colour scheme</span>
        <ThemeSwatchRow
          campaignName={campaign.name}
          value={currentTheme}
          busy={themeSaving !== null}
          onChange={recolour}
        />
        {/* Named ONCE, since the row itself dropped the labels. Resolved through
            the catalogue, so a retired key reads as what the patient is actually
            being shown rather than as the key nobody chose. */}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          {themeSaving ? <Loader2 size={12} className="animate-spin" /> : null}
          {paletteFor(campaign.theme).label}
        </span>
      </div>

      {themeError ? (
        <p className="mt-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
          {themeError}
        </p>
      ) : null}

      {editing ? (
        <FlowBuilder
          clientSlug={clientSlug}
          campaignSlug={campaign.slug}
          campaignName={campaign.name}
          graph={stored.graph ?? templateForGoal(campaign.goal).build()}
          unreadable={stored.unreadable}
          published={published}
          flowVersion={typeof campaign.flowVersion === "number" ? campaign.flowVersion : null}
          onSaved={(outcome) =>
            onCampaignUpdated(campaign.id, {
              flowPublished: outcome.published,
              ...(outcome.version === null ? {} : { flowVersion: outcome.version }),
            })
          }
          onClose={() => setEditing(false)}
        />
      ) : null}

      {/* The Guided style is a runtime the authored funnel does not have in v1,
          so offering the switch on a flow-published campaign would preview a
          funnel that does not exist. */}
      <AssessmentLivePreview
        path={campaign.path}
        title={campaign.name}
        flowPublished={published}
        reloadKey={previewNonce}
      />

      <dl className="mt-3 space-y-1.5 rounded-xl border border-line bg-card-muted/40 p-3 text-xs">
        {campaign.idealCustomer ? (
          <div>
            <dt className="text-muted">Ideal customer</dt>
            <dd className="mt-0.5 text-ink">{campaign.idealCustomer}</dd>
          </div>
        ) : null}
        <EmbedRow url={campaign.url} noDivider={!campaign.idealCustomer} />
      </dl>
    </li>
  );
}
