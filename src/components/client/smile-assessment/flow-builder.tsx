import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Save, Wand2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/primitives";
import { cn } from "@/lib/utils";
import { nodeMap, type FlowGraph } from "@/lib/smile-assessment/flow";
import {
  normaliseAndValidateFlow,
  validateFlow,
  type FlowValidationFailure,
} from "@/lib/smile-assessment/flow-validate";
import { phoneFlowLayout } from "@/lib/smile-assessment/flow-phone-layout";
import { screenFor, type PhoneScreen } from "@/lib/smile-assessment/flow-phone-screen";
import { describeNode, type FlowEditResult } from "@/lib/smile-assessment/flow-edit";
import {
  applyInspectorEdit,
  selectionAfterEdit,
  stepAfter,
  type FlowSelection,
  type InspectorEdit,
} from "@/lib/smile-assessment/flow-inspect";
import {
  ASSIST_TARGET_MOVED,
  assistEditFor,
  assistFingerprint,
  assistTargetKey,
  canLandAssist,
  type AssistTarget,
} from "@/lib/smile-assessment/flow-assist";
import { FlowPhoneCanvas } from "./flow-phone-canvas";
import { FlowInspector } from "./flow-inspector";

/**
 * THE FUNNEL BUILDER: the funnel as the screens a patient sees, an inspector rail
 * for whatever is selected, and the save control.
 *
 * CLICK THE SCREEN, EDIT THE SCREEN (A1). The editing surface is the phone strip -
 * the same minis the wizard previews a template with, the same layout engine, now
 * selectable. Picking one opens its rail: what it asks, what it says, where each
 * answer goes and in what order, what follows it, and whether it is still here at
 * all. A + in the gutter after every screen adds the next one.
 *
 * THE ABSTRACT CARD CANVAS IS GONE FROM HERE, and this is the decision the A1
 * charter deferred until it could be proven rather than argued. What it offered
 * was: pick a step, pick a CONNECTION, and read the branch shape at a glance. The
 * first two are on the strip - a screen is a button, and every wire out of a step
 * is a row in that step's rail, which is a shorter path to a branch than hunting
 * for a 1.5px line. The third it did not have alone: the strip draws the SAME
 * routed wires from the same layout engine, so the shape is on both pictures.
 * Keeping it would have meant two drawings of one funnel, one of which nothing
 * could be done from that the other could not do better. The file stays in the
 * repo: the template gallery's thumbnails still draw its kind colours.
 *
 * WHAT WAS ACTUALLY MISSING was never the drawing - it was two operations with no
 * control anywhere: connecting a step that leads nowhere (the old empty branch
 * list pointed at the wiring view, which could not do it either), and putting back
 * a band route deleted out of the contact step. Both are now in the rail, which is
 * what made the retirement honest rather than merely tidy.
 *
 * IT OWNS NO RULES. Every edit goes through flow-inspect.ts (what a control means)
 * onto flow-edit.ts (what it does to the graph) and every judgement through
 * flow-validate.ts - all pure .ts with tests beside them. This file decides what
 * is on screen and nothing else. When an edit is refused it shows the refusal - a
 * click that silently does nothing is the worst outcome available here, because
 * the owner walks away believing the funnel changed.
 *
 * A BROKEN FUNNEL CANNOT BE PUBLISHED, and the control says so rather than
 * failing at the server: the publish switch is unavailable until the banner is
 * empty, and the save button says "Save as draft" while it is not. The banner
 * lists EVERY failure at once (the validateFlow contract) rather than one at a
 * time, so fixing a funnel is not whack-a-mole.
 *
 * THE SERVER IS STILL THE GATE. Nothing here is a security or compliance check.
 * The authored transition lines and result headlines are patient-facing copy:
 * this component only caps their length, and the PUT route is what runs the
 * compliance scan and the real validation before anything reaches a patient.
 *
 * IT DOES THE ASKING, TOO. "Write this for me" in the rail is an AssistTarget
 * coming up (`onAssist`); the round trip is made HERE because the rail may not
 * fetch, and the line that comes back goes straight back down the ordinary
 * `onEdit` intents - so an AI-written line is trimmed by the same ops, refused by
 * the same rules and scanned by the same save as one that was typed. Two things
 * that are easy to get wrong and are therefore not decided here: WHICH fields may
 * be written (flow-assist.ts refuses a testimonial's words whatever asks) and
 * whether the answer may still land at all (canLandAssist - the owner can pick
 * another screen while a line is being written, and a node-scoped intent lands on
 * whatever is selected NOW; they can also REORDER the blocks under it, which
 * leaves a different piece of copy at the same address, so the target is stamped
 * with assistFingerprint before it goes and checked against that on the way back).
 *
 * "REWRITE THE WORDS" IS THE SAME MOVE AT FUNNEL SCALE, and it is the one place
 * this file sets the whole graph at once. It may, because what comes back is not
 * an edit: it is a WHOLE FUNNEL that the server has already held to the compliance
 * scan and to sameFlowStructure - the same shape in, the same shape out, different
 * words - and it is re-validated here with the same pure gate the runtime uses
 * before it is allowed on the canvas. What it must not do is land on a funnel that
 * has moved: the owner can keep editing while the words are being written, so the
 * graph that was sent is compared against the graph that is here when the answer
 * arrives, and a mismatch is reported rather than overwritten. Losing a minute of
 * typing to a button labelled "rewrite the words" is exactly the kind of silent
 * loss this builder is built not to have.
 */

