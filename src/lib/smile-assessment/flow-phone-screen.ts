// WHAT A PATIENT ACTUALLY SEES ON EACH STEP OF A FUNNEL, as data.
//
// The builder's canvas draws a funnel as cards ABOUT the screens ("Question",
// "Contact details", "Result · Hot"). This module resolves the screens
// THEMSELVES - the prompt, the answer rows, the hero line above the first one,
// the contact form's own words, the result copy - so the create wizard can show a
// row of phone screens instead of a row of abstract boxes.
//
// ONE SOURCE, AND IT IS THE RUNTIME. Every string below is either read off the
// graph, read out of the question bank, produced by result-copy.ts, or copied
// verbatim from deterministic-assessment-quiz.tsx with the line noted. Nothing is
// invented, because a preview of a screen that does not exist is worse than no
// preview: it is a promise the funnel does not keep.
//
// WHY NOT describeNode (flow-edit.ts:455). Because describeNode writes for the
// OWNER, not the patient. It returns option LABELS only, and the minis need the
// option VALUE too (the icon is chosen by value - option-icons.ts), and it mixes
// in builder-only lines that no patient ever reads ("Sits above the first
// question", "Uses the assessment's own intro", "Contacted straight away"). Those
// belong on a card about a step. They must never appear on a drawing of the step.
//
// PURE DATA OUT, NO REACT. Same boundary as flow-layout.ts and flow-phone-layout.ts,
// for the same reason: vitest collects only src/**\/*.test.ts, so a copy rule that
// lives in JSX is a copy rule no test can reach.
//
// OWNER-SIDE ONLY. This module imports the question bank, which carries the
// option WEIGHTS - the practice's scoring model, which must never be published
// (flow.ts:11-19). That is safe HERE and only here because its one caller is the
// authenticated builder panel, which already pulls quiz.ts in through
// flow-edit.ts. It must never be imported by the public assessment page. The
// options it emits are narrowed to { value, label }, so a weight cannot reach the
// DOM even by accident - pinned by a test.

import { type FlowBand, type FlowGraph, type FlowNode } from "./flow";
import { blockViews, optionImageViews, type ImageView } from "./flow-block-view";
import { walkFlow, welcomeNode, type WelcomeNode } from "./flow-runtime";
import { questionById, type QuizQuestion } from "./quiz";
import { resultCopy } from "./result-copy";

// ---------------------------------------------------------------------------
// The screens.
// ---------------------------------------------------------------------------

/** One tappable answer. The VALUE is carried because the icon is chosen by it. */
export interface PhoneOption {
  value: string;
  label: string;
  /**
   * The answer-card picture, when the step has one for this answer. ABSENT rather
   * than null when it does not, so a screen resolved from a funnel drawn before A2
   * is the same object it was - which is what lets the mini keep its icon row
   * untouched (and what the no-furniture baseline in flow-phone-mini.test.ts pins).
   */
  image?: ImageView;
}

// ---------------------------------------------------------------------------
// CONTENT BLOCKS, COMPRESSED TO WHAT FITS.
//
// A mini is 300px wide and exactly as tall as PHONE_METRICS.minH says (470px, and
// uniform - flow-phone-layout.ts). A two-to-six item accordion of 240-character
// answers does not go in there, and neither does a 1000px hero. So a block is
// carried here as the SHORTEST TRUE STATEMENT of what the patient's screen has on
// it, and the mini draws that.
//
// THIS IS THE ONE PLACE THIS MODULE INVENTS A WORD, and the header's rule (nothing
// invented, every string read off the graph or the runtime) is bent on purpose
// rather than by accident. A count line - "3 questions answered" - describes a
// block truthfully at a size the block itself cannot be drawn at; the alternative
// is a phone with a wall of clipped text in it, which says less about the funnel
// than the count does. Everything an owner AUTHORED still travels verbatim: the
// practice name, every chip, the quote, the attribution and the alt text are the
// stored strings, not summaries of them.
//
// A PICTURE IS NOT FETCHED FOR A BLOCK. Answer tiles are 360x270 WebP at 4-5KB and
// are drawn for real; a screen picture is a 1000px JPEG and there can be one on
// every welcome and every result step, on a strip that renders ten minis at once.
// So the block carries its ALT and the mini draws a stand-in, the same way it
// draws a stand-in for the contact form's inputs rather than rendering them.
// ---------------------------------------------------------------------------

