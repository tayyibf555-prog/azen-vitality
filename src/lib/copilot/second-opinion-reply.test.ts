import { describe, it, expect, vi } from "vitest";

// ===========================================================================
// THE DECISION-SUPPORT LABEL REACHES THE CLINICIAN, NOT JUST THE MODEL.
//
// WHAT WAS WRONG. `second_opinion` put SECOND_OPINION_LABEL into the JSON tool
// RESULT, and the clinician's system prompt asked the model to "say that, in
// your own words, in every reply that uses it". Both of those are prompts: the
// tool result is read by the model and never rendered, and the reply the route
// returns is `finaliseCopilotReply(replyText, turn)`, which — with no flag
// raised — handed the model's prose back untouched.
//
// So the one sentence that says "this is not a diagnosis, not a treatment plan
// and not an instruction to treat" reached the person only if the model chose to
// relay it. A dentist asking for a straight answer with a patient in the chair is
// exactly the turn where a fluent model drops a standing banner as boilerplate,
// or paraphrases it into "of course you'll want to examine her yourself" — and
// the prompt does not even ask for the string, it asks for the sense of it.
//
// THE PROGRAMME HAD ALREADY DECIDED THIS, FOR THE OTHER DOOR. The equipment
// judgement sentence is appended by the server, unconditionally, because "a fact
// that rests on a prompt is not a fact" (turn.ts, ruling W3/14). The clinical
// door is the one that had no server-side sentence while the machine door did;
// charter §2 (W1-E DoD: decision support "always labelled as such") and §0 item
// 10 make it the one that least ought to.
//
// WHAT THE EXISTING TESTS PROVE, AND WHY IT WAS NOT THIS. battery.test.ts and
// the J4 journey assert `label` on the parsed TOOL RESULT; prompt.test.ts
// asserts the prompt carries the rules. Nothing drove a second-opinion REPLY
// through `finaliseCopilotReply`, so the omission was not representable.
// ===========================================================================

vi.mock("server-only", () => ({}));

