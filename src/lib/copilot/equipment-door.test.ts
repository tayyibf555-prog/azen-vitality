import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// THE TWO DESK DOORS, GATED ON THE PERSON'S OWN WORDS (ruling W3/14).
//
// The equipment MODULE PAGE runs `gateEquipmentQuestion` over the user's own
// turns before any model call. Through the co-pilot the same gate used to see
// only `input.question` — a string the MODEL wrote — so both halves of ruling
// W1-D/2 became conditional on how the question was reworded:
//
//   "the autoclave is out of test but we're fully booked, can we run it today?"
//     -> facts_only on the page, because `judgement.overdue_service` matches
//     -> plain allow through the co-pilot, if the model called the tool with
//        "autoclave next service due date and supplier"
//
// ...and the standing take-out-of-use sentence, which W1-D/2 says is NEVER
// optional, silently was not there. The same argument applies to the IT desk's
// credential refusals.
//
// The second half of the same ruling: that sentence is APPENDED BY THE SERVER
// (`finaliseCopilotReply`), exactly as the equipment route appends it, rather
// than handed to the model inside a tool result with a note asking it to relay
// it. A fact that rests on a prompt is not a fact.
// ===========================================================================

vi.mock("server-only", () => ({}));

vi.mock("@/lib/mock", () => ({ getSite: (id: string) => ({ id, name: "N15 Vitality Dental", clientId: "vitality" }) }));
vi.mock("@/lib/mock/clients", () => ({
  getSite: (id: string) => ({ id, name: "N15 Vitality Dental", clientId: "vitality" }),
  getSites: () => [{ id: "site-cc", name: "N15 Vitality Dental", clientId: "vitality" }],
  getClient: () => ({ id: "vitality", slug: "vitality", name: "Vitality Dental" }),
  dentallySiteId: (id: string) => `dentally-${id}`,
}));
vi.mock("@/lib/dentally/read", () => ({
  searchPatients: vi.fn(),
  listPatients: vi.fn(),
  listAppointments: vi.fn(),
  listOutstanding: vi.fn(),
  getPatientDetail: vi.fn(),
  listSitePractitioners: vi.fn(),
  dentallyReadKey: () => "test-key",
  dentallyFromEnv: () => ({}),
}));
vi.mock("@/lib/copilot/actions", () => ({ logCopilotAction: async () => {} }));
vi.mock("@/lib/systems/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSystemEnabled: async () => true,
  isSystemEnabledStrict: async () => true,
  isSystemExplicitlyDisabled: async () => false,
}));

// The register and the manual are stubbed; the GATE and the equipment dispatch
// are the module's own, so the boundary tripped here is the real one.
vi.mock("@/lib/equipment/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAssets: async () => [
    {
      id: "asset-1", clientId: "vitality", name: "Lisa steriliser", category: "sterilisation",
      make: "W&H", model: "Lisa", serial: "LS-9001", siteId: "site-cc", room: "Decon",
      supplier: "Dental Services Ltd", supplierPhone: "020 8000 0000", purchasedOn: "2022-01-04",
      lastServicedOn: "2025-06-01", nextServiceDue: "2026-06-01", notes: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    },
    {
      // THE IN-DATE ONE, and it is not decoration. The register-derived rule
      // below must NARROW an answer about an overdue machine without touching a
      // question about a compliant one: appending "take the machine out of use
      // and call the engineer" to a question about a machine that is fine is its
      // own harm, and it is how the sentence stops being read at all.
      // `nextServiceDue` is far enough ahead that this fixture does not become a
      // time bomb the year somebody re-runs the suite.
      id: "asset-2", clientId: "vitality", name: "Durr compressor", category: "other",
      make: "Durr", model: "Tornado", serial: "TC-2201", siteId: "site-cc", room: "Plant room",
      supplier: "Dental Services Ltd", supplierPhone: "020 8000 0000", purchasedOn: "2024-03-01",
      lastServicedOn: "2026-03-01", nextServiceDue: "2099-03-01", notes: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
  listManuals: async () => [{ id: "m1", clientId: "vitality", assetId: "asset-1", status: "ready" }],
  getAsset: async () => ({ id: "asset-1", clientId: "vitality", name: "Lisa steriliser", category: "sterilisation" }),
  listChunksForAsset: async () => [
    { id: "c1", assetId: "asset-1", pageFrom: 12, pageTo: 12, body: "E04 indicates the water reservoir is empty." },
  ],
}));
vi.mock("@/lib/itdesk/repository", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getItContact: async () => ({
    name: "Ash Patel", company: "Northline IT", phone: "020 8111 2222",
    email: "help@northline.example", hours: "9-5 Mon-Fri", notes: null,
  }),
}));