export type PhoneBlock =
  | { kind: "trust-strip"; practiceName: string; chips: string[] }
  /** The quote and who said it, on one line. */
  | { kind: "testimonial"; line: string }
  /** "3 questions answered". */
  | { kind: "faq"; line: string }
  /** What the picture shows, for the stand-in's caption. */
  | { kind: "image"; alt: string };

/** One input on the contact screen. `type` is the real input type it renders. */
export interface PhoneField {
  key: string;
  label: string;
  type: "text" | "tel" | "email";
}

/** One reply-channel choice on the contact screen. */
export interface PhoneChannel {
  key: string;
  label: string;
}

/**
 * The campaign's own opening copy, as it stands right now.
 *
 * A welcome step OVERRIDES these rather than adding to them
 * (deterministic-assessment-quiz.tsx:206-212), so both are needed to say what the
 * first screen reads: the step's line if it has one, the campaign's otherwise.
 */
export interface PhoneCampaign {
  headline?: string | null;
  intro?: string | null;
}

export type PhoneScreen =
  | {
      kind: "question";
      nodeId: string;
      questionId: string;
      /** The step chip's number, from the layout (flow-phone-layout.ts). */
      step: number;
      /** "Question 2", or "Question 3 · nearly there" from the third on. */
      chip: string;
      /** The warm lead-in above the prompt, when the step carries one. */
      transition: string | null;
      /** Every screen after the first has a Back link. */
      canGoBack: boolean;
      prompt: string;
      options: PhoneOption[];
      /** The progress bar's fill, as a whole percent. */
      progress: number;
    }
  | {
      // THE FIRST SCREEN. A welcome step is not a screen of its own and there is
      // no start button anywhere in the runtime: the hero headline and intro are
      // rendered ABOVE THE FIRST QUESTION'S PROMPT, on the question screen
      // (deterministic-assessment-quiz.tsx:515,549-555). So this is that screen,
      // hero block and all - which is exactly what a patient sees when they land.
      kind: "welcome-question";
      nodeId: string;
      questionId: string;
      step: number;
      chip: string;
      /** Null when neither the step nor the campaign has one: the runtime then
       *  renders no headline line at all (:551). */
      headline: string | null;
      /** Always a string: the runtime falls back to its own line (:553). */
      intro: string;
      prompt: string;
      options: PhoneOption[];
      /** The welcome step's furniture, compressed. Empty for a funnel with none. */
      blocks: PhoneBlock[];
      progress: number;
    }
  | {
      kind: "contact";
      nodeId: string;
      eyebrow: string;
      heading: string;
      helper: string;
      nameField: PhoneField;
      channelLegend: string;
      channels: PhoneChannel[];
      /** The address input, sitting UNDER the channel row (see CONTACT_*). */
      addressField: PhoneField;
      submitLabel: string;
      consent: string;
      progress: number;
    }
  | {
      kind: "outcome";
      nodeId: string;
      band: FlowBand;
      headline: string;
      body: string;
      /** This result step's furniture, compressed. Empty for a step with none. */
      blocks: PhoneBlock[];
      progress: number;
    }
  | {
      // LOUD, NEVER BLANK. A step that cannot be drawn says why, in the owner's
      // language, on the step itself - because the alternative is an empty phone
      // in the middle of the strip and no clue which step is broken.
      kind: "error";
      nodeId: string;
      title: string;
      detail: string;
      progress: number;
    };

// ---------------------------------------------------------------------------
// The copy the runtime owns. Verbatim, with the line it came from, so a change
// there shows up as a failing test here rather than as a preview that quietly
// stopped matching the thing it previews.
// ---------------------------------------------------------------------------

