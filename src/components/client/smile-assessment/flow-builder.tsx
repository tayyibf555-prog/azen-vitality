import { useCallback, useId, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/primitives";
import { cn } from "@/lib/utils";
import {
  FLOW_LIMITS,
  nodeMap,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@/lib/smile-assessment/flow";
import { validateFlow, type FlowValidationFailure } from "@/lib/smile-assessment/flow-validate";
import { layoutFlow } from "@/lib/smile-assessment/flow-layout";
import {
  addEdge,
  defaultTargetOf,
  describeEdge,
  describeNode,
  insertQuestionOnEdge,
  insertableQuestions,
  removeEdge,
  removeNode,
  routableAnswers,
  setEdgeAnswer,
  setEdgeTarget,
  setEdgeTransition,
  setOutcomeHeadline,
  setQuestionTransition,
  setWelcomeCopy,
  uncoveredOptions,
  type FlowEditResult,
} from "@/lib/smile-assessment/flow-edit";
import { questionById } from "@/lib/smile-assessment/quiz";
import { FlowCanvas } from "./flow-canvas";

/**
 * THE FUNNEL BUILDER: the canvas, an inspector for whatever is selected, and the
 * save control.
 *
 * IT OWNS NO RULES. Every edit goes through flow-edit.ts and every judgement
 * through flow-validate.ts, both of which are pure .ts with tests beside them.
 * This file decides what is on screen and nothing else. When an edit is refused
 * it shows the refusal - a click that silently does nothing is the worst outcome
 * available here, because the owner walks away believing the funnel changed.
 *
 * A BROKEN FUNNEL CANNOT BE PUBLISHED, and the control says so rather than
 * failing at the server: the publish switch is unavailable until the banner is
 * empty, and the save button says "Save as draft" while it is not. The banner
 * lists EVERY failure at once (the validateFlow contract) rather than one at a
 * time, so fixing a funnel is not whack-a-mole.
 *
 * THE SERVER IS STILL THE GATE. Nothing here is a security or compliance check.
 * The authored transition lines and result headlines below are patient-facing
 * copy: this component only caps their length, and the PUT route is what runs
 * the compliance scan and the real validation before anything reaches a patient.
 */

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-[11px] font-semibold text-navy";

export interface FlowSaveOutcome {
  published: boolean;
  version: number | null;
}

export interface FlowBuilderProps {
  clientSlug: string;
  campaignSlug: string;
  campaignName: string;
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
  graph: initialGraph,
  unreadable,
  published: initialPublished,
  flowVersion,
  onSaved,
  onClose,
}: FlowBuilderProps) {
  const canvasId = useId().replace(/:/g, "");
  const [graph, setGraph] = useState<FlowGraph>(initialGraph);
  const [selected, setSelected] = useState<
    { kind: "node"; id: string } | { kind: "edge"; index: number } | null
  >(null);
  const [publish, setPublish] = useState(initialPublished);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverFailures, setServerFailures] = useState<string[]>([]);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  // The version this canvas was opened at. Sent with every save so a colleague
  // editing the same funnel in another tab loses the race LOUDLY (409) rather
  // than having their work silently overwritten by whoever saved last.
  const [version, setVersion] = useState<number | null>(
    typeof flowVersion === "number" ? flowVersion : null,
  );

  const validation = useMemo(() => validateFlow(graph), [graph]);
  const layout = useMemo(
    () => layoutFlow(graph, { content: describeNode, edgeLabel: describeEdge }),
    [graph],
  );
  const byId = useMemo(() => nodeMap(graph), [graph]);

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

  const selectedNode: FlowNode | null =
    selected?.kind === "node" ? (byId.get(selected.id) ?? null) : null;
  const selectedEdge: FlowEdge | null =
    selected?.kind === "edge" ? (graph.edges[selected.index] ?? null) : null;

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
      const res = await fetch(
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
    <div className="mt-3 rounded-xl border border-line-strong bg-card-muted/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-navy">Funnel for {campaignName}</p>
          <p className="mt-0.5 text-[11px] text-muted">
            Pick a step or a connection to change it. The public link only uses this funnel once it
            is switched on below; until then it runs the adaptive one.
          </p>
        </div>
        {onClose ? (
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={14} /> Close
          </Button>
        ) : null}
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

      <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <FlowCanvas
          idPrefix={canvasId}
          layout={layout}
          selectedNodeId={selected?.kind === "node" ? selected.id : null}
          selectedEdgeIndex={selected?.kind === "edge" ? selected.index : null}
          faultyNodeIds={faultyNodeIds}
          onSelectNode={(id) => {
            setRefusal(null);
            setSelected({ kind: "node", id });
          }}
          onSelectEdge={(index) => {
            setRefusal(null);
            setSelected({ kind: "edge", index });
          }}
        />

        <div className="rounded-xl border border-line bg-card p-3">
          {selectedNode ? (
            <NodeInspector
              graph={graph}
              node={selectedNode}
              apply={apply}
              onSelectNothing={() => setSelected(null)}
            />
          ) : selectedEdge && selected?.kind === "edge" ? (
            <EdgeInspector
              graph={graph}
              edge={selectedEdge}
              index={selected.index}
              apply={apply}
              onSelectNothing={() => setSelected(null)}
            />
          ) : (
            <p className="text-[12px] text-muted">
              Nothing selected. Choose a step to rename its lead-in or remove it, or a connection to
              add a question part-way through.
            </p>
          )}
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

// ---------------------------------------------------------------------------
// Inspectors.
// ---------------------------------------------------------------------------

function InspectorHead({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="border-b border-line pb-2">
      <p className="text-[9.5px] font-bold uppercase tracking-wide text-muted">{eyebrow}</p>
      <p className="mt-0.5 text-[12.5px] font-semibold text-navy">{title}</p>
    </div>
  );
}

function NodeInspector({
  graph,
  node,
  apply,
  onSelectNothing,
}: {
  graph: FlowGraph;
  node: FlowNode;
  apply: (result: FlowEditResult) => void;
  onSelectNothing: () => void;
}) {
  const card = describeNode(node);
  const uncovered = uncoveredOptions(graph, node.id);
  const target = defaultTargetOf(graph, node.id);

  return (
    <div className="space-y-3">
      <InspectorHead eyebrow={card.eyebrow} title={card.title} />

      {node.kind === "question" ? (
        <>
          <div>
            <label className={labelClass} htmlFor={`tr-${node.id}`}>
              Lead-in line (optional)
            </label>
            <input
              id={`tr-${node.id}`}
              type="text"
              defaultValue={node.transition ?? ""}
              maxLength={FLOW_LIMITS.transition}
              placeholder="That helps. Now, when you would like to get started."
              onBlur={(e) => apply(setQuestionTransition(graph, node.id, e.target.value))}
              className={inputClass}
            />
            <p className="mt-1 text-[10.5px] text-muted">
              Shown above this question. Leave it empty for no lead-in. A connection into this step
              can carry its own line, which wins over this one.
            </p>
          </div>

          {uncovered.length > 0 ? (
            <div>
              <p className={labelClass}>Answers that lead nowhere</p>
              <ul className="mt-1 space-y-1">
                {uncovered.map((o) => (
                  <li key={o.value} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{o.label}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      disabled={!target}
                      onClick={() => (target ? apply(addEdge(graph, node.id, target, o.value)) : undefined)}
                    >
                      <Plus size={12} /> Route it
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[10.5px] text-muted">
                Routing sends this answer the same way as the rest for now; pick the connection
                afterwards to send it somewhere else.
              </p>
            </div>
          ) : null}

          <div className="border-t border-line pt-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                apply(removeNode(graph, node.id));
                onSelectNothing();
              }}
            >
              <Trash2 size={13} /> Remove this question
            </Button>
            <p className="mt-1 text-[10.5px] text-muted">
              Anything that led here will lead to {target ? `“${target}”` : "wherever this step led"}{" "}
              instead.
            </p>
          </div>
        </>
      ) : null}

      {node.kind === "outcome" ? (
        <div>
          <label className={labelClass} htmlFor={`hl-${node.id}`}>
            Result headline (optional)
          </label>
          <input
            id={`hl-${node.id}`}
            type="text"
            defaultValue={node.headline ?? ""}
            maxLength={FLOW_LIMITS.headline}
            onBlur={(e) => apply(setOutcomeHeadline(graph, node.id, e.target.value))}
            className={inputClass}
          />
          <p className="mt-1 text-[10.5px] text-muted">
            About how ready the enquiry is, never about the treatment: a clinician decides what is
            suitable, always.
          </p>
        </div>
      ) : null}

      {node.kind === "welcome" ? (
        <>
          <div>
            <label className={labelClass} htmlFor={`wh-${node.id}`}>
              Opening headline (optional)
            </label>
            <input
              id={`wh-${node.id}`}
              type="text"
              defaultValue={node.headline ?? ""}
              maxLength={FLOW_LIMITS.headline}
              onBlur={(e) => apply(setWelcomeCopy(graph, node.id, e.target.value, node.intro ?? ""))}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`wi-${node.id}`}>
              Opening line (optional)
            </label>
            <textarea
              id={`wi-${node.id}`}
              rows={2}
              defaultValue={node.intro ?? ""}
              maxLength={FLOW_LIMITS.intro}
              onBlur={(e) => apply(setWelcomeCopy(graph, node.id, node.headline ?? "", e.target.value))}
              className={inputClass}
            />
            <p className="mt-1 text-[10.5px] text-muted">
              Leave both empty to use the assessment&apos;s own headline and intro.
            </p>
          </div>
        </>
      ) : null}

      {node.kind === "contact" ? (
        <p className="text-[11.5px] text-muted">
          Where the enquiry is captured. Every funnel has exactly one, and every result comes after
          it, so no one reaches an answer without leaving their details.
        </p>
      ) : null}
    </div>
  );
}

function EdgeInspector({
  graph,
  edge,
  index,
  apply,
  onSelectNothing,
}: {
  graph: FlowGraph;
  edge: FlowEdge;
  index: number;
  apply: (result: FlowEditResult) => void;
  onSelectNothing: () => void;
}) {
  const from = nodeMap(graph).get(edge.from);
  const label = from ? describeEdge(edge, from) : edge.answer;
  const answers = from ? routableAnswers(from) : [];
  const insertable = useMemo(() => insertableQuestions(graph, index), [graph, index]);
  const [pick, setPick] = useState("");

  return (
    <div className="space-y-3">
      <InspectorHead eyebrow="Connection" title={label ?? "Straight on"} />

      <div>
        <label className={labelClass} htmlFor={`ea-${index}`}>
          Taken when the answer is
        </label>
        <select
          id={`ea-${index}`}
          value={edge.answer ?? ""}
          onChange={(e) => apply(setEdgeAnswer(graph, index, e.target.value || null))}
          className={inputClass}
        >
          <option value="">Anything else</option>
          {answers.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className={labelClass} htmlFor={`et-${index}`}>
          Then go to
        </label>
        <select
          id={`et-${index}`}
          value={edge.to}
          onChange={(e) => apply(setEdgeTarget(graph, index, e.target.value))}
          className={inputClass}
        >
          {graph.nodes
            .filter((n) => n.id !== edge.from)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {describeNode(n).title}
              </option>
            ))}
        </select>
      </div>

      <div>
        <label className={labelClass} htmlFor={`etr-${index}`}>
          Lead-in for this answer (optional)
        </label>
        <input
          id={`etr-${index}`}
          type="text"
          defaultValue={edge.transition ?? ""}
          maxLength={FLOW_LIMITS.transition}
          placeholder="Thank you. A quick one about what you would like to change."
          onBlur={(e) => apply(setEdgeTransition(graph, index, e.target.value))}
          className={inputClass}
        />
        <p className="mt-1 text-[10.5px] text-muted">
          Shown on the next step, tailored to the answer just given.
        </p>
      </div>

      <div className="border-t border-line pt-2">
        <label className={labelClass} htmlFor={`ins-${index}`}>
          Add a question here
        </label>
        {insertable.length === 0 ? (
          <p className="mt-1 text-[10.5px] text-muted">
            Nothing left to add on this route: every remaining question is either already asked on
            it, is about a different treatment, or would make the funnel too long.
          </p>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <select
              id={`ins-${index}`}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className={cn(inputClass, "mt-0 flex-1")}
            >
              <option value="">Choose a question...</option>
              {insertable.map((id) => (
                <option key={id} value={id}>
                  {questionById(id)?.prompt ?? id}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              disabled={!pick}
              onClick={() => {
                apply(insertQuestionOnEdge(graph, index, pick));
                setPick("");
                onSelectNothing();
              }}
            >
              <Plus size={13} /> Add
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-line pt-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            apply(removeEdge(graph, index));
            onSelectNothing();
          }}
        >
          <Trash2 size={13} /> Remove this connection
        </Button>
      </div>
    </div>
  );
}
