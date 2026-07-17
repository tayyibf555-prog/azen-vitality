// Generation ORCHESTRATION: turn a treatment + direction into a vetted content
// variant, with one regeneration retry and a hand-written default as the final
// fallback. The model call is INJECTED (callModel) so this whole flow is unit-
// testable without the network or the Anthropic SDK (see generate-run test).
//
// Per variant:
//   1. generate  -> validate shape -> lint compliance
//   2. on failure, regenerate ONCE with the failures quoted back
//   3. on a second failure, fall back to the guaranteed-clean default content
//
// Pure of I/O apart from the injected callModel; safe to run in the node test env.

import type { CtaTarget, LandingPageContent } from "./content";
import { validateContent } from "./content";
import { lintContent, describeFailures, type PriceResolver } from "./compliance";
import { getDefaultContent } from "./defaults";
import {
  CREATIVE_DIRECTIONS,
  buildVariantPrompt,
  buildRetryUser,
  parseContentJson,
  type DirectionKey,
} from "./generate";
import type { Treatment } from "@/lib/treatments/catalog";

/** A single system+user round trip to the model. Returns the raw reply text. */
export type CallModel = (system: string, user: string) => Promise<string>;

export type VariantSource = "model" | "model-retry" | "default";

export interface VariantResult {
  variant: DirectionKey;
  content: LandingPageContent;
  source: VariantSource;
}

interface VetOk {
  ok: true;
  content: LandingPageContent;
}
interface VetFail {
  ok: false;
  failuresText: string;
}

/** Validate shape, force the owner-chosen CTA target, then lint compliance. */
function vet(
  raw: unknown,
  ctaTarget: CtaTarget,
  ctaTargetSlug: string | null,
  resolvePrice?: PriceResolver,
): VetOk | VetFail {
  const validation = validateContent(raw);
  if (!validation.ok || !validation.content) {
    return { ok: false, failuresText: validation.errors.map((e) => `- ${e}`).join("\n") };
  }
  // Two owner-only fields are pinned after validation, never trusted from the model:
  //   - cta: the destination is the owner's campaign choice, so the button always
  //     points where the campaign intends;
  //   - showcase3d: the 3D section is owner-configured (a practice-supplied,
  //     self-hosted asset). The generator can never invent or reference a model
  //     file, so anything it emitted here is stripped to null.
  const content: LandingPageContent = {
    ...validation.content,
    cta: { ...validation.content.cta, target: ctaTarget, targetSlug: ctaTargetSlug },
    showcase3d: null,
  };
  const lint = lintContent(content, { resolvePrice });
  if (!lint.ok) return { ok: false, failuresText: describeFailures(lint.failures) };
  return { ok: true, content };
}

export interface GenerateVariantInput {
  direction: DirectionKey;
  treatment: Treatment;
  practiceName: string;
  ctaTarget: CtaTarget;
  ctaTargetSlug?: string | null;
  angle?: string;
  callModel: CallModel;
  resolvePrice?: PriceResolver;
}

/** Generate one vetted variant, with a retry and a default fallback. */
export async function generateVariant(input: GenerateVariantInput): Promise<VariantResult> {
  const { direction, treatment, practiceName, ctaTarget, angle, callModel } = input;
  const ctaTargetSlug = input.ctaTargetSlug ?? null;
  const dir = CREATIVE_DIRECTIONS[direction];
  const { system, user } = buildVariantPrompt({ direction: dir, treatment, practiceName, ctaTarget, angle });

  // Attempt 1.
  let firstReply = "";
  try {
    firstReply = await callModel(system, user);
    const vetted = vet(parseContentJson(firstReply), ctaTarget, ctaTargetSlug, input.resolvePrice);
    if (vetted.ok) return { variant: direction, content: vetted.content, source: "model" };

    // Attempt 2: regenerate once, quoting the failures.
    const retryUser = buildRetryUser(firstReply, vetted.failuresText);
    const secondReply = await callModel(system, retryUser);
    const revetted = vet(parseContentJson(secondReply), ctaTarget, ctaTargetSlug, input.resolvePrice);
    if (revetted.ok) return { variant: direction, content: revetted.content, source: "model-retry" };
  } catch {
    // A model/network error is treated the same as an unusable reply: fall back.
  }

  // Fallback: a guaranteed-compliant hand-written default for this treatment.
  const fallback = getDefaultContent(treatment.key, ctaTarget);
  if (!fallback) {
    // Should not happen: the route validates the treatment against the same
    // catalogue the defaults are keyed on. Surface it rather than store nothing.
    throw new Error(`no default content for treatment "${treatment.key}"`);
  }
  return { variant: direction, content: { ...fallback, cta: { ...fallback.cta, targetSlug: ctaTargetSlug } }, source: "default" };
}

export interface GenerateBothInput {
  treatment: Treatment;
  practiceName: string;
  ctaTarget: CtaTarget;
  ctaTargetSlug?: string | null;
  angle?: string;
  callModel: CallModel;
  resolvePrice?: PriceResolver;
}

/** Generate both variants (A confidence-led, B value-led) in parallel. */
export async function generateBothVariants(
  input: GenerateBothInput,
): Promise<{ a: VariantResult; b: VariantResult }> {
  const [a, b] = await Promise.all([
    generateVariant({ ...input, direction: "a" }),
    generateVariant({ ...input, direction: "b" }),
  ]);
  return { a, b };
}