/** deterministic-assessment-quiz.tsx:553. Shown when nothing else supplies one. */
const DEFAULT_INTRO =
  "Find the right next step for your smile. About 30 seconds, no wrong answers.";

/** deterministic-assessment-quiz.tsx:702-711. */
const CONTACT_EYEBROW = "Your assessment is ready";
const CONTACT_HEADING = "Where should we send your tailored next step?";
const CONTACT_HELPER =
  "You'll get a recommendation for your goal and the soonest time we can see you. We'll only use this to follow up about your enquiry.";

/** :716. */
const CONTACT_NAME_FIELD: PhoneField = { key: "first-name", label: "First name", type: "text" };

/**
 * :769. The MOBILE field, not the email one, because the channel picker starts on
 * "sms" (:180) and the screen shows the address that channel needs. The email
 * field only replaces it once a patient taps Email, and a static mini shows the
 * screen as it arrives.
 */
const CONTACT_ADDRESS_FIELD: PhoneField = { key: "mobile", label: "Mobile number", type: "tel" };

/** :727-728. */
const CONTACT_CHANNEL_LEGEND = "How would you like us to reply?";

/**
 * :668-671. WhatsApp is deliberately absent: it stays hidden until the practice's
 * sender is connected, and a preview that offered it would promise a channel the
 * funnel cannot send on.
 */
const CONTACT_CHANNELS: readonly PhoneChannel[] = [
  { key: "sms", label: "Text" },
  { key: "email", label: "Email" },
];

/** :786 and :794. */
const CONTACT_SUBMIT = "See my next step";
const CONTACT_CONSENT = "By sending this you agree we can contact you about your enquiry.";

/** :811. The result step's own headline wins when it has one. */
const OUTCOME_FALLBACK_HEADLINE = "Thank you";

// ---------------------------------------------------------------------------
// Small derivations, each mirroring one line of the runtime.
// ---------------------------------------------------------------------------

/** deterministic-assessment-quiz.tsx:545. */
function stepChip(step: number): string {
  return step >= 3 ? `Question ${step} · nearly there` : `Question ${step}`;
}

/**
 * deterministic-assessment-quiz.tsx:214-217, rounded to a whole percent: it is a
 * CSS width, and no screen is a third of a pixel wider than another.
 */
function questionProgress(step: number): number {
  return Math.round(Math.min(0.9, step / 6) * 100);
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const s = (value ?? "").trim();
  return s === "" ? null : s;
}

/**
 * { value, label } and, where the STEP has one, the answer's picture. The option
 * WEIGHT never leaves the bank: the fields are named one at a time, never spread,
 * for exactly the reason toPublicFlow names them one at a time (campaign.ts:236).
 *
 * The pictures come from the NODE, not the question, because that is where they
 * are authored - the same bank question can appear on two branches wearing
 * different art (flow.ts, FlowOptionImage).
 */
function publicOptions(question: QuizQuestion, node: FlowNode): PhoneOption[] {
  const images = optionImageViews(node);
  return question.options.map((o) => {
    const image = images.get(o.value);
    // The key is OMITTED, not set to undefined: a screen from a funnel with no
    // pictures must be the object it was before A2, byte for byte in JSON.
    return image ? { value: o.value, label: o.label, image } : { value: o.value, label: o.label };
  });
}

/**
 * A block as the shortest true statement of itself. See the PhoneBlock note above
 * for why a count line is allowed to be a sentence this module wrote.
 */
export function phoneBlocks(node: FlowNode): PhoneBlock[] {
  return blockViews(node).map((b): PhoneBlock => {
    switch (b.kind) {
      case "trust-strip":
        return { kind: "trust-strip", practiceName: b.practiceName, chips: [...b.chips] };
      case "testimonial":
        // Curly quotes and an em dash, because this is the line as it reads, and a
        // straight quote next to a straight apostrophe inside the quote is soup.
        return { kind: "testimonial", line: `“${b.quote}” — ${b.attribution}` };
      case "faq":
        return {
          kind: "faq",
          line: `${b.items.length} question${b.items.length === 1 ? "" : "s"} answered`,
        };
      case "image":
        return { kind: "image", alt: b.image.alt };
    }
  });
}