export interface FlowSaveOutcome {
  published: boolean;
  version: number | null;
}

/**
 * THE ONE REQUEST THIS BUILDER MAKES, whatever it is asking for.
 *
 * Three call sites now leave this file - the save (a PUT that stores the funnel),
 * the per-line copy assist and the whole-funnel rewrite (two POSTs that store
 * nothing) - and they go through one function on purpose, so "the draft graph
 * leaves here by exactly one road" stays a fact about the file rather than a
 * habit. flow-inspector.test.ts counts it.
 */
async function callFlowApi(url: string, init: RequestInit): Promise<Response> {
  return await fetch(url, init);
}

export interface FlowBuilderProps {
  clientSlug: string;
  campaignSlug: string;
  campaignName: string;
  /**
   * The campaign's goal key. Briefs the rewriter on what this funnel is FOR;
   * without one the control is not offered at all, because a rewrite with no idea
   * what the campaign wants is a rewrite worth refusing rather than guessing at.
   */
  goal?: string;
  /**
   * The PRACTICE's name, for the minis' branded header. Never the campaign's own
   * name, which is an internal source label ("Instagram bio").
   */
  practiceName?: string;
  /** The campaign's public hero copy, which the first screen reads when the
   *  welcome step does not override it. */
  campaignHeadline?: string | null;
  campaignIntro?: string | null;
  /** The graph to open with. */
  graph: FlowGraph;
  /** True when the stored flow could not be read and this is a starter instead. */
  unreadable?: boolean;
  published: boolean;
  /** The version this graph was read at, for the save's concurrency check. */
  flowVersion?: number | null;
  onSaved?: (outcome: FlowSaveOutcome) => void;
  onClose?: () => void;
}

