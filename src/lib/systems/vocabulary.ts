// ===========================================================================
// WHAT SWITCHING A SYSTEM ON ACTUALLY STARTS — one sentence, one source.
//
// THE PROBLEM THIS SOLVES. The control panel used to answer only half the
// question. Each row said what stops when you switch a system OFF (`halts` in
// the catalog) and nothing at all about what starts when you switch it ON — the
// question an owner is actually asking, since every row they can see is a row
// they are considering turning on. That sentence existed, in
// docs/runbooks/agent-switch-on.md, on a screen nobody is looking at while they
// hold the switch.
//
// WHY IT IS DERIVED AND NOT RETYPED. src/lib/agent-wiring/roster.ts is the
// runbook's declared source: its own header says so, and roster.test.ts fails
// when the runbook loses a section for an agent in it. Retyping `firstTick` into
// the control panel would create a third copy of a sentence that already exists
// twice, and the copy on the screen — the only one a practice reads — would be
// the one nobody notices going stale. So the rostered systems READ theirs off
// the roster: `starts` for `recall` is `AGENTS.recall.firstTick`, and
// vocabulary.test.ts asserts that equality for EVERY rostered system. A lane
// that rewrites an agent rewrites the screen with it, and a retyped copy that
// happens to match today goes red the day the roster moves — which is the only
// guarantee worth having, since a string primitive has no identity to pin.
//
// THE TEN THAT ARE NOT AGENTS. Ten controllable systems have no roster entry,
// because they are not agents: they publish a form, hide a workspace, hold a
// signature, or (in one case) govern every write the platform makes. Those are
// authored below, marked `source: "module"`, and the exhaustiveness test fails
// the moment a new system is added without one.
//
// SERVER-SIDE ONLY BY CONVENTION, not by a `server-only` import (it has no I/O
// and tests render it directly). It pulls in the whole agent roster, which
// carries repo-relative source paths for every agent, and that has no business
// in a browser bundle. Its one consumer is /api/systems, which serialises the
// three fields the panel draws. The client-safe half — the "what to do first"
// sentences a workspace prints in its empty state — is in `first-steps.ts`,
// which imports nothing.
// ===========================================================================

import { AGENTS } from "@/lib/agent-wiring/roster";
import { SYSTEMS } from "./catalog";
import { firstStepFor } from "./first-steps";

export interface SystemVocabulary {
  slug: string;
  /**
   * What the first tick after switch-on actually does. Owner-facing, present
   * tense, one or two sentences.
   */
  starts: string;
  /**
   * What has to be in place before that first tick can work. Env vars, cron
   * registrations and external accounts appear here under their real names:
   * they have no other name, and the person reading this row is the person who
   * arranges them. Excluded by name from the vocabulary crawl for that reason.
   */
  needsFirst: readonly string[];
  /** The one thing to do first, where the surface has one. */
  firstStep: string | null;
  /** Where `starts` came from, so a reader (and a test) can audit it. */
  source: "roster" | "module";
}

/**
 * The systems that are not agents. Every one of these is a real switch with real
 * server-side consequences; none of them has a trigger → guard → draft → outbox
 * → correspondence trace, which is what puts a thing in the agent roster.
 */
