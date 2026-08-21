import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { triageReply, MEDIA_PLACEHOLDER } from "./triage";

// ===========================================================================
// THE ESCALATION BATTERY.
//
// The hard rule of this module is that the agent TRIAGES and never advises, and
// the whole of that rule rests on one pure function. So this file is deliberately
// lopsided: a wide battery of things that MUST escalate, a short list of things
// that may not, and then a set of MUTATION checks that each delete one gate and
// prove a category of unsafe message would clear without it.
//
// The battery is written as real messages a patient would send, not as tokens.
// A test of `triageReply("pain")` proves the word is in a list; a test of
// "not slept a wink, whole side of my face is up" proves the function is safe.
// ===========================================================================

function escalates(message: string): boolean {
  return triageReply(message).outcome === "escalate";
}

describe("battery 1 — pain, in the words patients actually use", () => {
  const MESSAGES = [
    "in a lot of pain",
    "It's painful",
    "my jaw really hurts",
    "hurting a lot today",
    "still sore",
    "bit of soreness where the tooth was",
    "it aches",
    "aching all night",
    "in agony",
    "throbbing since last night",
    "it's killing me",
    "the pain is excruciating",
    "very tender",
    "really sensitive to cold",
    "stinging when I drink",
    "burning feeling",
    "sharp feeling in the gum",
    "some discomfort",
    "uncomfortable to eat",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => {
    const v = triageReply(m);
    expect(v.outcome).toBe("escalate");
    expect(v.urgent).toBe(true);
  });
});

describe("battery 2 — swelling", () => {
  const MESSAGES = [
    "my face is swollen",
    "there's some swelling",
    "cheek has swelled up",
    "my face is puffy",
    "the whole side has ballooned",
    "gum looks inflamed",
    "there's a lump",
    "small bump next to it",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));
});

describe("battery 3 — bleeding", () => {
  const MESSAGES = [
    "it's bleeding",
    "bled all night",
    "there's blood on the pillow",
    "a bit bloody still",
    "the clot came out",
    "it's oozing",
    "seeping a bit",
    "the socket looks odd",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));
});

describe("battery 4 — numbness", () => {
  const MESSAGES = [
    "my lip is still numb",
    "numbness in my chin",
    "tingling in my lip",
    "pins and needles down one side",
    "I can't feel my lip",
    "cant feel the left side",
    "no feeling in my chin",
    "still frozen from the injection",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));
});

describe("battery 5 — fever and infection", () => {
  const MESSAGES = [
    "I've got a fever",
    "feeling feverish",
    "my temperature is up",
    "got the chills",
    "shivering",
    "sweating a lot",
    "feeling unwell",
    "a bit poorly",
    "feel sick",
    "nauseous this morning",
    "been vomiting",
    "I think it's infected",
    "looks like an infection",
    "there's pus",
    "might be an abscess",
    "it smells bad",
    "horrible taste in my mouth",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));
});

describe('battery 6 — "is this normal", the reply this module exists for', () => {
  const MESSAGES = [
    "is this normal?",
    "Is this normal",
    "is that normal",
    "is it normal to still be like this",
    "just wondering if this is normal",
    "should I be worried",
    "should i take anything",
    "can I eat solid food yet",
    "how long does it take",
    "how much longer",
    "what should I do",
    "when can I brush it",
    "why is it still like this",
    "quick question about the tooth",
    "any advice",
    "wondered if I should come in",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));

  it("names the reason `question`, so the task says what the patient wants", () => {
    expect(triageReply("is this normal?").reason).toBe("question");
    expect(triageReply("how long does it take").reason).toBe("question");
    // "should I be worried" carries BOTH signals and is labelled `distress`,
    // because the distress gate runs first. Either label is correct and both are
    // urgent; the ordering is chosen so the stronger word wins the label.
    expect(triageReply("should I be worried").reason).toBe("distress");
  });

  it("escalates a bare question mark even attached to cheerful words", () => {
    expect(triageReply("all good thanks, ok to eat?").outcome).toBe("escalate");
  });
});

describe("battery 7 — medication questions are never answered", () => {
  const MESSAGES = [
    "can I take painkillers",
    "how much ibuprofen",
    "is paracetamol ok",
    "I've run out of antibiotics",
    "do I need amoxicillin",
    "which tablets should I take",
    "what dosage",
    "should I use mouthwash",
    "is salt water ok",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));
});