export function FlowBuilder({
  clientSlug,
  campaignSlug,
  campaignName,
  goal,
  practiceName,
  campaignHeadline,
  campaignIntro,
  graph: initialGraph,
  unreadable,
  published: initialPublished,
  flowVersion,
  onSaved,
  onClose,
}: FlowBuilderProps) {
  const canvasId = useId().replace(/:/g, "");
  const [graph, setGraph] = useState<FlowGraph>(initialGraph);
  const [selected, setSelected] = useState<FlowSelection | null>(null);
  const [publish, setPublish] = useState(initialPublished);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverFailures, setServerFailures] = useState<string[]>([]);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // The key of the copy box whose line is being written right now, or null. One at
  // a time, and the rail flattens every other button while it runs.
  const [assisting, setAssisting] = useState<string | null>(null);
  // True while the whole funnel's words are being rewritten. Its own flag rather
  // than a shared "busy": a per-field ask and a whole-funnel rewrite disable
  // different things, and one spinner for both would flatten the rail for a
  // request that has nothing to do with it.
  const [rewriting, setRewriting] = useState(false);
  // The version this canvas was opened at. Sent with every save so a colleague
  // editing the same funnel in another tab loses the race LOUDLY (409) rather
  // than having their work silently overwritten by whoever saved last.
  const [version, setVersion] = useState<number | null>(
    typeof flowVersion === "number" ? flowVersion : null,
  );

  const validation = useMemo(() => validateFlow(graph), [graph]);
  const byId = useMemo(() => nodeMap(graph), [graph]);

  // THE SAME GRAPH AT PHONE METRICS. phoneFlowLayout IS layoutFlow with a phone's
  // numbers and no text (flow-phone-layout.ts), so the strip and the card canvas
  // below it cannot draw two different funnels.
  const phone = useMemo(() => phoneFlowLayout(graph), [graph]);
  const screens = useMemo(() => {
    const out = new Map<string, PhoneScreen>();
    for (const n of phone.nodes) {
      const node = byId.get(n.id);
      if (!node) continue;
      out.set(
        n.id,
        screenFor(node, graph, { headline: campaignHeadline, intro: campaignIntro }, n.step),
      );
    }
    return out;
  }, [phone, byId, graph, campaignHeadline, campaignIntro]);

  // The minis' accessible names, as finished strings: naming a step means reading
  // the question bank, and the strip may not (flow-phone-canvas.tsx). The +
  // between two screens is named the same way, off the same card, so the control
  // and the screen it follows cannot come to say different things.
  const { selectLabels, addLabels } = useMemo(() => {
    const select = new Map<string, string>();
    const add = new Map<string, string>();
    for (const n of graph.nodes) {
      const card = describeNode(n);
      select.set(n.id, `${card.eyebrow}: ${card.title}`);
      add.set(n.id, `Add a screen after “${card.title}”`);
    }
    return { selectLabels: select, addLabels: add };
  }, [graph]);

  // A failure's `where` is a node id when it names one; everything else ("flow",
  // an edge description) has no card to mark, which is what the banner is for.
  const faultyNodeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const f of validation.failures) if (byId.has(f.where)) ids.add(f.where);
    return ids;
  }, [validation, byId]);

  /** Apply an edit, or surface why it was refused. Never both, never neither. */
  const apply = useCallback((result: FlowEditResult) => {
    if (result.ok) {
      setGraph(result.graph);
      setRefusal(null);
      setSavedNote(null);
      setServerFailures([]);
    } else {
      setRefusal(result.reason);
    }
  }, []);

  /**
   * ONE LINE FROM A CONTROL TO THE DRAFT GRAPH. The rail emits what the owner
   * meant; flow-inspect.ts turns that into a pure edit result against the graph as
   * it stands; `apply` commits it or says why not. Nothing in between.
   *
   * THE SELECTION MOVES ONLY WHEN THE EDIT LANDED. A refused edit leaves it
   * exactly where it was, because clearing it here would clear the refusal with
   * it - and a destructive button that silently does nothing is the one outcome
   * this builder must never have.
   */
  const onEdit = useCallback(
    (edit: InspectorEdit) => {
      const result = applyInspectorEdit(graph, selected, edit);
      apply(result);
      // Against the graph the edit was computed on, never the result: that is what
      // lets an insertion be answered with the step it just made.
      if (result.ok) setSelected((current) => selectionAfterEdit(current, edit, graph));
    },
    [apply, graph, selected],
  );

  const select = useCallback((next: FlowSelection | null) => {
    setRefusal(null);
    setSelected(next);
  }, []);

  /**
   * THE FUNNEL AS IT IS WHEN THE LINE ARRIVES, not as it was when the button was
   * pressed.
   *
   * `onEdit` is rebuilt every render against the current graph and the current
   * selection, so the copy captured by an async closure a second ago is a closure
   * over a STALE funnel: landing through it would silently discard whatever the
   * owner typed while they were waiting, and a node-scoped intent would land the
   * line on whichever screen is selected now. So the latest is what lands it, and
   * canLandAssist re-checks the target against both first - and against the
   * fingerprint stamped at press time, which is the part neither the graph nor the
   * selection can answer: a block that swapped places is still a block of that
   * description on that screen.
   */
  const live = useRef({ onEdit, selected, graph });
  // In an effect rather than during render, because a ref written while rendering
  // is a render with a side effect in it (and the lint that says so is right).
  useEffect(() => {
    live.current = { onEdit, selected, graph };
  }, [onEdit, selected, graph]);

  /**
   * ASK FOR ONE LINE. The rail said which box; this makes the round trip and hands
   * the answer back to the ordinary edit path.
   *
   * ONE AT A TIME, and nothing is a spinner-only failure: every road out of here
   * either lands a line or says, in words, why nothing changed. A silent no-op on
   * an AI button is the version of this feature an owner stops trusting.
   */
  const onAssist = useCallback(
    async (raw: AssistTarget) => {
      if (assisting !== null) return;
      // THE BOX AS IT IS RIGHT NOW, stamped onto the target before anything is
      // sent. An index is an ADDRESS, not an identity: reorder the blocks on this
      // screen, or delete an faq item above the one being written, and the same
      // address holds different words - so the answer has to be checked against
      // what it was written FOR, not against whatever still fits. null means the
      // box is already gone, which is the same answer arriving late.
      const at = assistFingerprint(live.current.graph, raw);
      if (at === null) {
        setRefusal(ASSIST_TARGET_MOVED);
        return;
      }
      const target: AssistTarget = { ...raw, at };
      setAssisting(assistTargetKey(target));
      setRefusal(null);
      setSavedNote(null);
      try {
        const res = await callFlowApi(
          `/api/smile-assessment/flow-copy-assist?client=${encodeURIComponent(clientSlug)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ clientSlug, flow: live.current.graph, target, practiceName }),
          },
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          text?: string | null;
          message?: string | null;
          error?: string;
        };
        const text = typeof data.text === "string" && data.text.trim() !== "" ? data.text : null;
        if (!res.ok || !data.ok || text === null) {
          setRefusal(
            data.message ||
              data.error ||
              "That line could not be written just now, so nothing was changed. Type it yourself, or try again in a moment.",
          );
          return;
        }
        const edit = assistEditFor(target, text);
        if (!edit || !canLandAssist(live.current.graph, live.current.selected, target)) {
          setRefusal(ASSIST_TARGET_MOVED);
          return;
        }
        live.current.onEdit(edit);
      } catch {
        setRefusal(
          "The writer could not be reached, so nothing was changed. Your funnel is exactly as it was.",
        );
      } finally {
        setAssisting(null);
      }
    },
    [assisting, clientSlug, practiceName],
  );

  /**
   * REWRITE THE WHOLE FUNNEL'S WORDS. The one control here that replaces the graph
   * rather than editing it, and the three things that make that safe:
   *
   *   THE SERVER KEPT THE SHAPE. `mode: "rewrite"` reads copy out of the reply and
   *   lays it onto the funnel that was sent, then refuses anything whose structure
   *   moved (sameFlowStructure). A rewrite cannot add, remove or reroute a step.
   *
   *   NOTHING UNVALIDATED REACHES THE CANVAS. The reply goes through the same pure
   *   gate the public runtime uses, exactly as the gallery does with a fresh draft.
   *
   *   THE FUNNEL MUST NOT HAVE MOVED. The owner can keep typing while this runs, so
   *   what was sent is compared with what is here now; if they differ, the words are
   *   dropped and said so. Overwriting is not an option: the reply was written for a
   *   funnel that no longer exists.
   *
   * `source: "unchanged"` is the server saying it could not improve on what is
   * there. It is a REPORT, not a failure, and it is worded that way.
   */
  const rewrite = useCallback(async () => {
    if (!goal || rewriting || saving) return;
    const sent = graph;
    setRewriting(true);
    setRefusal(null);
    setSavedNote(null);
    setServerFailures([]);
    try {
      const res = await callFlowApi("/api/smile-assessment/flow-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientSlug, goal, mode: "rewrite", flow: sent, practiceName }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        flow?: unknown;
        source?: string;
        error?: string;
      };
      if (!res.ok || !data.ok || !data.flow) {
        setRefusal(
          data.error ||
            "The words could not be rewritten just now, so nothing was changed. Your funnel is exactly as it was.",
        );
        return;
      }
      if (data.source === "unchanged") {
        setRefusal(
          "The writer could not improve on what is there, so nothing was changed. Your funnel is exactly as it was.",
        );
        return;
      }
      const { graph: next } = normaliseAndValidateFlow(data.flow);
      if (!next) {
        setRefusal(
          "The rewritten funnel did not pass its checks, so nothing was changed. Your funnel is exactly as it was.",
        );
        return;
      }
      if (JSON.stringify(live.current.graph) !== JSON.stringify(sent)) {
        setRefusal(
          "You changed the funnel while the words were being written, so they were not applied. Nothing was lost: ask again when you are happy with the shape.",
        );
        return;
      }
      setGraph(next);
      setSavedNote("The words were rewritten. Read them through, then save.");
    } catch {
      setRefusal(
        "The writer could not be reached, so nothing was changed. Your funnel is exactly as it was.",
      );
    } finally {
      setRewriting(false);
    }
  }, [clientSlug, goal, graph, practiceName, rewriting, saving]);

  // Publishing a funnel that does not validate is the one thing that must be
  // impossible from here, so the switch is not merely disabled - the value is
  // forced off while the graph is broken.
  const canPublish = validation.ok;
  const publishing = canPublish && publish;

  async function save() {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    setServerFailures([]);
    setSavedNote(null);
    try {
      const res = await callFlowApi(
        `/api/smile-assessment/campaign/${encodeURIComponent(campaignSlug)}/flow?client=${encodeURIComponent(clientSlug)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientSlug,
            flow: graph,
            published: publishing,
            ...(version === null ? {} : { expectedVersion: version }),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        failures?: { message?: string }[];
        // FlowCopyHit (flow-copy.ts): where + category + the matched phrase.
        copyHits?: { where?: string; category?: string; matched?: string }[];
        storedVersion?: number;
        flowVersion?: number;
        flowPublished?: boolean;
      };

      if (!res.ok || !data.ok) {
        if (Array.isArray(data.failures) && data.failures.length > 0) {
          setServerFailures(data.failures.map((f) => f.message ?? "").filter(Boolean));
        }
        // Wording a patient must not see. Named, so the owner can find and fix
        // the exact line rather than guessing which field was rejected.
        if (Array.isArray(data.copyHits) && data.copyHits.length > 0) {
          setServerFailures(
            data.copyHits.map((h) =>
              [h.where, h.matched ? `“${h.matched}” cannot go in front of a patient` : h.category]
                .filter(Boolean)
                .join(": "),
            ),
          );
        }
        if (res.status === 409) {
          // Someone else saved in the meantime. Do NOT clear the canvas: the
          // owner's work is still on screen and they can copy it across.
          throw new Error(
            "Someone else saved this funnel while you were editing. Close and reopen it to pick up their version; your changes are still on screen until you do.",
          );
        }
        if (res.status === 404) {
          throw new Error(
            "Saving funnels is not available on this deployment yet. Your changes are still on screen; nothing has been lost.",
          );
        }
        if (res.status === 503) {
          throw new Error(
            data.error ||
              "Funnels cannot be stored on this deployment yet. Your changes are still on screen; nothing has been lost.",
          );
        }
        throw new Error(data.error || `The funnel could not be saved (${res.status}).`);
      }

      const outcome: FlowSaveOutcome = {
        published: data.flowPublished ?? publishing,
        version: typeof data.flowVersion === "number" ? data.flowVersion : null,
      };
      setPublish(outcome.published);
      setVersion(outcome.version);
      setSavedNote(
        outcome.published
          ? "Saved and live on the public link."
          : "Saved as a draft. The public link still runs the adaptive funnel.",
      );
      onSaved?.(outcome);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "The funnel could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    // ESCAPE DESELECTS, from anywhere in the builder - the strip, the wiring view
    // or a field in the rail. On the container rather than on `document`, so a
    // builder open inside some future dialog cannot swallow that dialog's own
    // Escape; and stopped only when there WAS a selection to clear, for the same
    // reason.
    <div
      className="mt-3 rounded-xl border border-line-strong bg-card-muted/40 p-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || selected === null) return;
        event.stopPropagation();
        select(null);
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-navy">Funnel for {campaignName}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Pick a screen to change what it asks, what it says and where each answer goes. The
            public link only uses this funnel once it is switched on below; until then it runs the
            adaptive one.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* WORDS ONLY, AND THE LABEL SAYS SO. The shape of the funnel is the
              owner's; this asks for better wording on the funnel they drew, and
              the server refuses anything that came back a different shape. Not
              offered without a goal, because the writer would be guessing. */}
          {goal ? (
            <Button variant="ghost" size="sm" onClick={rewrite} disabled={rewriting || saving}>
              {rewriting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {rewriting ? "Rewriting" : "Rewrite the words"}
            </Button>
          ) : null}
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X size={14} /> Close
            </Button>
          ) : null}
        </div>
      </div>

      {unreadable ? (
        <Banner tone="warning">
          The saved funnel could not be read, so this is the starter for this goal instead. The
          public link is running the adaptive funnel in the meantime. Saving replaces the unreadable
          version.
        </Banner>
      ) : null}

      <ValidationBanner failures={validation.failures} />

      {refusal ? <Banner tone="warning">{refusal}</Banner> : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-3">
          {/* THE EDITING SURFACE. Left/right arrows walk the strip in reading
              order - and the handler is on the strip's own wrapper, not on the
              builder, so an arrow key inside a field in the rail still moves the
              cursor rather than the selection. */}
          <div
            onKeyDown={(event) => {
              const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (delta === 0) return;
              event.preventDefault();
              const next = stepAfter(
                phone.nodes.map((n) => n.id),
                selected?.kind === "node" ? selected.id : null,
                delta,
              );
              if (next) select({ kind: "node", id: next });
            }}
          >
            <FlowPhoneCanvas
              idPrefix={`${canvasId}-p`}
              layout={phone}
              screens={screens}
              practiceName={practiceName}
              selectedId={selected?.kind === "node" ? selected.id : null}
              onSelect={(id) => select({ kind: "node", id })}
              onAddAfter={(id) => onEdit({ kind: "add-screen", nodeId: id })}
              faultyNodeIds={faultyNodeIds}
              selectLabels={selectLabels}
              addLabels={addLabels}
              // The strip inherits the room the wiring view gave back. Its own
              // default is the short window a PREVIEW wants; the editing surface
              // wants most of the screen, the way the card canvas did.
              viewportClassName="max-h-[70vh]"
            />
          </div>
        </div>

        {/* The rail. Sticky, because the strip beside it is taller than the
            viewport on any funnel with three result screens, and an inspector you
            have to scroll back up to is an inspector you stop using. */}
        <div className="lg:sticky lg:top-3 lg:self-start">
          <FlowInspector
            graph={graph}
            selection={selected}
            failures={validation.failures}
            // For a trust strip's first line. The PRACTICE's name, the same one
            // the minis wear - never the campaign's, which is an internal source
            // label ("Instagram bio") and would read as a stranger to a patient.
            practiceName={practiceName}
            onEdit={onEdit}
            onSelect={select}
            onAssist={onAssist}
            assisting={assisting}
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <Toggle
          checked={publishing}
          onChange={setPublish}
          disabled={!canPublish || saving}
          label="Use this funnel on the public link"
          tone="success"
        />
        <span className="text-[12px] text-ink">
          {canPublish
            ? "Use this funnel on the public link"
            : "Fix the points above before this funnel can go live"}
        </span>
        <div className="ms-auto flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {publishing ? "Save and use it" : "Save as draft"}
          </Button>
        </div>
      </div>

      {savedNote ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12px] font-semibold text-success">
          <Check size={14} /> {savedNote}
        </p>
      ) : null}
      {saveError ? <Banner tone="danger">{saveError}</Banner> : null}
      {serverFailures.length > 0 ? (
        <ul className="mt-1 space-y-0.5 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
          {serverFailures.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Banner({ tone, children }: { tone: "warning" | "danger"; children: React.ReactNode }) {
  return (
    <p
      className={cn(
        "mt-2 flex items-start gap-1.5 rounded-lg px-3 py-2 text-[12px]",
        tone === "danger"
          ? "border border-danger/20 bg-danger/10 text-danger"
          : "border border-warning/25 bg-tint-amber text-status-amber",
      )}
    >
      <AlertTriangle size={14} className="mt-px shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** EVERY failure, always, never the first one. That is the validateFlow contract. */
function ValidationBanner({ failures }: { failures: FlowValidationFailure[] }) {
  if (failures.length === 0) {
    return (
      <p className="mt-2 flex items-center gap-1.5 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-[12px] font-semibold text-success">
        <Check size={14} /> This funnel is ready to go live.
      </p>
    );
  }
  return (
    <div className="mt-2 rounded-lg border border-danger/20 bg-danger/10 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[12px] font-semibold text-danger">
        <AlertTriangle size={14} />
        {failures.length === 1
          ? "One thing to fix before this can go live"
          : `${failures.length} things to fix before this can go live`}
      </p>
      <ul className="mt-1 space-y-0.5 text-[11.5px] text-danger">
        {failures.map((f, i) => (
          <li key={`${f.rule}-${f.code}-${f.where}-${i}`}>
            <span className="font-semibold">{f.where}</span>
            <span className="px-1">·</span>
            {f.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
