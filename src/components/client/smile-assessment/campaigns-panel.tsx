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
  MessageSquare,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SectionCard,
  StatusPill,
  EmptyState,
  Tabs,
  Toggle,
  type TabItem,
} from "@/components/primitives";
import { GOAL_CATALOG, BUDGET_CATALOG, goalLabel } from "@/lib/smile-assessment/campaign";
import {
  DEFAULT_PALETTE_KEY,
  PALETTES,
  paletteFor,
  paletteVars,
  paletteVarsFrom,
  type Palette,
} from "@/lib/assess/palette";
import { customPaletteFor, customThemePalette, type CustomTheme } from "@/lib/assess/custom-theme";
import {
  FOLLOW_UP_TOKENS,
  FOLLOW_UP_TRIGGERS,
  MAX_FOLLOW_UP_TEMPLATE,
  describeFollowUpTemplateFailures,
  followUpTriggerLabel,
  isFollowUpTrigger,
  validateFollowUpTemplate,
  type FollowUpTrigger,
} from "@/lib/smile-assessment/follow-up";
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
import { DropoffSection } from "./dropoff-section";
import { TemplateGallery } from "./template-gallery";
import { FlowBuilder } from "./flow-builder";
import { FlowPhoneCanvas } from "./flow-phone-canvas";
import { CustomThemePanel } from "./custom-theme-panel";

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
  /**
   * The follow-up settings (0082). OPTIONAL for the same reason `theme` and the
   * funnel fields are: on a deployment where the migration has not been applied
   * the columns are not read back at all, and an absent switch and a false switch
   * must produce the same card — which they do, because the disclosure below
   * reads all three through one `?? ` chain that spells out the OFF default.
   */
  followUpEnabled?: boolean;
  followUpTrigger?: string | null;
  followUpTemplate?: string | null;
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

  // THE PRACTICE'S OWN COLOUR SCHEMES (0081), held HERE and not inside each
  // picker. Two controls show them - the create picker and the row on every card -
  // and a fetch per control would mean a page of eight cards issuing eight
  // identical requests and, worse, drifting the moment one of them saved.
  //
  // A SEPARATE, NEVER-FAILING READ. It is deliberately not folded into `load`:
  // themes are a garnish on this screen and assessments are its subject, so a
  // themes read that failed must not be able to take the campaign list down with
  // it. On any failure the list stays empty, no "Your themes" group is drawn, and
  // the seven presets work exactly as they always have.
  const [customThemes, setCustomThemes] = useState<CustomTheme[]>([]);
  const [themesPending, setThemesPending] = useState(false);

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

  const loadThemes = useCallback(async () => {
    try {
      const res = await fetch(`/api/smile-assessment/theme?client=${encodeURIComponent(clientSlug)}`);
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        themes?: CustomTheme[];
        migrationPending?: boolean;
      };
      if (!res.ok || !data.ok) throw new Error("themes unavailable");
      setCustomThemes(data.themes ?? []);
      setThemesPending(data.migrationPending === true);
    } catch {
      // Silent, and that is the decision: a practice with no custom schemes and a
      // practice whose themes could not be read look the same on this screen (the
      // seven presets, no extra group), because in both cases there is nothing
      // extra to offer. An error banner about colours above the assessment list
      // would be louder than the fact deserves.
      setCustomThemes([]);
      setThemesPending(false);
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
    void loadThemes();
  }, [load, loadThemes]);

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
            practiceName={practiceName}
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
            customThemes={customThemes}
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

        {/* YOUR COLOUR SCHEMES (0081), on the list screen only - one screen at a
            time, the same rule the wizard follows. It sits above the assessments
            rather than inside a settings page because the only place these schemes
            are ever used is the two pickers on this screen, and a colour built out
            of sight of them is a colour built blind. */}
        {isListVisible(wizard) ? (
          <CustomThemePanel
            clientSlug={clientSlug}
            themes={customThemes}
            migrationPending={themesPending}
            onChanged={() => void loadThemes()}
          />
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
            practiceName={practiceName}
            customThemes={customThemes}
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
  customThemes,
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
  /** The practice's own colour schemes, for the picker's "Your themes" group. */
  customThemes: readonly CustomTheme[];
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
          <ThemePicker
            value={form.theme}
            customThemes={customThemes}
            onChange={(key) => set("theme", key)}
          />
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
        <div className="mt-2" style={themeVarsFor(form.theme, customThemes) as CSSProperties}>
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
/**
 * THE PRACTICE'S OWN SCHEMES, AS PALETTES (0081).
 *
 * `customThemePalette` is the SAME projection the public page's renderer uses, and
 * it derives its three chips with the SAME function `definePalette` uses for a
 * preset (palette.ts, swatchFromVars). So the "Your themes" group below is not a
 * second kind of control that happens to look similar — every button in both
 * groups is drawn from a `Palette`, and a custom scheme cannot show an owner three
 * colours the preset row above it would have derived differently.
 */
function customPalettes(themes: readonly CustomTheme[]): Palette[] {
  return themes.map(customThemePalette);
}

/**
 * The CSS custom properties for whatever a picker's value names — a preset key or
 * one of the practice's own schemes.
 *
 * The browser-side twin of what the public page does server-side (page.tsx: resolve
 * the custom theme, else paletteVars). Both fall back to the catalogue, and the
 * catalogue falls back to the shipped look, so a preview and the page it previews
 * cannot disagree about an unknown value.
 */
function themeVarsFor(key: string, themes: readonly CustomTheme[]): Record<string, string> {
  const custom = customPaletteFor(key, themes);
  return custom ? paletteVarsFrom(custom.vars) : paletteVars(key);
}

/**
 * WHICH BUTTON IS CHECKED for a stored value — resolved, not compared raw.
 *
 * The case this exists for: a campaign whose `theme` is `custom:<uuid>` for a
 * scheme that is no longer there. Deleting a theme in use is refused by the API,
 * so this is not supposed to happen — but a row restored from a backup or edited
 * by hand can produce it, and the public page has a defined answer for it
 * (resolveCustomTheme returns null, paletteVars falls through to the shipped
 * default). Comparing the raw string would leave the row with NOTHING checked
 * while the patient sees the default scheme: a control silently disagreeing with
 * the page it controls. Resolving it the same way the page does keeps "exactly one
 * scheme is in force" true, and true about the right one.
 */
function themeInForce(value: string, themes: readonly CustomTheme[]): string {
  return (customPaletteFor(value, themes) ?? paletteFor(value)).key;
}

function PaletteChips({ palette }: { palette: Palette }) {
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
function ThemePicker({
  value,
  customThemes = [],
  onChange,
}: {
  value: string;
  /** The practice's own schemes (0081). Absent/empty = presets only, as before. */
  customThemes?: readonly CustomTheme[];
  onChange: (key: string) => void;
}) {
  const mine = customPalettes(customThemes);
  const inForce = themeInForce(value, customThemes);
  const named = (palette: Palette) => (
    <ThemeRadio
      key={palette.key}
      palette={palette}
      selected={palette.key === inForce}
      onChange={onChange}
      labelled
    />
  );
  return (
    <>
      <div role="radiogroup" aria-label="Colour scheme" className="mt-1.5 flex flex-wrap gap-2">
        {PALETTES.map((palette) => named(palette))}
      </div>
      {/* AFTER THE PRESETS, NOT MIXED IN. The seven named schemes are the same on
          every practice's screen and are how an owner learns what a scheme even is;
          their own are a shorter, changing list that means something different
          ("the one we made"). One radiogroup each, so arrow keys stay inside the
          group a person is reading, and the heading says which is which. */}
      {mine.length > 0 ? (
        <>
          <span className="mt-2 block text-[11px] font-semibold text-muted">Your themes</span>
          <div role="radiogroup" aria-label="Your colour schemes" className="mt-1 flex flex-wrap gap-2">
            {mine.map((palette) => named(palette))}
          </div>
        </>
      ) : null}
    </>
  );
}

/**
 * One scheme as a radio. ONE COMPONENT FOR PRESETS AND CUSTOM SCHEMES ALIKE, for
 * the same reason PaletteChips is one component for both pickers: a custom theme
 * that rendered through a second control would be free to look, behave or announce
 * itself differently from the presets it sits beside.
 */
function ThemeRadio({
  palette,
  selected,
  labelled,
  busy,
  onChange,
}: {
  palette: Palette;
  selected: boolean;
  /** Print the scheme's name beside its chips (the create picker) or not (the card). */
  labelled?: boolean;
  busy?: boolean;
  onChange: (key: string) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      // On the unlabelled row the name is carried as the accessible name instead:
      // a row of bare swatches must still read as "Clinical teal", not "button".
      aria-label={labelled ? undefined : palette.label}
      title={labelled ? palette.description : `${palette.label} — ${palette.description}`}
      disabled={busy}
      onClick={() => onChange(palette.key)}
      className={[
        labelled
          ? "flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition"
          : "rounded-lg border p-1 transition disabled:opacity-60",
        selected
          ? "border-blue-royal bg-tint-royal ring-2 ring-blue-royal/25"
          : "border-line bg-card hover:border-line-strong",
      ].join(" ")}
    >
      <PaletteChips palette={palette} />
      {labelled ? (
        <span
          className={["text-[11.5px] font-semibold", selected ? "text-status-royal" : "text-ink"].join(" ")}
        >
          {palette.label}
        </span>
      ) : null}
    </button>
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
  customThemes = [],
  onChange,
}: {
  /** Names the group, so a page of cards has one distinguishable control each. */
  campaignName: string;
  value: string;
  busy: boolean;
  /** The practice's own schemes (0081). Absent/empty = presets only, as before. */
  customThemes?: readonly CustomTheme[];
  onChange: (key: string) => void;
}) {
  const mine = customPalettes(customThemes);
  const inForce = themeInForce(value, customThemes);
  const swatch = (palette: Palette) => (
    <ThemeRadio
      key={palette.key}
      palette={palette}
      selected={palette.key === inForce}
      busy={busy}
      onChange={onChange}
    />
  );
  return (
    <>
      <div
        role="radiogroup"
        aria-label={`Colour scheme for ${campaignName}`}
        className="flex flex-wrap items-center gap-1.5"
      >
        {PALETTES.map((palette) => swatch(palette))}
      </div>
      {/* THE PRACTICE'S OWN SCHEMES, in their own group after the presets - the
          same split the create picker makes, and for the same reason. Separated
          rather than appended so a row of fifteen identical swatches does not
          hide the line between "one of the seven" and "the one we made". */}
      {mine.length > 0 ? (
        <div
          role="radiogroup"
          aria-label={`Your colour schemes for ${campaignName}`}
          className="flex flex-wrap items-center gap-1.5 border-l border-line pl-2"
        >
          {mine.map((palette) => swatch(palette))}
        </div>
      ) : null}
    </>
  );
}

/**
 * THE FOLLOW-UP DISCLOSURE: who this assessment contacts, and in whose words.
 *
 * A DISCLOSURE AND NOT A ROW, which is the opposite call to the one the re-colour
 * control makes two lines above it, and the difference is the point. A colour is
 * one decision, already made, revisited by eye - so it is a single line of
 * swatches and nothing is hidden. This is three controls, one of them a paragraph
 * of patient-facing copy that has to be read before it is trusted, and it is
 * touched once and then left alone for months. Printed open on every card it would
 * be the tallest thing on the page for a setting almost nobody is currently
 * changing. So it collapses - but the SUMMARY LINE still says what is in force,
 * because "closed" must never mean "you cannot tell whether this is on".
 *
 * ONE SAVE FOR THE THREE, deliberately, where the re-colour writes on click. A
 * swatch is atomic; these are not. Switching the feature on while the box holds
 * wording that has not been cleared would either send the wording or ignore it,
 * and both are worse than a button. The PATCH still only carries the fields that
 * CHANGED (campaign/[slug]/route.ts reads presence, not truthiness), so saving a
 * trigger never restates a template and saving a template never restates a switch.
 *
 * THE SCAN RUNS AS THEY TYPE, and it is the SAME FUNCTION the server refuses with
 * (validateFollowUpTemplate, follow-up.ts) - not a friendlier browser-side
 * approximation of it. The server is still the decision; this only means an owner
 * finds out about a word while they are looking at it rather than after a save.
 */
function FollowUpDisclosure({
  clientSlug,
  campaign,
  onCampaignUpdated,
}: {
  clientSlug: string;
  campaign: AdminCampaign;
  onCampaignUpdated: (id: string, patch: Partial<AdminCampaign>) => void;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);

  // The stored state, resolved the same way the server resolves it: an absent
  // column, a null column and a false column are one thing, and an unrecognised
  // trigger falls back to the narrower one (follow-up.ts, followUpConfig).
  const storedEnabled = campaign.followUpEnabled === true;
  const storedTrigger: FollowUpTrigger = isFollowUpTrigger(campaign.followUpTrigger)
    ? campaign.followUpTrigger
    : "high";
  const storedTemplate = campaign.followUpTemplate ?? "";

  const [enabled, setEnabled] = useState(storedEnabled);
  const [trigger, setTrigger] = useState<FollowUpTrigger>(storedTrigger);
  const [template, setTemplate] = useState(storedTemplate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const typed = template.trim();
  // Empty is not a failure here, it is the DEFAULT: "let us write it". The
  // validator says "empty" because to IT an empty template is a request to store
  // nothing, which is a different question from the one this box is asking.
  const scan = useMemo(
    () => (template.trim() === "" ? null : validateFollowUpTemplate(template)),
    [template],
  );
  const problems = scan && !scan.ok ? describeFollowUpTemplateFailures(scan.failures) : null;

  const nextTemplate = typed === "" ? null : template;
  const templateChanged = (nextTemplate ?? "") !== storedTemplate;
  const dirty = enabled !== storedEnabled || trigger !== storedTrigger || templateChanged;

  async function save() {
    if (saving || !dirty) return;
    // ONLY WHAT CHANGED. Same conventions as the theme and status writes on this
    // card: the route reads presence off the body, so an omitted field means
    // "leave it alone" rather than "set it to this".
    const body: Record<string, unknown> = { clientSlug };
    if (enabled !== storedEnabled) body.followUpEnabled = enabled;
    if (trigger !== storedTrigger) body.followUpTrigger = trigger;
    if (templateChanged) body.followUpTemplate = nextTemplate;

    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `The follow-up could not be saved (${res.status}).`);
      }
      // NOT optimistic, unlike the re-colour. A colour that reverts is visible on
      // the card; a contact rule that reverted would leave an owner believing the
      // practice is texting people it is not. So the card only claims the new
      // state once the server has agreed to it.
      onCampaignUpdated(campaign.id, {
        followUpEnabled: enabled,
        followUpTrigger: trigger,
        followUpTemplate: nextTemplate,
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The follow-up could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  const summary = storedEnabled
    ? `${followUpTriggerLabel(storedTrigger)}${storedTemplate ? ", your wording" : ", we write it"}`
    : "Only a strong match, we write it";

  return (
    <div className="mt-3 border-t border-line pt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-left"
      >
        <MessageSquare size={13} className="text-muted" />
        <span className="text-xs font-semibold text-navy">Follow-up</span>
        <StatusPill tone={storedEnabled ? "success" : "neutral"}>
          {storedEnabled ? "Configured" : "Default"}
        </StatusPill>
        {/* WHAT IS IN FORCE, on the closed row. A disclosure that hides the state
            it controls is a disclosure an owner has to open to trust. */}
        <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>
        <span className="ml-auto text-muted">
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="mt-3 space-y-3 rounded-xl border border-line bg-card-muted/40 p-3">
          {/* THE SWITCH. Off is not "no follow-up" - it is the behaviour this
              assessment has always had, and the label says so, because an owner
              reading "Off" beside a live campaign would reasonably fear that
              nobody is being contacted at all.

              THE SHARED PRIMITIVE, not a fourth private copy. There were three
              hand-rolled switches in this codebase before Toggle was extracted and
              they had already drifted on size, colour and whether they announced
              themselves at all (primitives/toggle-usage.test.ts). A new one here
              would be the drift starting again. */}
          <div className="flex items-start gap-2.5">
            <Toggle
              checked={enabled}
              onChange={setEnabled}
              label="Use these follow-up settings for this assessment"
              busy={saving}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <span className="block text-xs font-semibold text-navy">
                Use these settings for this assessment
              </span>
              <span className="mt-0.5 block text-[11.5px] text-muted">
                Off is what every assessment does today: a strong match is contacted straight
                away, and we write the message.
              </span>
            </div>
          </div>

          <div>
            <label className={labelClass} htmlFor={`${panelId}-trigger`}>
              Contact
            </label>
            <select
              id={`${panelId}-trigger`}
              className={inputClass}
              value={trigger}
              disabled={saving || !enabled}
              onChange={(e) => setTrigger(e.target.value as FollowUpTrigger)}
            >
              {FOLLOW_UP_TRIGGERS.map((key) => (
                <option key={key} value={key}>
                  {followUpTriggerLabel(key)}
                </option>
              ))}
            </select>
            {/* Said plainly, because widening this spends money and reaches
                people. Everything it does NOT change is worth naming too. */}
            <p className="mt-1 text-[11px] text-muted">
              Whoever is contacted, the rules do not move: only someone who left a contact
              detail, has not opted out, and can be reached on that channel.
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor={`${panelId}-template`}>
              First message
            </label>
            <textarea
              id={`${panelId}-template`}
              rows={3}
              className={inputClass}
              value={template}
              disabled={saving || !enabled}
              maxLength={MAX_FOLLOW_UP_TEMPLATE}
              placeholder="Leave empty and we will write it for each person."
              onChange={(e) => setTemplate(e.target.value)}
            />
            <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted">
              <span>
                You can use {FOLLOW_UP_TOKENS.map((t) => `{${t}}`).join(" and ")}.
              </span>
              <span className="tabular-nums">
                {typed.length}/{MAX_FOLLOW_UP_TEMPLATE}
              </span>
            </div>
            {/* THE SCAN'S OWN WORDS, as they come out of the shared validator. Not
                paraphrased here: a second wording of the rule in a component is a
                second rule nobody maintains. */}
            {problems ? (
              <p className="mt-2 whitespace-pre-line rounded-lg border border-warning/25 bg-tint-amber px-3 py-2 text-[11.5px] text-status-amber">
                {problems}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={save}
              disabled={saving || !dirty || (enabled && problems !== null)}
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              Save follow-up
            </Button>
            {saved && !dirty ? <span className="text-[11.5px] text-muted">Saved</span> : null}
          </div>

          {error ? (
            <p className="whitespace-pre-line rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
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
  /** For the funnel builder's phone minis - the practice a patient reads. */
  practiceName?: string;
  /** The practice's own colour schemes, for each card's re-colour row. */
  customThemes?: readonly CustomTheme[];
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
  practiceName,
  customThemes = [],
  campaign,
  togglingId,
  openCanvasFor,
  onToggleStatus,
  onCampaignUpdated,
}: {
  clientSlug: string;
  practiceName?: string;
  /** Optional: a card with none of them is the pre-0081 card, exactly. */
  customThemes?: readonly CustomTheme[];
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
          customThemes={customThemes}
          onChange={recolour}
        />
        {/* Named ONCE, since the row itself dropped the labels. Resolved through
            the catalogue, so a retired key reads as what the patient is actually
            being shown rather than as the key nobody chose. */}
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          {themeSaving ? <Loader2 size={12} className="animate-spin" /> : null}
          {customPaletteFor(campaign.theme, customThemes)?.label ?? paletteFor(campaign.theme).label}
        </span>
      </div>

      {themeError ? (
        <p className="mt-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
          {themeError}
        </p>
      ) : null}

      {/* THE FOLLOW-UP, directly under the re-colour row. Both are settings ABOUT
          this assessment rather than the assessment itself, and they sit together,
          above the preview and the builder, for the same reason the link and the
          colour do: the header says what this assessment is, and everything below
          the first divider is how it behaves. Collapsed, so the card grows by one
          line rather than by a form. */}
      <FollowUpDisclosure
        clientSlug={clientSlug}
        campaign={campaign}
        onCampaignUpdated={onCampaignUpdated}
      />

      {editing ? (
        <FlowBuilder
          clientSlug={clientSlug}
          campaignSlug={campaign.slug}
          campaignName={campaign.name}
          // The practice's name and the campaign's own hero copy, so the minis in
          // the builder read as the page a patient lands on rather than as the
          // generic fallback.
          practiceName={practiceName}
          // The campaign's goal, so "Rewrite the words" briefs the writer on what
          // this funnel is FOR rather than asking it to guess from the questions.
          goal={campaign.goal}
          campaignHeadline={campaign.headline}
          campaignIntro={campaign.intro}
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

      {/* THE DROP-OFF CHART (A3), directly under the preview of the funnel it is
          about — the same argument as the re-colour row above: the number and the
          thing it describes belong on one screen.

          ONLY FOR A CAMPAIGN THAT HAS A DRAWN FUNNEL. Step views come from the
          deterministic runtime walking an authored graph; a campaign running the
          adaptive funnel emits none, and its chart would say "no one has reached a
          step yet" forever — a true sentence that reads as a broken feature. A
          funnel that exists but is unpublished still gets the section, because the
          rows it collected while it WAS published are still the answer to "did my
          funnel work". */}
      {hasFunnel ? (
        <DropoffSection
          clientSlug={clientSlug}
          campaignSlug={campaign.slug}
          flowVersion={campaign.flowVersion}
        />
      ) : null}

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