describe("battery 8 — non-English replies", () => {
  it.each([
    ["Arabic", "ألم شديد"],
    ["Bengali", "খুব ব্যথা"],
    ["Polish (Latin script)", "bardzo boli"],
    ["Italian (Latin script)", "mi fa molto male"],
    ["Romanian (Latin script)", "ma doare foarte tare"],
    ["Turkish (Latin script)", "cok agriyor"],
    ["Urdu", "بہت درد ہے"],
    ["Russian", "очень больно"],
    ["Chinese", "很疼"],
    ["Somali (Latin script)", "aad ayey u xanuunaysaa"],
    ["Spanish, sounding positive", "todo bien gracias"],
    ["French, sounding positive", "tout va bien merci"],
  ])("escalates %s: %s", (_lang, m) => {
    const v = triageReply(m);
    expect(v.outcome).toBe("escalate");
  });

  it("labels a non-Latin script `unreadable` rather than guessing at it", () => {
    expect(triageReply("очень больно").reason).toBe("unreadable");
    expect(triageReply("很疼").reason).toBe("unreadable");
  });

  it("labels a MIXED-script reply unreadable too, which the allow-list alone would not", () => {
    // "hi очень больно" has Latin letters, so the "is there any Latin here at all"
    // branch does not fire. Only the explicit foreign-script check labels it
    // `unreadable`; without that check the allow-list still escalates it, but as
    // `ambiguous`, and the person picking up the task is not told that the patient
    // wrote to us in a language nobody here read. Both escalate — this gate buys
    // the LABEL, and the label is what gets an interpreter on the call.
    expect(triageReply("hi очень больно").reason).toBe("unreadable");
    expect(triageReply("all good спасибо").reason).toBe("unreadable");
  });

  it("labels a Latin-script language we do not speak `ambiguous`, not all-clear", () => {
    // The allow-list is what catches these: no deny-list contains "boli".
    expect(triageReply("bardzo boli").reason).toBe("ambiguous");
    // And a POSITIVE-sounding foreign reply is still not an all-clear. This is the
    // case a deny-list of symptom words gets catastrophically wrong.
    expect(triageReply("todo bien gracias").outcome).toBe("escalate");
  });
});

describe("battery 9 — emoji", () => {
  it.each(["😭", "😢😢", "🤒", "🤕", "😰", "😫", "🥵", "🤢", "🩸", "🚑", "😞", "👎"])(
    "escalates a distress emoji on its own: %s",
    (m) => {
      const v = triageReply(m);
      expect(v.outcome).toBe("escalate");
      expect(v.reason).toBe("distress");
    },
  );

  it("escalates a distress emoji even inside otherwise cheerful words", () => {
    const v = triageReply("all good thanks 😭");
    expect(v.outcome).toBe("escalate");
    expect(v.reason).toBe("distress");
  });

  it.each(["🙂", "🎉", "🤷", "❓", "...", "?!"])(
    "escalates an emoji-only or punctuation-only reply we cannot read: %s",
    (m) => expect(escalates(m)).toBe(true),
  );

  it("does allow the small set of unambiguously positive emoji alongside words", () => {
    expect(triageReply("all good thanks 👍").outcome).toBe("all_clear");
    expect(triageReply("all fine 😊").outcome).toBe("all_clear");
  });

  it("does NOT allow the ambiguous ones: 🙏 could be thanks or please help", () => {
    expect(triageReply("all good 🙏").outcome).toBe("escalate");
    expect(triageReply("fine 💪").outcome).toBe("escalate");
  });
});

describe("battery 10 — ambiguity, negation and distress without a symptom word", () => {
  const MESSAGES = [
    "not great",
    "not good",
    "not the best",
    "no better",
    "not any better",
    "worse than yesterday",
    "getting worse",
    "terrible night",
    "it was awful",
    "pretty rough",
    "a bit worried",
    "I'm concerned",
    "scared to be honest",
    "need help",
    "is it urgent",
    "went to a&e",
    "rang 111",
    "not happy at all",
    "something's not right",
    "ok I suppose",
    "meh",
    "so so",
    "up and down",
    "could be better",
    "早",
    "yeah",
    "hi",
    "thanks",
    "k",
    "?",
  ];
  it.each(MESSAGES)("escalates: %s", (m) => expect(escalates(m)).toBe(true));

  it("escalates an empty or whitespace-only reply", () => {
    expect(triageReply("").reason).toBe("unreadable");
    expect(triageReply("   ").reason).toBe("unreadable");
    expect(triageReply("\n\t").reason).toBe("unreadable");
  });

  it("escalates the reply that a symptom deny-list would miss entirely", () => {
    // Not one of these contains a word from any symptom list. They escalate
    // because the ALLOW-LIST did not recognise them, which is the whole design.
    for (const m of [
      "not slept a wink",
      "whole side of my face is up",
      "cant get my mouth round a spoon",
      "been up since three",
      "my wife says it looks angry",
      "had to come home from work",
    ]) {
      expect(escalates(m), m).toBe(true);
    }
  });
});