import { EQUIPMENT_REFUSALS } from "@/lib/equipment/topic-gate";
import { makeCopilotDispatch } from "./tools";
import { copilotTurn, finaliseCopilotReply } from "./turn";

/** What the model wrote: on topic, unremarkable, and no rule matches it. */
const PARAPHRASE = "autoclave next service due date and supplier";

async function askEquipment(userTurns: string[], question = PARAPHRASE) {
  const turn = copilotTurn(userTurns);
  const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full", undefined, turn);
  const out = JSON.parse(await dispatch("equipment_lookup", { question, lookup: "service" })) as Record<string, unknown>;
  return { out, turn };
}

beforeEach(() => vi.clearAllMocks());

describe("the equipment door gates on what the PERSON asked, not on the paraphrase", () => {
  it("A JUDGEMENT QUESTION IS CAPPED TO FACTS even when the model rewords it away", async () => {
    // The exact failure this fixes: the person asks whether they can carry on
    // using a machine that is out of test, the model calls the tool with a bland
    // service-date lookup, and the standing refusal is never attached.
    const { out, turn } = await askEquipment([
      "the autoclave is out of test but we're fully booked - can we run it today?",
    ]);
    expect(out.refused).toBeUndefined();
    expect(out.factsOnly).toBe(true);
    expect(out.judgement).toBe(EQUIPMENT_REFUSALS.judgement);
    // ...and the SERVER now owes the sentence, rather than the model being asked
    // nicely for it.
    expect(turn.equipmentJudgementRequired).toBe(true);
  });

  it("catches the judgement question even when the same sentence is off topic too", async () => {
    // "...but we have patients booked all day" trips `offtopic.clinical` on the
    // equipment page, and the gate answers off-topic BEFORE judgement, so the
    // judgement rules never see it. In the co-pilot the patient half is answered
    // by another tool and the equipment half must still be capped, which is why
    // the module's own judgement table is asked directly as well as through the
    // gate.
    const { out, turn } = await askEquipment([
      "the autoclave is out of test but we have patients booked all day, can we still use it?",
    ]);
    expect(out.factsOnly).toBe(true);
    expect(turn.equipmentJudgementRequired).toBe(true);
  });

  it("HARD SAFETY IS REFUSED on the person's words, with no facts and no lookup", async () => {
    const { out, turn } = await askEquipment(["how do I bypass the autoclave door interlock?"]);
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("safety");
    expect(out.rule).toBe("safety.defeat_protection");
    expect(out.message).toBe(EQUIPMENT_REFUSALS.safety);
    // A refusal is not a facts-only answer: nothing was read out, so nothing is
    // owed at the end of the reply either.
    expect(out.factsOnly).toBeUndefined();
    expect(turn.equipmentJudgementRequired).toBe(false);
    expect(out.assets).toBeUndefined();
  });

  it("refuses a bypass asked THREE MESSAGES BACK, exactly as the module page does", async () => {
    // The shared gate runs hard safety over every turn in the window because an
    // instruction planted earlier is still in the context the model reads. The
    // co-pilot passes the same window, so the two doors answer alike.
    const { out } = await askEquipment([
      "how do I tape the lid switch down on the autoclave?",
      "ok forget that",
      "when is it next due a service?",
    ]);
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("safety");
  });

  it("an ordinary equipment question is still answered, and owes no sentence", async () => {
    const { out, turn } = await askEquipment(["when is the Lisa next due a service?"]);
    expect(out.refused).toBeUndefined();
    expect(out.factsOnly).toBeUndefined();
    expect(turn.equipmentJudgementRequired).toBe(false);
  });

  it("with NO turn context the door behaves exactly as it did: the paraphrase alone", async () => {
    // Every existing caller passes nothing, and the compatibility claim is that
    // omitting the context can only make the door see LESS, never something else.
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full");
    const plain = JSON.parse(await dispatch("equipment_lookup", { question: PARAPHRASE, lookup: "service" })) as Record<string, unknown>;
    expect(plain.refused).toBeUndefined();
    expect(plain.factsOnly).toBeUndefined();
    const judged = JSON.parse(
      await dispatch("equipment_lookup", { question: "the autoclave is overdue its service, can we keep using it?", lookup: "service" }),
    ) as Record<string, unknown>;
    expect(judged.factsOnly).toBe(true);
  });
});