function errorScreen(nodeId: string, title: string, detail: string): PhoneScreen {
  return { kind: "error", nodeId, title, detail, progress: 0 };
}

/**
 * A question id that is not in the bank is a rule-2 validation failure
 * (flow-validate.ts:187-193) and a blank screen for the patient. Name the id, so
 * the owner can see WHICH step the validation banner is complaining about.
 */
function unknownQuestion(nodeId: string, questionId: string): PhoneScreen {
  return errorScreen(
    nodeId,
    "This step has no question",
    `“${questionId}” is not in the question bank, so a patient would land on an empty screen. Pick a question for this step.`,
  );
}

// ---------------------------------------------------------------------------
// The resolution.
// ---------------------------------------------------------------------------

/**
 * The screen a patient sees at `node`.
 *
 * `step` is the number the LAYOUT gave this node (PhoneNode.step,
 * flow-phone-layout.ts). It is passed in rather than recomputed so the chip and
 * the picture cannot disagree: the strip says "Question 3" because that screen is
 * in the third column, not because two modules counted separately.
 *
 * PURE. The graph is read, never written, and the same inputs always produce the
 * same screen.
 */
export function screenFor(
  node: FlowNode,
  graph: FlowGraph,
  campaign: PhoneCampaign = {},
  step = 1,
): PhoneScreen {
  switch (node.kind) {
    case "welcome":
      return welcomeScreen(node, graph, campaign, step);

    case "question": {
      const q = questionById(node.questionId);
      if (!q) return unknownQuestion(node.id, node.questionId);
      const options = publicOptions(q, node);

      // A funnel may open straight on a question, with no welcome step at all.
      // The hero block still renders, because the runtime keys it off "this is
      // the first screen" and not off the presence of a welcome step (:515,549).
      if (graph.entry === node.id) {
        return heroScreen({
          nodeId: node.id,
          questionId: node.questionId,
          prompt: q.prompt,
          options,
          // No furniture: a question node cannot carry blocks (flow.ts,
          // FLOW_BLOCK_SCREEN_KINDS), so a funnel that opens on one has none to
          // draw on its first screen.
          blocks: [],
          ownHeadline: null,
          ownIntro: null,
          campaign,
          step,
        });
      }

      return {
        kind: "question",
        nodeId: node.id,
        questionId: node.questionId,
        step,
        chip: stepChip(step),
        // The step's own lead-in. An EDGE may override it for one route
        // (flow.ts:65-71); a static screen shows the line that applies whichever
        // way the patient arrived.
        transition: trimmedOrNull(node.transition),
        canGoBack: step > 1,
        prompt: q.prompt,
        options,
        progress: questionProgress(step),
      };
    }

    case "contact":
      return {
        kind: "contact",
        nodeId: node.id,
        eyebrow: CONTACT_EYEBROW,
        heading: CONTACT_HEADING,
        helper: CONTACT_HELPER,
        nameField: { ...CONTACT_NAME_FIELD },
        channelLegend: CONTACT_CHANNEL_LEGEND,
        // Copies, because a caller may hold and sort what it is handed.
        channels: CONTACT_CHANNELS.map((c) => ({ ...c })),
        addressField: { ...CONTACT_ADDRESS_FIELD },
        submitLabel: CONTACT_SUBMIT,
        consent: CONTACT_CONSENT,
        // The bar is full by the time the contact step is reached (:216).
        progress: 100,
      };

    case "outcome":
      return {
        kind: "outcome",
        nodeId: node.id,
        band: node.band,
        headline: trimmedOrNull(node.headline) ?? OUTCOME_FALLBACK_HEADLINE,
        // A CONVENTION, and said out loud because it is not a graph fact.
        // resultCopy takes two RUNTIME outcomes besides the band: whether a
        // Speed-to-lead lead was actually created, and whether the practice has
        // online booking switched on (result-copy.ts:22-42, six strings in all).
        // A static preview has neither, so it shows the default path: a hot
        // result IS fast-tracked and contacted (submit/route.ts:291), and no
        // booking link is assumed, which is what a practice sees until it turns
        // online booking on. The three bands still read differently from each
        // other, which is the whole reason a funnel has three result steps.
        body: resultCopy(node.band, node.band === "high", false),
        blocks: phoneBlocks(node),
        progress: 100,
      };
  }
}

