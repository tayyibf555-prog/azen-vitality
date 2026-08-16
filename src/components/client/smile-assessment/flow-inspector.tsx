import { useMemo, useState } from "react";
import { ArrowDown, ArrowRight, ArrowUp, Link2, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FLOW_LIMITS, nodeMap, type FlowGraph, type FlowNode } from "@/lib/smile-assessment/flow";
import type { FlowValidationFailure } from "@/lib/smile-assessment/flow-validate";
import {
  connectableTargets,
  describeEdge,
  describeNode,
  insertableQuestions,
  insertableQuestionsAfter,
  outgoingEdges,
  routableAnswers,
  routedAnswers,
  swappableQuestions,
  uncoveredAnswers,
} from "@/lib/smile-assessment/flow-edit";
import {
  edgeIssues,
  issuesFor,
  nodeIssues,
  type FieldIssue,
  type FlowSelection,
  type InspectorEdit,
  type InspectorField,
} from "@/lib/smile-assessment/flow-inspect";
import { questionById } from "@/lib/smile-assessment/quiz";

/**
 * THE INSPECTOR RAIL: everything about the one step (or the one connection) the
 * owner is standing on, beside the funnel it belongs to.
 *
 * IT IS A KEYBOARD AND A SET OF LABELS. Not one rule lives in here. Every control
 * emits an INTENT - `onEdit({ kind: "headline", text })` - and flow-inspect.ts
 * decides what that does to the graph; every list it draws is read off flow-edit.ts
 * (which questions may be asked here, which answers lead nowhere, where each wire
 * goes); every failure it prints beside a field was placed there by nodeIssues.
 * vitest collects no .tsx, so a rule written here is a rule nothing can hold - and
 * "typing an intro clears the headline" is precisely the kind of rule that gets
 * written here and noticed six weeks later.
 *
 * WHY THE RAIL AND NOT A DIALOG. Perspective's editor keeps the funnel on screen
 * while you edit a screen of it, because the question an owner is answering is
 * never "what should this headline say" on its own - it is "what should this
 * headline say GIVEN what the screen before it asked". A modal covers the answer.
 *
 * IT IS NOW THE WHOLE EDITOR, which is what let the abstract card canvas come down
 * (flow-builder.tsx). Everything a funnel is made of is here: what a screen asks
 * and says, where each answer goes, in what order, what follows the screen, and
 * whether it is still there. Two of those controls exist because retiring the
 * other canvas made the gap impossible to ignore, and both were holes rather than
 * duplicates - a step with NO route out could not be connected from anywhere (the
 * empty branch list used to point at the canvas, which could not do it either),
 * and a band route deleted off the contact step could not be put back at all.
 *
 * WHAT IS DELIBERATELY NOT HERE YET: content blocks (A2's builder UI is the next
 * stitch) and anything that writes to the server. The rail edits a DRAFT graph in
 * the builder's state; the builder is what saves it, through the one PUT route
 * with its compliance scan, validation and version bump.
 */

const inputClass =
  "mt-1 w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark/30";
const labelClass = "block text-[11px] font-semibold text-navy";
const helpClass = "mt-1 text-[10.5px] text-muted";

export interface FlowInspectorProps {
  /** The draft graph, as it stands right now. */
  graph: FlowGraph;
  selection: FlowSelection | null;
  /** Every failure validateFlow reported on this draft, in its own order. */
  failures: readonly FlowValidationFailure[];
  /** One control's intent. The builder applies it through applyInspectorEdit. */
  onEdit: (edit: InspectorEdit) => void;
  /** Move the selection: a branch row opens its connection, a delete clears it. */
  onSelect: (selection: FlowSelection | null) => void;
}

