// WHAT TO CALL EACH BAR. The drop-off chart's step labels, derived from the SAME
// screen projection the builder's phone minis are drawn from.
//
// SEPARATE FROM step-numbering.ts ON PURPOSE, and the split is a bundle boundary
// rather than tidiness. step-numbering.ts is pulled into the PUBLIC quiz (the
// deterministic runtime emits the ordinals), and screenFor imports ./quiz, which
// carries the option WEIGHTS — the practice's scoring model. So the numbering
// stays pure and weight-free, and the wording lives here, where only the guarded
// owner route imports it.
//
// screenFor RATHER THAN questionById, and that is the whole point of the file
// being three lines of logic: the chart, the phone minis and the live preview then
// call one screen a patient sees by one name. A second lookup here would be a
// second place for "what does this step say" to be answered, and the two would
// drift the first time a prompt was reworded.

import type { FlowGraph } from "./flow";
import { nodeMap } from "./flow";
import { screenFor, type PhoneCampaign } from "./flow-phone-screen";
import type { StepNumbering } from "./step-numbering";

/**
 * The one label that is not a screen's own words.
 *
 * Every band's result screen shares the last ordinal (see step-numbering.ts), so
 * no single band's headline can name it without claiming the funnel ends the way
 * one third of visitors end it. "Result" is what the slot IS.
 */
export const RESULT_STEP_LABEL = "Result";

/**
 * Step ordinal -> the words on that screen, for `DropoffChart`'s `labels`.
 *
 * A PLAIN RECORD, not a lookup function: the chart takes data so it can be
 * rendered from a server component without becoming a client boundary, and this
 * is serialised straight onto the route's JSON.
 *
 * PURE. `campaign` supplies the hero copy the first screen shows, exactly as the
 * public page supplies it, so the first bar reads as the screen a patient lands on.
 */
export function stepLabels(
  graph: FlowGraph,
  numbering: StepNumbering,
  campaign: PhoneCampaign = {},
): Record<number, string> {
  const byId = nodeMap(graph);
  const labels: Record<number, string> = {};

  for (const slot of numbering.screens) {
    if (slot.kind === "outcome") {
      labels[slot.stepIndex] = RESULT_STEP_LABEL;
      continue;
    }
    const node = byId.get(slot.nodeId);
    if (!node) continue;
    // The chip number screenFor prints is not read here; it is passed 1-based so a
    // caller reading the screen for any other reason gets the number this chart
    // shows rather than a placeholder.
    const screen = screenFor(node, graph, campaign, slot.stepIndex + 1);
    switch (screen.kind) {
      case "question":
      case "welcome-question":
        labels[slot.stepIndex] = screen.prompt;
        break;
      case "contact":
        labels[slot.stepIndex] = screen.heading;
        break;
      case "error":
        // LOUD, NEVER BLANK, the same call the phone strip makes: a step whose
        // question left the bank is exactly the step an owner is hunting for when
        // the chart shows everybody leaving at it.
        labels[slot.stepIndex] = screen.title;
        break;
      default:
        break;
    }
  }

  return labels;
}