/**
 * The first screen, hero block and all. Shared by both ways of reaching it: a
 * funnel that opens on a welcome step, and one that opens straight on a question.
 */
function heroScreen(input: {
  nodeId: string;
  questionId: string;
  prompt: string;
  options: PhoneOption[];
  /** The welcome step's furniture. Never the question node's - it can carry none. */
  blocks: PhoneBlock[];
  /** The welcome step's own headline, when it has one. */
  ownHeadline: string | null;
  ownIntro: string | null;
  campaign: PhoneCampaign;
  step: number;
}): Extract<PhoneScreen, { kind: "welcome-question" }> {
  return {
    kind: "welcome-question",
    nodeId: input.nodeId,
    questionId: input.questionId,
    step: input.step,
    chip: stepChip(input.step),
    blocks: input.blocks,
    // The step's line wins over the campaign's - two sources of the same words on
    // one screen is how they end up contradicting each other (:206-212).
    headline: input.ownHeadline ?? trimmedOrNull(input.campaign.headline),
    // The runtime prints `intro || DEFAULT_INTRO` (:552-554), so a cleared line
    // falls all the way through to the assessment's own words rather than to a
    // blank space where a sentence used to be.
    intro: input.ownIntro ?? trimmedOrNull(input.campaign.intro) ?? DEFAULT_INTRO,
    prompt: input.prompt,
    options: input.options,
    progress: questionProgress(input.step),
  };
}

function welcomeScreen(
  node: WelcomeNode,
  graph: FlowGraph,
  campaign: PhoneCampaign,
  step: number,
): PhoneScreen {
  // welcomeNode returns the ENTRY, and only when the entry is a welcome step
  // (flow-runtime.ts:54-57). A welcome step anywhere else is copy no patient ever
  // reads, and saying so is the whole value of previewing it.
  const entry = welcomeNode(graph);
  if (!entry || entry.id !== node.id) {
    return errorScreen(
      node.id,
      "Nobody sees this step",
      `The funnel starts at “${graph.entry}”, and welcome copy is only ever shown by the step a funnel opens on. Make this the first step, or delete it.`,
    );
  }

  // The runtime's OWN walk, with no answers: whatever it asks first is what sits
  // under the hero block. Reusing walkFlow rather than following edges here means
  // the preview cannot route differently from the funnel it previews.
  const walk = walkFlow(graph, {});
  if (walk.status === "stuck") {
    return errorScreen(node.id, "This step leads nowhere", walk.reason);
  }
  if (walk.status === "contact") {
    return errorScreen(
      node.id,
      "There is no first question",
      "This funnel goes straight from the welcome step to the contact step, and the contact screen carries its own heading - so this copy is never shown. Add a question after it.",
    );
  }

  const q = questionById(walk.node.questionId);
  if (!q) return unknownQuestion(node.id, walk.node.questionId);

  return heroScreen({
    nodeId: node.id,
    questionId: walk.node.questionId,
    prompt: q.prompt,
    // TWO NODES, ONE SCREEN, and each contributes exactly what it owns: the
    // answers and their pictures come from the QUESTION the walk landed on, the
    // furniture from the WELCOME step whose copy sits above it.
    options: publicOptions(q, walk.node),
    blocks: phoneBlocks(node),
    ownHeadline: trimmedOrNull(node.headline),
    ownIntro: trimmedOrNull(node.intro),
    campaign,
    step,
  });
}
