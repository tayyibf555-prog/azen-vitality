import type { Role } from "@/lib/types";
import type { CustomQuestionIndex } from "./kind";
import { getBanks } from "./repository";
import { projectSummary } from "./summary";
import type { PreVisitSummary } from "./summary";
import { TRIAGE_FORKS } from "./types";
import type { TriageFieldType, TriageOption, TriageQuestionKind, TriageResponse } from "./types";

// ===========================================================================
// THE PRE-VISIT SUMMARY, RESOLVED — the impure seam in front of the pure one.
//
// `projectSummary` (./summary.ts) is pure and stays pure: a stored response plus a
// role in, sections out. It needs one thing it cannot fetch — the practice's OWN
// questions, which live in a jsonb config row — and this file is where that read
// happens, so that no screen has to remember to do it and no screen can do it
// differently from the next one.
//
// A FAILED READ IS SAFE HERE, WHICH IS THE WHOLE POINT OF THE ARRANGEMENT. If the
// bank config cannot be read, the index comes back empty and the projection falls
// back to the kind STAMPED ON EACH ANSWER, and then to `symptom` (see ./kind.ts).
// So an unreadable config costs the manager a question's label and a question's
// visibility; it cannot cost a patient their privacy. That is why this returns a
// summary rather than throwing: the alternative is a record screen that renders
// nothing because a label lookup failed.
//
// No barrel in this directory (see ./types.ts): this file imports the repository
// and is therefore SERVER-ONLY. A client component must never reach it.
// ===========================================================================

/**
 * The practice's own questions across BOTH banks, indexed by key.
 *
 * Both forks, because a response carries the fork it was asked under and the same
 * custom key can be enabled on either. Where the two configs somehow disagree
 * about a key's kind, the MOST RESTRICTIVE one is kept — the same rule
 * `resolveAnswerKind` applies for the same reason: neither answer to "which one is
 * current?" is safe on its own.
 *
 * THE TYPE IS CARRIED FOR THE SAME REASON THE KIND IS: it is the only thing that
 * can tell the summary a practice-written question was a 0-10 scale, and without
 * it a patient's 9 out of 10 was neither flagged nor printed as a number (see
 * DISCOMFORT_NOTICE_THRESHOLD in ./summary.ts). A disagreement between the two
 * banks about a type resolves towards `scale`, on the same logic: reading a scale
 * that is not one costs a null — `clampScale` refuses anything outside 0-10 — and
 * missing one costs a patient in pain nobody rings.
 *
 * Never throws. An unreadable config is logged and returns an empty index.
 */
export async function customQuestionsFor(clientId: string): Promise<CustomQuestionIndex> {
  const index = new Map<
    string,
    { label: string; kind: TriageQuestionKind; type?: TriageFieldType; options?: readonly TriageOption[] }
  >();
  if (!clientId) return index;

  try {
    const stored = await getBanks(clientId);
    for (const fork of TRIAGE_FORKS) {
      for (const q of stored[fork]?.config.custom ?? []) {
        const existing = index.get(q.key);
        const kind = existing?.kind === "symptom" || q.kind === "symptom" ? "symptom" : q.kind;
        const type =
          existing?.type === "scale" || q.type === "scale" ? "scale" : (existing?.type ?? q.type);
        index.set(q.key, {
          label: existing?.label ?? q.label,
          kind,
          type,
          options: existing?.options ?? q.options,
        });
      }
    }
  } catch (err) {
    // Loud, and it degrades in the safe direction rather than to a blank screen.
    console.error(`[previsit] the practice's own questions could not be read for ${clientId}`, err);
  }
  return index;
}

/**
 * The summary a viewer with this role may read, with the practice's own questions
 * resolved. THE ENTRY POINT every server screen should use.
 */
export async function previsitSummaryFor(args: {
  clientId: string;
  response: TriageResponse;
  viewerRole: Role | null;
}): Promise<PreVisitSummary> {
  const custom = await customQuestionsFor(args.clientId);
  return projectSummary(args.response, args.viewerRole, custom);
}