const MODULE_VOCABULARY: Record<string, { starts: string; needsFirst: readonly string[] }> = {
  onboarding: {
    starts:
      "The public new-patient form at /onboard comes online and submissions start arriving in the " +
      "Onboarding module for the team to review and register.",
    needsFirst: ["PUBLIC_BASE_URL, so the link you share resolves"],
  },
  fp17: {
    starts:
      "The consent and exemption declaration form comes online, and a per-patient link can be sent " +
      "for a patient to complete on their phone. Nothing captured here is submitted to Compass.",
    needsFirst: [
      "the declaration wording signed off by whoever is accountable for it at the practice",
      "PUBLIC_BASE_URL, so the per-patient link resolves",
    ],
  },
  whatsapp: {
    starts:
      "Outgoing messages start using WhatsApp for patients whose preference is WhatsApp, instead of " +
      "falling back to SMS. It changes the channel, never the message.",
    needsFirst: ["a live WhatsApp Business sender on the messaging account"],
  },
  "staff-esign": {
    starts:
      "Policies can be published for signature, and each member of staff is asked to sign the ones " +
      "that apply to them from their own My work page.",
    needsFirst: ["the practice's agreement that a login-bound signature is the evidence it intends to keep"],
  },
  "daily-brief": {
    starts:
      "The morning brief is generated from the day's diary and each role is handed its own " +
      "prioritised list before the first patient arrives.",
    needsFirst: [],
  },
  "meta-ads": {
    starts:
      "The ads workspace becomes visible again: templates, AI ad copy, the launch guide and the ad " +
      "library. No spend starts and no campaign goes live from switching this on.",
    needsFirst: ["a connected Meta account before any figure on the screen is real"],
  },
  compliance: {
    starts:
      "The compliance workspace becomes visible again: the readiness view, the audit calendar, the " +
      "policy library and the training matrix.",
    needsFirst: [],
  },
  equipment: {
    starts:
      "The equipment desk starts answering questions about the machines on your register, from the " +
      "manuals you have uploaded against them. It answers about nothing else.",
    needsFirst: [
      "the asset register imported or entered",
      "a manual uploaded against each machine you want answers about",
    ],
  },
  "it-desk": {
    starts:
      "The IT desk starts walking staff through the troubleshooting playbooks one step at a time, " +
      "and hands over to your named IT contact when the steps run out.",
    needsFirst: ["the practice's IT contact set, so the hand-off has somewhere to go"],
  },
  "dentally-write-back": {
    starts:
      "Appointments created, moved and cancelled here start reaching your Dentally book, and new or " +
      "edited patient records start being written there. Until then every one of them is recorded on " +
      "the Dentally sync tab and held back.",
    needsFirst: [
      "DENTALLY_WRITE_ENABLED, a real write key and an explicit write base URL on the deployment",
      "the agency's confirmation that live write calibration has been done against the real book",
    ],
  },
};

function build(): Record<string, SystemVocabulary> {
  const bySlug = new Map(AGENTS.filter((a) => a.slug !== null).map((a) => [a.slug as string, a]));
  const out: Record<string, SystemVocabulary> = {};
  for (const system of SYSTEMS) {
    const agent = bySlug.get(system.slug);
    const authored = MODULE_VOCABULARY[system.slug];
    const firstStep = firstStepFor(system.slug)?.step ?? null;
    if (agent) {
      // READ off the roster rather than retyped: this line is the whole of the
      // no-third-copy rule, and vocabulary.test.ts asserts the equality per system.
      out[system.slug] = {
        slug: system.slug,
        starts: agent.firstTick,
        needsFirst: agent.needs,
        firstStep,
        source: "roster",
      };
    } else if (authored) {
      out[system.slug] = {
        slug: system.slug,
        starts: authored.starts,
        needsFirst: authored.needsFirst,
        firstStep,
        source: "module",
      };
    }
    // A system with neither is left OUT rather than given a placeholder: an
    // invented sentence on a switch is worse than a row with no sentence, and
    // vocabulary.test.ts fails on the gap rather than letting it ship quietly.
  }
  return out;
}

/** Every controllable system's switch-on vocabulary, keyed by slug. */
export const SYSTEM_VOCABULARY: Record<string, SystemVocabulary> = build();

/** The switch-on vocabulary for one system, or null when none is written. */
export function vocabularyFor(slug: string): SystemVocabulary | null {
  return SYSTEM_VOCABULARY[slug] ?? null;
}

/**
 * Slugs whose sentence is authored here rather than taken from the agent roster.
 * Exported so the test can assert the split is exactly what this file documents,
 * rather than merely that every slug has something.
 */
export const AUTHORED_VOCABULARY_SLUGS: readonly string[] = Object.keys(MODULE_VOCABULARY);