export function FlowInspector({ graph, selection, failures, onEdit, onSelect }: FlowInspectorProps) {
  const node: FlowNode | null =
    selection?.kind === "node" ? (nodeMap(graph).get(selection.id) ?? null) : null;
  const edge = selection?.kind === "edge" ? (graph.edges[selection.index] ?? null) : null;

  return (
    <div className="rounded-xl border border-line bg-card p-3">
      {node ? (
        <NodeInspector
          key={node.id}
          graph={graph}
          node={node}
          failures={failures}
          onEdit={onEdit}
          onSelect={onSelect}
        />
      ) : edge && selection?.kind === "edge" ? (
        <EdgeInspector
          key={selection.index}
          graph={graph}
          index={selection.index}
          failures={failures}
          onEdit={onEdit}
          onSelect={onSelect}
        />
      ) : (
        <p className="text-[12px] text-muted">
          Nothing selected. Choose a screen to change what it asks, what it says and where each
          answer goes.
        </p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * The furniture.
 * ------------------------------------------------------------------------- */

function InspectorHead({
  eyebrow,
  title,
  onClose,
}: {
  eyebrow: string;
  title: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between gap-2 border-b border-line pb-2">
      <div className="min-w-0">
        <p className="text-[9.5px] font-bold uppercase tracking-wide text-muted">{eyebrow}</p>
        <p className="mt-0.5 text-[12.5px] font-semibold text-navy">{title}</p>
      </div>
      {/* Escape does the same thing. The button is for the owner who does not know
          that, and for the one on a touch screen who has no Escape key. */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close the inspector"
        className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-card-muted hover:text-navy"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * The failures that belong to ONE control, printed under it.
 *
 * The banner above the canvas still lists every failure at once (the validateFlow
 * contract, and the only rendering that can show the ones naming no step). This is
 * the same message a second time, where the fix is - which is the difference
 * between "3 things to fix" and knowing which box to type in.
 */
function IssueList({ issues, field }: { issues: readonly FieldIssue[]; field: InspectorField }) {
  const mine = issuesFor(issues, field);
  if (mine.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {mine.map((i, at) => (
        <li key={`${i.rule}-${i.code}-${at}`} className="text-[10.5px] leading-snug text-danger">
          {i.message}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------------------
 * A step.
 * ------------------------------------------------------------------------- */

function NodeInspector({
  graph,
  node,
  failures,
  onEdit,
  onSelect,
}: {
  graph: FlowGraph;
  node: FlowNode;
  failures: readonly FlowValidationFailure[];
  onEdit: (edit: InspectorEdit) => void;
  onSelect: (selection: FlowSelection | null) => void;
}) {
  const card = describeNode(node);
  const issues = nodeIssues(graph, failures, node.id);
  const branches = outgoingEdges(graph, node.id);
  // A result step is terminal (rule 7), so it has no branch list to draw - unless
  // it wrongly has wires, in which case the list is where they get removed.
  const showBranches = node.kind !== "outcome" || branches.length > 0;

  return (
    <div className="space-y-3">
      <InspectorHead eyebrow={card.eyebrow} title={card.title} onClose={() => onSelect(null)} />
      <IssueList issues={issues} field="step" />

      {node.kind === "question" ? (
        <QuestionFields graph={graph} node={node} issues={issues} onEdit={onEdit} />
      ) : null}

      {node.kind === "welcome" ? (
        <WelcomeFields node={node} issues={issues} onEdit={onEdit} />
      ) : null}

      {node.kind === "outcome" ? <OutcomeFields node={node} issues={issues} onEdit={onEdit} /> : null}

      {node.kind === "contact" ? (
        <p className="text-[11.5px] text-muted">
          Where the enquiry is captured. Every funnel has exactly one, and every result comes after
          it, so no one reaches an answer without leaving their details. The three routes below are
          decided by the score, not by the patient.
        </p>
      ) : null}

      {showBranches ? (
        <Branches
          graph={graph}
          node={node}
          issues={issues}
          onEdit={onEdit}
          onSelect={onSelect}
        />
      ) : null}

      <AddScreenAfter graph={graph} node={node} onEdit={onEdit} />

      {node.kind === "question" ? (
        <div className="border-t border-line pt-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEdit({ kind: "remove-node" })}
          >
            <Trash2 size={13} /> Remove this question
          </Button>
          <p className={helpClass}>
            Anything that led here will lead where this step led instead, so no route is left
            dangling.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * ADD A SCREEN AFTER THIS ONE, with the picker the + on the strip does not have
 * room for.
 *
 * WHY BOTH. The + is one click and lands you on the new screen; this is the same
 * operation with a choice in front of it, and it is the ONLY one of the two that
 * exists on a phone-width window, where the strip is a stacked list with no
 * gutters. Both fire the same intent, so the rules - which wire it splices into,
 * which questions may be asked here - are settled once, in planScreenInsertion.
 *
 * IT IS ABSENT, NOT DISABLED, on a step with nothing to add: a terminal result
 * step has no wire to splice into and never will, so a control there would be
 * furniture. Where an insertion is merely impossible FOR NOW (every question
 * already asked on this route) the list is empty and it says so in words.
 */
function AddScreenAfter({
  graph,
  node,
  onEdit,
}: {
  graph: FlowGraph;
  node: FlowNode;
  onEdit: (edit: InspectorEdit) => void;
}) {
  const choices = useMemo(() => insertableQuestionsAfter(graph, node.id), [graph, node.id]);
  const [pick, setPick] = useState("");
  // A dead end has no wire to add a screen to. Rule 7 makes that permanent on a
  // result step; anywhere else the branch list above is where it gets connected.
  if (outgoingEdges(graph, node.id).length === 0) return null;

  return (
    <div className="border-t border-line pt-2">
      <label className={labelClass} htmlFor={`add-${node.id}`}>
        Add a screen after this one
      </label>
      {choices.length === 0 ? (
        <p className={helpClass}>
          Nothing left to add here: every remaining question is either already asked on this route,
          is about a different treatment, or would make the funnel too long.
        </p>
      ) : (
        <>
          <div className="mt-1 flex items-center gap-2">
            <select
              id={`add-${node.id}`}
              value={pick}
              onChange={(e) => setPick(e.target.value)}
              className={cn(inputClass, "mt-0 flex-1")}
            >
              <option value="">Choose a question...</option>
              {choices.map((id) => (
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
                onEdit({ kind: "add-screen", nodeId: node.id, questionId: pick });
                setPick("");
              }}
            >
              <Plus size={13} /> Add
            </Button>
          </div>
          <p className={helpClass}>
            It goes on the route this step falls back to, and everything it led to still follows.
            The + between the screens does the same thing in one click.
          </p>
        </>
      )}
    </div>
  );
}

/**
 * THE ASK ITSELF: which bank question this screen puts in front of a patient.
 *
 * The list is swappableQuestions, which asks the VALIDATOR rather than deciding
 * for itself - so a question that would be asked twice on one path, or asked of
 * the wrong treatment, is simply not offered. On a step whose answers are routed
 * one by one the swap is refused outright (flow-edit.ts, setNodeQuestion), so the
 * picker says so instead of listing one option and looking broken.
 */
function QuestionFields({
  graph,
  node,
  issues,
  onEdit,
}: {
  graph: FlowGraph;
  node: Extract<FlowNode, { kind: "question" }>;
  issues: readonly FieldIssue[];
  onEdit: (edit: InspectorEdit) => void;
}) {
  const choices = useMemo(() => swappableQuestions(graph, node.id), [graph, node.id]);
  const locked = routedAnswers(graph, node.id).length > 0;
  const known = choices.includes(node.questionId);

  return (
    <>
      <div>
        <label className={labelClass} htmlFor={`q-${node.id}`}>
          The question on this screen
        </label>
        <select
          id={`q-${node.id}`}
          value={node.questionId}
          disabled={locked}
          onChange={(e) => onEdit({ kind: "question", questionId: e.target.value })}
          className={cn(inputClass, "disabled:opacity-60")}
        >
          {/* A question that has left the bank is a rule-2 failure. It is not on
              the swap list (nothing may move TO it), so it is named here or the
              picker would show somebody else's question as this step's own. */}
          {known ? null : (
            <option value={node.questionId}>Not in the question bank: “{node.questionId}”</option>
          )}
          {choices.map((id) => (
            <option key={id} value={id}>
              {questionById(id)?.prompt ?? id}
            </option>
          ))}
        </select>
        <IssueList issues={issues} field="question" />
        <p className={helpClass}>
          {locked
            ? "This step sends some answers their own way, and those routes belong to the question it asks now. Point them the same way below, then the question can change."
            : "Only questions the funnel can still ask here are offered: nothing already asked on this route, and nothing about a different treatment."}
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor={`tr-${node.id}`}>
          Lead-in line (optional)
        </label>
        <input
          key={`tr-${node.id}`}
          id={`tr-${node.id}`}
          type="text"
          defaultValue={node.transition ?? ""}
          maxLength={FLOW_LIMITS.transition}
          placeholder="That helps. Now, when you would like to get started."
          onBlur={(e) => onEdit({ kind: "transition", text: e.target.value })}
          className={inputClass}
        />
        <IssueList issues={issues} field="transition" />
        <p className={helpClass}>
          Shown above this question. Leave it empty for no lead-in. A connection into this step can
          carry its own line, which wins over this one.
        </p>
      </div>
    </>
  );
}

function WelcomeFields({
  node,
  issues,
  onEdit,
}: {
  node: Extract<FlowNode, { kind: "welcome" }>;
  issues: readonly FieldIssue[];
  onEdit: (edit: InspectorEdit) => void;
}) {
  return (
    <>
      <div>
        <label className={labelClass} htmlFor={`wh-${node.id}`}>
          Opening headline (optional)
        </label>
        <input
          key={`wh-${node.id}`}
          id={`wh-${node.id}`}
          type="text"
          defaultValue={node.headline ?? ""}
          maxLength={FLOW_LIMITS.headline}
          onBlur={(e) => onEdit({ kind: "headline", text: e.target.value })}
          className={inputClass}
        />
        <IssueList issues={issues} field="headline" />
      </div>
      <div>
        <label className={labelClass} htmlFor={`wi-${node.id}`}>
          Opening line (optional)
        </label>
        <textarea
          key={`wi-${node.id}`}
          id={`wi-${node.id}`}
          rows={2}
          defaultValue={node.intro ?? ""}
          maxLength={FLOW_LIMITS.intro}
          onBlur={(e) => onEdit({ kind: "intro", text: e.target.value })}
          className={inputClass}
        />
        <IssueList issues={issues} field="intro" />
        <p className={helpClass}>
          Leave both empty to use the assessment&apos;s own headline and intro. They are read above
          the first question, which is where the funnel actually shows them.
        </p>
      </div>
    </>
  );
}

function OutcomeFields({
  node,
  issues,
  onEdit,
}: {
  node: Extract<FlowNode, { kind: "outcome" }>;
  issues: readonly FieldIssue[];
  onEdit: (edit: InspectorEdit) => void;
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={`hl-${node.id}`}>
        Result headline (optional)
      </label>
      <input
        key={`hl-${node.id}`}
        id={`hl-${node.id}`}
        type="text"
        defaultValue={node.headline ?? ""}
        maxLength={FLOW_LIMITS.headline}
        onBlur={(e) => onEdit({ kind: "headline", text: e.target.value })}
        className={inputClass}
      />
      <IssueList issues={issues} field="headline" />
      <p className={helpClass}>
        About how ready the enquiry is, never about the treatment: a clinician decides what is
        suitable, always.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * WHERE EACH ANSWER GOES. The branch list.
 *
 * The whole reason a step's rail is worth having: on the abstract canvas a branch
 * is a wire you have to find and click, and on a phone strip the wires are behind
 * the screens. Here they are rows - the answer, and where it leads - on the step
 * they leave.
 * ------------------------------------------------------------------------- */

function Branches({
  graph,
  node,
  issues,
  onEdit,
  onSelect,
}: {
  graph: FlowGraph;
  node: FlowNode;
  issues: readonly FieldIssue[];
  onEdit: (edit: InspectorEdit) => void;
  onSelect: (selection: FlowSelection | null) => void;
}) {
  const branches = outgoingEdges(graph, node.id);
  const uncovered = uncoveredAnswers(graph, node.id);
  const targets = connectableTargets(graph, node.id);

  return (
    <div className="border-t border-line pt-2">
      <p className={labelClass}>Where each answer goes</p>

      {branches.length === 0 ? (
        <p className={helpClass}>
          This step leads nowhere, so the funnel stops on it. Connect it below.
        </p>
      ) : (
        <ul className="mt-1 space-y-1.5">
          {branches.map(({ index, edge }, row) => (
            <li
              key={`${index}-${edge.to}-${edge.answer ?? ""}`}
              className="rounded-lg border border-line bg-card-muted/40 px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold text-navy">
                  {describeEdge(edge, node) ?? "Straight on"}
                </span>
                {/* THE ORDER OF THE BRANCHES, on the rows themselves. It is the
                    order they are drawn in and - on a step with no "anything
                    else" route - the one the funnel falls back to. Absent on a
                    step with a single wire, where there is nothing to reorder. */}
                {branches.length > 1 ? (
                  <>
                    <button
                      type="button"
                      disabled={row === 0}
                      onClick={() => onEdit({ kind: "move-edge", index, delta: -1 })}
                      aria-label={`Move “${describeEdge(edge, node) ?? "Straight on"}” up`}
                      className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-card-muted hover:text-navy disabled:opacity-30"
                    >
                      <ArrowUp size={12} />
                    </button>
                    <button
                      type="button"
                      disabled={row === branches.length - 1}
                      onClick={() => onEdit({ kind: "move-edge", index, delta: 1 })}
                      aria-label={`Move “${describeEdge(edge, node) ?? "Straight on"}” down`}
                      className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-card-muted hover:text-navy disabled:opacity-30"
                    >
                      <ArrowDown size={12} />
                    </button>
                  </>
                ) : null}
                {/* The connection's own rail: its answer, and the lead-in line
                    tailored to it. Reached from the branch it is about rather
                    than by hunting for a 1.5px wire. */}
                <button
                  type="button"
                  onClick={() => onSelect({ kind: "edge", index })}
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold text-status-royal transition-colors hover:bg-tint-royal"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => onEdit({ kind: "remove-edge", index })}
                  aria-label={`Remove the connection to ${edge.to}`}
                  className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-tint-red hover:text-status-red"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <ArrowRight size={12} className="shrink-0 text-muted" aria-hidden />
                <select
                  aria-label={`Where “${describeEdge(edge, node) ?? "Straight on"}” goes`}
                  value={edge.to}
                  onChange={(e) => onEdit({ kind: "edge-target", index, to: e.target.value })}
                  className={cn(inputClass, "mt-0 flex-1 py-1 text-[11.5px]")}
                >
                  {connectableTargets(graph, edge.from).map((n) => (
                    <option key={n.id} value={n.id}>
                      {describeNode(n).title}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}

      <IssueList issues={issues} field="branches" />

      {uncovered.length > 0 ? (
        <div className="mt-2">
          <p className={labelClass}>Answers that lead nowhere</p>
          <ul className="mt-1 space-y-1">
            {uncovered.map((o) => (
              <li key={o.value} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink">{o.label}</span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => onEdit({ kind: "route-option", value: o.value })}
                >
                  <Plus size={12} /> Route it
                </Button>
              </li>
            ))}
          </ul>
          <p className={helpClass}>
            Routing sends that answer the same way as the rest for now; change where it goes on its
            own row afterwards.
          </p>
        </div>
      ) : null}

      {/* THE FLOOR UNDER A DEAD END, and the reason it is only here. "Route it"
          above sends an answer the same way as the rest, and on a step with no
          route out there is no rest - so before this control a funnel could be
          broken with the Trash button two rows up and repaired from nowhere. On a
          step that already leads somewhere it would be clutter: every other wire
          worth adding is an ANSWER, which is what "Route it" adds. */}
      {branches.length === 0 && node.kind !== "outcome" ? (
        <Connect nodeId={node.id} targets={targets} onEdit={onEdit} />
      ) : null}
    </div>
  );
}

/**
 * Wire a stranded step to another one. Deliberately a plain "anything else" route:
 * it is a repair, and the answer it carries (if it should carry one) is then one
 * control away on the row it becomes.
 */
function Connect({
  nodeId,
  targets,
  onEdit,
}: {
  nodeId: string;
  targets: readonly FlowNode[];
  onEdit: (edit: InspectorEdit) => void;
}) {
  const [pick, setPick] = useState("");

  return (
    <div className="mt-2">
      <label className={labelClass} htmlFor={`link-${nodeId}`}>
        Connect this step to
      </label>
      <div className="mt-1 flex items-center gap-2">
        <select
          id={`link-${nodeId}`}
          value={pick}
          onChange={(e) => setPick(e.target.value)}
          className={cn(inputClass, "mt-0 flex-1")}
        >
          <option value="">Choose a screen...</option>
          {targets.map((n) => (
            <option key={n.id} value={n.id}>
              {describeNode(n).title}
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          disabled={!pick}
          onClick={() => {
            onEdit({ kind: "connect", to: pick, answer: null });
            setPick("");
          }}
        >
          <Link2 size={13} /> Connect
        </Button>
      </div>
      <p className={helpClass}>
        Everyone reaching this step goes on to that one. Send particular answers elsewhere
        afterwards, on their own rows.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * A connection.
 * ------------------------------------------------------------------------- */

function EdgeInspector({
  graph,
  index,
  failures,
  onEdit,
  onSelect,
}: {
  graph: FlowGraph;
  index: number;
  failures: readonly FlowValidationFailure[];
  onEdit: (edit: InspectorEdit) => void;
  onSelect: (selection: FlowSelection | null) => void;
}) {
  const edge = graph.edges[index]!;
  const from = nodeMap(graph).get(edge.from);
  const label = from ? describeEdge(edge, from) : edge.answer;
  const answers = from ? routableAnswers(from) : [];
  const issues = edgeIssues(graph, failures, index);
  const insertable = useMemo(() => insertableQuestions(graph, index), [graph, index]);
  const [pick, setPick] = useState("");

  return (
    <div className="space-y-3">
      <InspectorHead
        eyebrow="Connection"
        title={label ?? "Straight on"}
        // Back to the step it leaves, not to nothing: this rail was opened from
        // that step's branch list, and closing it should land where it came from.
        onClose={() => onSelect(from ? { kind: "node", id: from.id } : null)}
      />
      <IssueList issues={issues} field="step" />

      <div>
        <label className={labelClass} htmlFor={`ea-${index}`}>
          Taken when the answer is
        </label>
        <select
          id={`ea-${index}`}
          value={edge.answer ?? ""}
          onChange={(e) => onEdit({ kind: "edge-answer", index, answer: e.target.value || null })}
          className={inputClass}
        >
          <option value="">Anything else</option>
          {answers.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <IssueList issues={issues} field="answer" />
      </div>

      <div>
        <label className={labelClass} htmlFor={`et-${index}`}>
          Then go to
        </label>
        <select
          id={`et-${index}`}
          value={edge.to}
          onChange={(e) => onEdit({ kind: "edge-target", index, to: e.target.value })}
          className={inputClass}
        >
          {connectableTargets(graph, edge.from).map((n) => (
            <option key={n.id} value={n.id}>
              {describeNode(n).title}
            </option>
          ))}
        </select>
        <IssueList issues={issues} field="target" />
      </div>

      <div>
        <label className={labelClass} htmlFor={`etr-${index}`}>
          Lead-in for this answer (optional)
        </label>
        <input
          key={`etr-${index}-${edge.from}-${edge.to}-${edge.answer ?? ""}`}
          id={`etr-${index}`}
          type="text"
          defaultValue={edge.transition ?? ""}
          maxLength={FLOW_LIMITS.transition}
          placeholder="Thank you. A quick one about what you would like to change."
          onBlur={(e) => onEdit({ kind: "edge-transition", index, text: e.target.value })}
          className={inputClass}
        />
        <IssueList issues={issues} field="transition" />
        <p className={helpClass}>Shown on the next step, tailored to the answer just given.</p>
      </div>

      <div className="border-t border-line pt-2">
        <label className={labelClass} htmlFor={`ins-${index}`}>
          Add a question here
        </label>
        {insertable.length === 0 ? (
          <p className={helpClass}>
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
                onEdit({ kind: "insert-question", index, questionId: pick });
                setPick("");
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
          onClick={() => onEdit({ kind: "remove-edge", index })}
        >
          <Trash2 size={13} /> Remove this connection
        </Button>
      </div>
    </div>
  );
}