const SITE = { id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" };
vi.mock("@/lib/mock", () => ({ getSite: () => SITE, getSites: () => [SITE] }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: () => SITE,
  getSites: () => [SITE],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));

/** One patient, one readable record — the happy path this mode exists for. */
const PATIENT = {
  id: "p1",
  siteId: "site-cc",
  name: "Amina Ahmed",
  active: true,
  archivedReason: null,
  dateOfBirth: "1988-04-02",
  lastVisitAt: "2025-07-14",
  recallDueAt: "2026-01-14",
};

const patients = vi.hoisted(() => ({ matches: [] as unknown[], detail: null as unknown }));

vi.mock("@/lib/dentally/read", () => ({
  searchPatients: async () => patients.matches,
  getPatientDetail: async () => patients.detail,
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: () => ({}),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: async () => {} }));

import { EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";
import { SECOND_OPINION_LABEL } from "./second-opinion";
import { makeCopilotDispatch } from "./tools";
import { copilotTurn, finaliseCopilotReply } from "./turn";

/** A clinician turn, driven through the REAL dispatch, with the real turn context. */
async function askSecondOpinion(words: string, input: Record<string, unknown>) {
  const turn = copilotTurn([words]);
  const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "clinician", undefined, turn);
  const result = JSON.parse(await dispatch("second_opinion", input)) as Record<string, unknown>;
  return { turn, result };
}

describe("a second-opinion REPLY carries the decision-support label, whatever the model wrote", () => {
  it("APPENDS IT TO A REPLY THAT LEFT IT OUT", async () => {
    patients.matches = [PATIENT];
    patients.detail = { notes: [], plans: [], appointments: [], reads: {} };
    const { turn, result } = await askSecondOpinion("Second opinion on Amina Ahmed, she's in the chair.", {
      patient: "Amina Ahmed",
    });
    // The tool did its job: the envelope came back and it is labelled.
    expect(result.label).toBe(SECOND_OPINION_LABEL);

    // The model, being asked for a straight answer at the chair, drops it.
    const modelText =
      "She was last in 14 months ago, has two unaccepted plans and three DNAs. Worth weighing how much of the gap is access rather than choice.";
    const reply = finaliseCopilotReply(modelText, turn);
    expect(reply).toContain(modelText);
    expect(reply).toContain(SECOND_OPINION_LABEL);
  });

  it("APPENDS IT TO EVERY REFUSAL TOO, because a refusal is still a clinical reply", async () => {
    // second-opinion.ts rule 1, and the reason the flag is raised before a single
    // check runs rather than at the end of the happy path.
    const noName = await askSecondOpinion("What would you do about a lower six?", { patient: "" });
    expect(noName.result.refused).toBeTruthy();
    expect(finaliseCopilotReply("I need a patient in scope.", noName.turn)).toContain(SECOND_OPINION_LABEL);

    patients.matches = [];
    const notFound = await askSecondOpinion("Second opinion on Nobody Here", { patient: "Nobody Here" });
    expect(notFound.result.refused).toBeTruthy();
    expect(finaliseCopilotReply("No patient of that name.", notFound.turn)).toContain(SECOND_OPINION_LABEL);

    patients.matches = [PATIENT];
    patients.detail = null;
    const unreadable = await askSecondOpinion("Second opinion on Amina Ahmed", { patient: "Amina Ahmed" });
    expect(unreadable.result.refused).toBeTruthy();
    expect(finaliseCopilotReply("Her record could not be read.", unreadable.turn)).toContain(SECOND_OPINION_LABEL);
  });

  it("covers the two replies the model did not write: the route's fallback and an empty turn", async () => {
    patients.matches = [PATIENT];
    patients.detail = { notes: [], plans: [], appointments: [], reads: {} };
    const { turn } = await askSecondOpinion("Second opinion on Amina Ahmed", { patient: "Amina Ahmed" });
    // The exact string src/app/api/copilot/route.ts falls back to.
    expect(finaliseCopilotReply("Sorry, I could not respond just now.", turn)).toContain(SECOND_OPINION_LABEL);
    expect(finaliseCopilotReply("", turn)).toBe(SECOND_OPINION_LABEL);
  });

  it("adds nothing to a turn that never asked for a second opinion", async () => {
    // The label is a consequence of the door being opened, not a banner on every
    // clinician reply — an ordinary diary question must not carry it.
    const turn = copilotTurn(["what is in the diary tomorrow?"]);
    expect(finaliseCopilotReply("Four patients.", turn)).toBe("Four patients.");
    expect(finaliseCopilotReply("Four patients.", undefined)).toBe("Four patients.");
  });

  it("says it once per reply however many patients were asked about", async () => {
    // A latch, not a counter, exactly like the equipment flag beside it.
    patients.matches = [PATIENT];
    patients.detail = { notes: [], plans: [], appointments: [], reads: {} };
    const turn = copilotTurn(["Second opinion on Amina, then on Amina again."]);
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "clinician", undefined, turn);
    await dispatch("second_opinion", { patient: "Amina Ahmed" });
    await dispatch("second_opinion", { patient: "Amina Ahmed" });
    const reply = finaliseCopilotReply("Here is what both records show.", turn);
    expect(reply.split(SECOND_OPINION_LABEL).length - 1).toBe(1);
  });

  it("composes with the equipment sentence rather than replacing it, and that one stays last", async () => {
    // Both doors can be opened in one turn. Neither sentence may be lost, and the
    // equipment refusal keeps the property its own tests assert: the reply ENDS
    // with it, because it is the one a person must be left holding.
    const turn = copilotTurn(["Second opinion on Amina, and can we still run the autoclave?"]);
    turn.secondOpinionLabelRequired = true;
    turn.equipmentJudgementRequired = true;
    const reply = finaliseCopilotReply("Here is what her record shows, and here are the service dates.", turn);
    expect(reply).toContain(SECOND_OPINION_LABEL);
    expect(reply).toContain(EQUIPMENT_REFUSALS.judgement);
    expect(reply.endsWith(EQUIPMENT_REFUSALS.judgement)).toBe(true);
  });
});