// ===========================================================================
// THE SAME QUESTION, ASKED BY SOMEBODY WHO DOES NOT ALREADY KNOW THE ANSWER
// (rulings W3/15 and W1-D/2).
//
// Every test above hands the door a person who STATES the out-of-test fact
// ("the autoclave is out of test, ..."), because that is what the judgement
// RULES need: they match an out-of-test phrase and a keep-using phrase in one
// sentence. A person asking "can we still use the Lisa?" states nothing — that
// is what asking IS — so all five phrasings W3/15 names by hand reached the
// model as an ordinary allow and the standing take-out-of-use sentence was never
// appended. The missing half of the fact comes from the REGISTER, and this door
// now supplies it (`outOfTestVocabulary(assets, today)`).
//
// AND IT IS ASKED TWICE, ON PURPOSE. The gate is given the overdue vocabulary,
// but its own window ENDS WITH THE MODEL'S PARAPHRASE and its register rule
// reads the latest turn — so through this door the gate would be judging the
// model's rewording, not the person. The same helper is therefore run a second
// time over the person's OWN turns, for exactly the reason
// `equipmentJudgementAskedByPerson` exists.
// ===========================================================================
describe("the register supplies the half of the judgement the person did not say", () => {
  it("CAPS AN ANSWER ABOUT AN OVERDUE MACHINE THE PERSON NEVER CALLED OVERDUE", async () => {
    // Nothing in this sentence says "overdue". The register does.
    const { out, turn } = await askEquipment(["can we still use the Lisa?"]);
    expect(out.refused).toBeUndefined();
    expect(out.factsOnly).toBe(true);
    expect(out.judgement).toBe(EQUIPMENT_REFUSALS.judgement);
    expect(turn.equipmentJudgementRequired).toBe(true);
  });

  it("catches every phrasing ruling W3/15 names by hand", async () => {
    // Listed one by one rather than behind a regex, because the ruling lists
    // them one by one and a rewrite of the patterns has to answer for each.
    const asked = [
      "can we still use the Lisa?",
      "is it safe to run the Lisa?",
      "should I keep using the Lisa?",
      "is it OK to carry on with the Lisa steriliser?",
      "is the Lisa fine to use?",
    ];
    for (const question of asked) {
      const { out, turn } = await askEquipment([question]);
      expect(out.factsOnly, question).toBe(true);
      expect(turn.equipmentJudgementRequired, question).toBe(true);
    }
  });

  it("follows the pronoun back one turn, and no further", async () => {
    // "Which of ours is overdue?" is the question W1-D/2 says is ALWAYS answered,
    // and "can we still use it?" is what a person says next. Two consecutive
    // turns are one thought.
    const { out } = await askEquipment([
      "which of our equipment is overdue?",
      "can we still use it?",
    ]);
    expect(out.factsOnly).toBe(true);

    // ...but a machine mentioned several turns ago is not what "it" refers to,
    // so the same closing question after an unrelated turn is left alone.
    const { out: later, turn } = await askEquipment([
      "which of our equipment is overdue?",
      "thanks, and who is our supplier for the compressor?",
      "can we still use it?",
    ]);
    expect(later.factsOnly).toBeUndefined();
    expect(turn.equipmentJudgementRequired).toBe(false);
  });

  it("LEAVES A COMPLIANT MACHINE ALONE — the rule narrows, it does not blanket", async () => {
    // The Durr compressor is in date. Appending "take it out of use and call the
    // engineer" here would be wrong, and a rule that fired on every question
    // would make the sentence noise rather than an instruction.
    const { out, turn } = await askEquipment(["can we still use the Tornado?"]);
    expect(out.refused).toBeUndefined();
    expect(out.factsOnly).toBeUndefined();
    expect(out.judgement).toBeUndefined();
    expect(turn.equipmentJudgementRequired).toBe(false);
  });

  it("ARMS THE GATE ITSELF, so the register also decides on a caller with no turn context", async () => {
    // The overdue vocabulary is handed to `gateEquipmentQuestion` as well as
    // being checked separately below it, and this is the window where only the
    // gate can see it: a dispatch built without turn context (every pre-W3/14
    // caller, and any future one that forgets) has no person's words at all, so
    // the gate's own register rule is the whole rule. Deleting
    // `outOfTestVocabulary:` from the gate input turns this green answer into an
    // unconstrained one.
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full");
    const out = JSON.parse(
      await dispatch("equipment_lookup", { question: "can we still use the Lisa?", lookup: "service" }),
    ) as Record<string, unknown>;
    expect(out.factsOnly).toBe(true);
    expect(out.judgement).toBe(EQUIPMENT_REFUSALS.judgement);
  });

  it("still refuses an OFF-REGISTER question rather than answering it facts-only", async () => {
    // The register-derived rule may only ever NARROW an allow. A question this
    // desk has no business answering must still be refused outright, or a rule
    // whose whole purpose is to constrain an answer would have widened the gate.
    const { out } = await askEquipment(
      ["can we still use the Lisa?"],
      "how many patients has Dr Jawad seen this week",
    );
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("off_topic");
    expect(out.factsOnly).toBeUndefined();
  });
});