describe("battery 11 — media", () => {
  it("escalates a photo, before anything else is even considered", () => {
    const v = triageReply(MEDIA_PLACEHOLDER);
    expect(v.outcome).toBe("escalate");
    expect(v.reason).toBe("media");
  });

  it("escalates a photo sent alongside an all-clear", () => {
    expect(triageReply(`all good thanks ${MEDIA_PLACEHOLDER}`).reason).toBe("media");
  });
});

describe("battery 12 — length", () => {
  it("escalates anything longer than an all-clear can be", () => {
    const long =
      "all good thanks so much everyone at the practice you were all lovely and " +
      "very kind and I will definitely be recommending you to my friends and family";
    const v = triageReply(long);
    expect(v.outcome).toBe("escalate");
    expect(v.reason).toBe("too_long");
  });
});

describe("battery 13 — evasion", () => {
  it("sees through zero-width characters inserted between letters", () => {
    // "pain" with zero-width non-joiners. Reads as "pain" to a human and would
    // defeat a word-boundary pattern if it were not stripped first.
    // "pain", with a U+200C zero-width non-joiner between every pair of letters.
    expect(escalates("p\u200ca\u200ci\u200cn")).toBe(true);
    // ...and with U+200B zero-width spaces, which is the other common form.
    expect(triageReply("p\u200bai\u200bn").reason).toBe("symptom");
  });

  it("sees through mixed case and stray punctuation", () => {
    expect(escalates("PAIN!!!")).toBe(true);
    expect(escalates("S.W.O.L.L.E.N")).toBe(true);
    expect(escalates("Bleeding.")).toBe(true);
  });

  it("is not fooled by an all-clear with a symptom appended", () => {
    expect(escalates("all good thanks, just a bit of bleeding")).toBe(true);
    expect(escalates("fine, mouth is sore though")).toBe(true);
  });

  it("is not fooled by C1 controls, which JS \\s does not treat as whitespace", () => {
    expect(escalates("pain\u0085swelling")).toBe(true);
  });
});

// ===========================================================================
// THE SHORT LIST: what may clear. Nothing else in this file is allowed to.
// ===========================================================================

describe("the only replies that clear", () => {
  const ALL_CLEAR = [
    "all good",
    "All good thanks",
    "all good thank you",
    "fine thanks",
    "I'm fine",
    "im fine thanks",
    "I’m fine thanks", // curly apostrophe, which every iPhone sends
    "all fine",
    "ok thanks",
    "okay thank you",
    "yes all good",
    "good thanks",
    "healing well thanks",
    "all healing nicely",
    "everything is fine",
    "all sorted thanks",
    "no problems thanks",
    "no issues at all",
    "all settled thanks",
    "alright thanks",
  ];
  it.each(ALL_CLEAR)("clears: %s", (m) => {
    const v = triageReply(m);
    expect(v.outcome).toBe("all_clear");
    expect(v.reason).toBeNull();
    expect(v.urgent).toBe(false);
  });
});

describe("the stated cost: this over-escalates, and that is the trade", () => {
  it("escalates a NEGATED symptom, because it will not parse negation", () => {
    // A patient who is completely fine gets a phone call. Of the two available
    // errors, this is the cheap one.
    expect(escalates("no pain at all thanks")).toBe(true);
    expect(escalates("no swelling, all good")).toBe(true);
    expect(escalates("no bleeding thanks")).toBe(true);
  });

  it('escalates "much better", because better implies there was something to be better than', () => {
    expect(escalates("much better thanks")).toBe(true);
    expect(escalates("loads better")).toBe(true);
  });

  it("escalates a booking request that arrives inside the reply window", () => {
    // A cost, stated: this one would otherwise have been handled by the booking
    // agent. Someone recovering from surgery who raises an appointment gets a
    // person instead, and the person can still book it.
    expect(escalates("can I book my next appointment")).toBe(true);
  });
});

// ===========================================================================
// MUTATION CHECKS. Each one deletes a gate and names what would then clear.
// These are the assertions that stop a future "simplification" opening a hole.
// ===========================================================================