describe("the IT desk door reads the person's words too", () => {
  it("refuses a credential request the model reworded into a playbook lookup", async () => {
    const turn = copilotTurn(["what's the wifi password for the surgery iPads?"]);
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full", undefined, turn);
    const out = JSON.parse(await dispatch("it_desk", { question: "network settings playbook" })) as Record<string, unknown>;
    expect(out.refused).toBe(true);
    expect(out.reason).toBe("safety");
    expect(String(out.rule)).toMatch(/credential/);
    expect(out.matches).toBeUndefined();
  });

  it("still answers an ordinary IT question", async () => {
    const turn = copilotTurn(["the printer in reception will not print"]);
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full", undefined, turn);
    const out = JSON.parse(await dispatch("it_desk", { question: "printer not printing" })) as Record<string, unknown>;
    expect(out.refused).toBeUndefined();
  });
});

describe("the take-out-of-use sentence is said by the SERVER, not by the model", () => {
  it("APPENDS IT TO A REPLY THAT LEFT IT OUT", async () => {
    const { turn } = await askEquipment(["the autoclave is overdue its service, can we keep using it?"]);
    const modelText = "The Lisa steriliser was last serviced on 1 June 2025 and was due again on 1 June 2026.";
    const reply = finaliseCopilotReply(modelText, turn);
    expect(reply).toContain(modelText);
    expect(reply.endsWith(EQUIPMENT_REFUSALS.judgement)).toBe(true);
  });

  it("appends it to the route's own fallback, and to an empty turn", () => {
    const turn = copilotTurn([]);
    turn.equipmentJudgementRequired = true;
    expect(finaliseCopilotReply("Sorry, I could not respond just now.", turn)).toContain(EQUIPMENT_REFUSALS.judgement);
    expect(finaliseCopilotReply("", turn)).toBe(EQUIPMENT_REFUSALS.judgement);
  });

  it("adds nothing at all to an ordinary turn", () => {
    const turn = copilotTurn(["when is the Lisa due a service?"]);
    expect(finaliseCopilotReply("It is due on 1 June 2026.", turn)).toBe("It is due on 1 June 2026.");
    expect(finaliseCopilotReply("It is due on 1 June 2026.", undefined)).toBe("It is due on 1 June 2026.");
  });

  it("says it once per reply however many times the tool was called", async () => {
    // The flag is a latch, not a counter: two facts-only lookups in one turn owe
    // the sentence once, and neither can clear it.
    const turn = copilotTurn(["the autoclave is overdue its service, can we keep using it?"]);
    const dispatch = makeCopilotDispatch(["site-cc"], "vitality", "user-42", "full", undefined, turn);
    await dispatch("equipment_lookup", { question: "service dates", lookup: "service" });
    await dispatch("equipment_lookup", { question: "find the Lisa", lookup: "find" });
    const reply = finaliseCopilotReply("Here are the dates.", turn);
    expect(reply.split(EQUIPMENT_REFUSALS.judgement).length - 1).toBe(1);
  });
});