const SRC = readFileSync(fileURLToPath(new URL("./triage.ts", import.meta.url)), "utf8");

describe("mutation — remove a gate and an unsafe category clears", () => {
  it("GATE 7 (the allow-list) is what makes it fail safe, not the deny-lists", () => {
    // These messages match NO deny-list pattern. If the allow-list were removed and
    // the function fell through to "no symptom found -> clear", every one of them
    // would be handed to the booking agent. They are the proof that the polarity,
    // not the vocabulary, is the safety property.
    const CAUGHT_ONLY_BY_THE_ALLOW_LIST = [
      "not slept a wink",
      "whole side of my face is up",
      "bardzo boli",
      "todo bien gracias",
      "my wife says it looks angry",
      "meh",
      "so so",
    ];
    for (const m of CAUGHT_ONLY_BY_THE_ALLOW_LIST) {
      expect(triageReply(m).reason, m).toBe("ambiguous");
    }
  });

  it("GATE 6 (questions) is load-bearing: these carry no symptom word at all", () => {
    expect(triageReply("is this normal?").reason).toBe("question");
    expect(triageReply("how long does it take").reason).toBe("question");
    expect(triageReply("can I eat solid food yet").reason).toBe("question");
    expect(triageReply("when can I brush it").reason).toBe("question");
  });

  it("GATE 3 (length) is load-bearing: a long reply of benign words alone", () => {
    // Every word here is on the allow-list. Only the length gate stops it clearing,
    // and a patient who writes this much is telling us something.
    const wordy =
      "hi all good all good all good thanks thanks thanks very much everyone " +
      "so good so fine all fine yes yes all good thank you thank you";
    expect(triageReply(wordy).reason).toBe("too_long");
  });

  it("GATE 2 (distress emoji) is load-bearing: the words are otherwise clean", () => {
    expect(triageReply("all good 😭").reason).toBe("distress");
  });

  it("GATE 1 (script) is load-bearing: no deny-list contains Cyrillic", () => {
    expect(triageReply("очень больно").reason).toBe("unreadable");
  });

  it("GATE 0 (media) runs FIRST, so a photo is never argued out of", () => {
    // Ordering matters: if media were checked after the allow-list, a photo sent
    // with "all good thanks" would clear and nobody would look at the picture.
    expect(triageReply(`all good thanks ${MEDIA_PLACEHOLDER}`).reason).toBe("media");
  });

  it("the POSITIVE-CORE requirement is load-bearing: filler alone must not clear", () => {
    // Every token here is on the filler list. Without the "at least one positive"
    // rule, a bare "thanks" or "yeah" would close a post-op check.
    for (const m of ["thanks", "yeah", "yes", "hi", "thank you", "cheers", "x"]) {
      expect(triageReply(m).reason, m).toBe("ambiguous");
    }
  });
});

describe("mutation — the shape of the code itself", () => {
  it("every return but one is an escalation, and the all-clear is last", () => {
    // A structural read of the function: `escalate(` appears many times, the
    // all_clear literal exactly once, and it is the final return. If a future edit
    // adds a second all-clear exit it lands here first.
    const allClearExits = [...SRC.matchAll(/outcome:\s*"all_clear"/g)];
    expect(allClearExits, "there must be exactly ONE way out of this function that clears").toHaveLength(1);
    const escalations = [...SRC.matchAll(/return escalate\(/g)];
    expect(escalations.length).toBeGreaterThan(6);
    expect(SRC.lastIndexOf('outcome: "all_clear"')).toBeGreaterThan(SRC.lastIndexOf("return escalate("));
  });

  it("every escalation is urgent: there is no severity grading anywhere", () => {
    // `urgent: true` is written once, in the escalate() helper, so no call site can
    // decide a symptom is not urgent enough. A second literal would mean somebody
    // has started grading, which is the clinical judgement this module refuses.
    expect([...SRC.matchAll(/urgent:\s*true/g)]).toHaveLength(1);
  });

  it("the module produces no patient-facing text of its own", () => {
    // No template literal, no sentence, nothing that could become a reply. The two
    // fixed sentences live in copy.ts and are selected by the verdict, never
    // composed here.
    expect(SRC).not.toMatch(/reply\s*[:=]\s*"/);
    expect(SRC).not.toMatch(/\bsendMessage\b/);
    expect(SRC).not.toMatch(/\bAnthropic\b/);
  });
});
