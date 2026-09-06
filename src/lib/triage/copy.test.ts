import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { INTEREST_TREATMENTS, TRIAGE_BANK } from "./bank";
import {
  MAX_CHARS,
  TRIAGE_PUBLIC_COPY,
  URGENT_HELP_THRESHOLD,
  checkTriageMessage,
  previsitBody,
  projectTriageFacts,
  urgentHelpLine,
} from "./copy";
import { FORBIDDEN_PATIENT_WORDS, symptomTermIn } from "./forbidden";
import { SMS_GSM7_SINGLE, SMS_UCS2_SINGLE, firstNonGsm7, gsm7LengthUnits, isGsm7, smsCost } from "./sms-cost";
import { projectBank } from "./project";
import { PreVisitDone, PreVisitFormView, hasUrgentScore, outstandingCount } from "@/components/previsit/previsit-form";

// ===========================================================================
// EVERY WORD A PATIENT READS, CRAWLED.
//
// THE CRAWL IS OVER RENDERED MARKUP, NOT OVER THE SOURCE, and that is the whole
// strength of it. A source crawl proves things about string literals in the files
// somebody remembered to list; rendering the real component with the real banks
// proves things about what a patient actually sees, including a word typed
// straight into the JSX and including anything the projection let through.
//
// The rule (PRODUCT.md, and section 0 item 7 of the programme charter): patient-
// facing copy never says NHS or private, in any agent, form or message. This
// module is the sharpest case in the platform, because the whole design turns on
// a fork that IS the NHS-vs-private distinction — and the patient must not be
// able to tell.
// ===========================================================================

/** Every string in a nested value, flattened. Functions are called with a number. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "function") out.push(String((value as (n: number) => string)(2)));
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

function assertClean(text: string, where: string): void {
  for (const re of FORBIDDEN_PATIENT_WORDS) {
    expect(re.test(text), `${where} contains a funding word matching ${re}: "${text.slice(0, 120)}"`).toBe(false);
  }
}

const FACTS = { firstName: "Alex", practiceName: "N15 Vitality Dental", link: "https://x.co/pv/abcdefghijklmnopqrstuv" };

describe("no funding words reach a patient", () => {
  it("not in any question, help line or option label in the bank", () => {
    // PATIENT-FACING FIELDS ONLY: label, help, and option labels. `ownerNote` is
    // excluded BY NAME because it is rendered in the owner's editor and never to a
    // patient, so it may name a funding regime — and the anxiety question's note
    // does, deliberately.
    //
    // Excluding a field from the crawl is exactly how a crawl gets quietly
    // weakened, so the exclusion is paid for by the two tests below, which prove
    // the note reaches the editor and never reaches the form. Without those, this
    // line would be a hole rather than a distinction.
    const strings = TRIAGE_BANK.flatMap((q) => [
      q.label,
      q.help ?? "",
      ...(q.options ?? []).map((o) => o.label),
    ]);
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings) assertClean(s, "the question bank");
  });

  it("the owner-facing note NEVER reaches the patient's screen, on either bank", () => {
    // The other half of the exclusion above. The note exists, it names a funding
    // regime, and the form must not render it.
    const notes = TRIAGE_BANK.map((q) => q.ownerNote).filter((n): n is string => Boolean(n));
    expect(notes.length, "no ownerNote exists, so this test proves nothing").toBeGreaterThan(0);
    for (const fork of ["full", "brief"] as const) {
      // Rendered from a config that has EVERY question switched on, so a note
      // cannot escape the check by belonging to a question the default omits.
      const bank = projectBank(fork, {
        enabledKeys: TRIAGE_BANK.map((q) => q.key),
        required: {},
        custom: [],
      });
      const markup = renderToStaticMarkup(
        createElement(PreVisitFormView, {
          practiceName: FACTS.practiceName,
          questions: bank.questions,
          interest: INTEREST_TREATMENTS,
          answers: {},
          interestAnswers: {},
          status: "idle" as const,
          error: null,
          outstanding: 0,
          practicePhone: null,
          onAnswer: () => {},
          onInterest: () => {},
          onSubmit: () => {},
        }),
      );
      for (const note of notes) {
        expect(markup, `an owner note leaked to the ${fork} form`).not.toContain(note.slice(0, 40));
      }
      assertClean(markup, `the ${fork} form with every question enabled`);
    }
  });

  it("not in the interest grid", () => {
    for (const s of stringsIn(INTEREST_TREATMENTS)) assertClean(s, "the interest grid");
  });

  it("no SYMPTOM word in the interest grid either, which the short bank shows too", () => {
    // THE HOLE THIS CLOSES. `projectBank`/`admit` is where the NHS symptom fork
    // lives, and W3/3 widened it to every string a QUESTION puts in front of a
    // patient. The interest question (bank.ts) carries no `options`: the four
    // rows a patient actually reads are INTEREST_TREATMENTS, passed from
    // src/app/pv/[token]/page.tsx straight to the form and printed at
    // previsit-form.tsx as {t.label} / {t.blurb}. So `admit` never sees them,
    // and they render on the SHORT bank — the fork whose entire purpose is to
    // keep symptom framing away from a patient whose plan makes the asking an
    // obligation. `assertClean` above and the rendered-markup crawls below all
    // loop FORBIDDEN_PATIENT_WORDS, the FUNDING list, only; nothing in the tree
    // applied FORBIDDEN_IN_BRIEF to these four rows. They clear it today by
    // hand-authorship ("a tooth that isn't there any more" is written the way it
    // is precisely because "missing tooth" is on the list), and hand-authorship
    // is not a guard — this module's own bank.ts says so.
    //
    // LABEL AND BLURB SPECIFICALLY, not stringsIn(): `catalogueKeys` are lookup
    // keys matched against Dentally's treatment names and are never rendered, so
    // a future ["denture"] key would fail this for a word no patient can read.
    expect(INTEREST_TREATMENTS.length, "an empty grid proves nothing").toBeGreaterThan(3);
    for (const t of INTEREST_TREATMENTS) {
      expect(symptomTermIn(t.label), `interest row "${t.key}" label`).toBeNull();
      expect(symptomTermIn(t.blurb), `interest row "${t.key}" blurb`).toBeNull();
    }
    // GUARDS THE GUARD: the same check, on the phrasing this rule exists to
    // catch. Without this line a broken symptomTermIn would pass the loop above.
    expect(symptomTermIn("A fixed replacement for a missing tooth.")).toBe("missing tooth");
  });

  it("not in any screen string the public form can show", () => {
    for (const s of stringsIn(TRIAGE_PUBLIC_COPY)) assertClean(s, "TRIAGE_PUBLIC_COPY");
  });

  it("not in the outbound message", () => {
    assertClean(previsitBody(FACTS), "the outbound message");
  });

  // THE CRAWL THAT MATTERS: the rendered page, for BOTH forks, in every state.
  it.each(["full", "brief"] as const)("not in the RENDERED form for the %s bank", (fork) => {
    const bank = projectBank(fork, null);
    const markup = renderToStaticMarkup(
      createElement(PreVisitFormView, {
        practiceName: FACTS.practiceName,
        questions: bank.questions,
        interest: INTEREST_TREATMENTS,
        answers: {},
        interestAnswers: {},
        status: "idle" as const,
        error: null,
        outstanding: 3,
        practicePhone: null,
        onAnswer: () => {},
        onInterest: () => {},
        onSubmit: () => {},
      }),
    );
    expect(markup.length).toBeGreaterThan(500);
    assertClean(markup, `the rendered ${fork} form`);
  });

  it("not on the error screen or the thank-you screen", () => {
    const bank = projectBank("brief", null);
    const errored = renderToStaticMarkup(
      createElement(PreVisitFormView, {
        practiceName: FACTS.practiceName,
        questions: bank.questions,
        interest: INTEREST_TREATMENTS,
        answers: {},
        interestAnswers: {},
        status: "error" as const,
        error: TRIAGE_PUBLIC_COPY.saveFailed,
        outstanding: 0,
        practicePhone: null,
        onAnswer: () => {},
        onInterest: () => {},
        onSubmit: () => {},
      }),
    );
    assertClean(errored, "the error screen");
    const doneProps = { questions: [], answers: {}, practicePhone: null };
    assertClean(
      renderToStaticMarkup(createElement(PreVisitDone, { medicalLink: null, ...doneProps })),
      "the thank-you screen",
    );
    assertClean(
      renderToStaticMarkup(createElement(PreVisitDone, { medicalLink: "https://x.co/mh/tok", ...doneProps })),
      "the thank-you screen with the health-form handover",
    );
  });

  // THE OTHER HALF OF THE RULE. Not naming the regime is not enough: the patient
  // must not be able to INFER that they were given a different list. So no screen
  // may explain why this form is the length it is.
  it("the form never explains why this patient got these questions", () => {
    for (const fork of ["full", "brief"] as const) {
      const bank = projectBank(fork, null);
      const markup = renderToStaticMarkup(
        createElement(PreVisitFormView, {
          practiceName: FACTS.practiceName,
          questions: bank.questions,
          interest: INTEREST_TREATMENTS,
          answers: {},
          interestAnswers: {},
          status: "idle" as const,
          error: null,
          outstanding: 0,
          practicePhone: null,
          onAnswer: () => {},
          onInterest: () => {},
          onSubmit: () => {},
        }),
      );
      for (const tell of [/shorter/i, /shorter list/i, /because/i, /your plan/i, /how you are seen/i, /full list/i]) {
        expect(tell.test(markup), `the ${fork} form hints at the fork via ${tell}`).toBe(false);
      }
    }
    // And the two headings are the SAME string, so the tab title cannot give it away.
    expect(TRIAGE_PUBLIC_COPY.heading).toBe("Before your visit");
  });

  it("the crawl is real: a planted funding word IS caught", () => {
    // Guards the guard. Without this, a broken assertClean would let every test
    // above pass while proving nothing.
    expect(() => assertClean("Are you an NHS patient?", "planted")).toThrow();
    expect(() => assertClean("private treatment prices", "planted")).toThrow();
  });
});

/** The shipped message at the real origin, real token length and real site name. */
function REAL_BODY(firstName: string): string {
  return previsitBody({
    firstName,
    practiceName: "N15 Vitality Dental",
    link: "https://azen-vitality.vercel.app/pv/AbCdEfGhIjKlMnOpQrStUv",
  });
}

describe("the outbound message", () => {
  it("passes its own compliance scan", () => {
    const scan = checkTriageMessage(previsitBody(FACTS), { firstName: FACTS.firstName });
    expect(scan, JSON.stringify(scan)).toEqual({ ok: true });
  });

  // ONE SMS CREDIT, and it is asserted at a REALISTIC origin rather than at a
  // toy one: the token is exactly the 22 characters link.ts mints, and the
  // practice name is the longest of the three real sites.
  //
  // AND IT IS ASSERTED IN SEGMENTS, NOT IN `body.length`. The old form of this
  // test measured the same encoding-blind way the code did, so it could not fail
  // for the reason it is named after. It now asks the carrier's question.
  it("fits one SMS credit with a real link and the longest practice name", () => {
    const body = REAL_BODY("Christopher");
    expect(gsm7LengthUnits(body), `the message is ${gsm7LengthUnits(body)} septets: ${body}`).toBeLessThanOrEqual(
      MAX_CHARS,
    );
    expect(MAX_CHARS).toBe(160);
    const cost = smsCost(body);
    expect(cost.encoding).toBe("gsm7");
    expect(cost.segments, `${body} costs ${cost.segments} credits`).toBe(1);
  });

  it("names the practice, so a patient knows who is texting", () => {
    expect(previsitBody(FACTS)).toContain(FACTS.practiceName);
  });

  it("refuses to compose at all when a fact is missing, rather than leaving a gap", () => {
    expect(projectTriageFacts({ patientName: "", practiceName: "X", link: "l" })).toMatchObject({ ok: false });
    expect(projectTriageFacts({ patientName: "Alex Berry", practiceName: "", link: "l" })).toMatchObject({ ok: false });
    // A MISSING LINK is its own refusal: a message asking the patient to tap
    // nothing is worse than no message.
    const noLink = projectTriageFacts({ patientName: "Alex Berry", practiceName: "X", link: null });
    expect(noLink.ok).toBe(false);
    expect(noLink.ok === false && noLink.missing).toContain("link");
  });

  it("refuses a name that is a payload rather than a name", () => {
    for (const name of ["A", "0123456789012345678901234567890123456789012", "1234", "Al\u0000ex"]) {
      expect(
        projectTriageFacts({ patientName: name, practiceName: "X", link: "l" }).ok,
        `"${JSON.stringify(name)}" was accepted as a first name`,
      ).toBe(false);
    }
    // A name with WHITESPACE in it is fine: the first token is the first name, so
    // "Alex Berry" and a stray newline both yield "Alex". That is the intended
    // behaviour and not a hole — a separator cannot introduce structure into the
    // message body because it never reaches the token.
    expect(projectTriageFacts({ patientName: "Alex\nBerry", practiceName: "X", link: "l" })).toMatchObject({
      ok: true,
      facts: { firstName: "Alex" },
    });
  });
});

// ---------------------------------------------------------------------------
// WHAT THE MESSAGE COSTS, IN THE UNIT THE CARRIER BILLS IN.
//
// The one-credit contract used to be checked with `body.length`, and the test
// that guarded it used "Christopher" — the same encoding-blind measure as the
// code, on a fixture that could not expose the hole. A single letter GSM 03.38
// cannot carry pushes the whole body into UCS-2, where one segment is 70 units
// rather than 160, so a ~140-character message becomes two or three credits with
// nothing on screen or in the tree counting them.
// ---------------------------------------------------------------------------
describe("what an SMS actually costs", () => {
  it("counts a plain ASCII body as GSM-7 at one septet a character", () => {
    const cost = smsCost("Hi Alex, N15 here.");
    expect(cost).toEqual({ encoding: "gsm7", units: 18, segments: 1, forcedUcs2By: null });
  });

  // THE ESCAPE TABLE. These nine characters are transmitted as ESC + the code
  // point, so the wire charges two for each and `body.length` charged one.
  it("charges TWO septets for an escape-table character, as the wire does", () => {
    for (const ch of ["^", "{", "}", "\\", "[", "~", "]", "|", "€"]) {
      expect(smsCost(ch), `"${ch}" was not charged as an escape-table character`).toMatchObject({
        encoding: "gsm7",
        units: 2,
        segments: 1,
      });
    }
    // 160 characters with one `[` among them is 161 septets: two segments, and
    // the old measure called it one.
    const body = `${"a".repeat(159)}[`;
    expect(body.length).toBe(160);
    expect(smsCost(body)).toMatchObject({ encoding: "gsm7", units: 161, segments: 2 });
  });

  it("keeps the accented letters GSM-7 DOES carry on one credit", () => {
    // é, ü, ö, ä, à, ñ, è, ì, ò, ù, Ç, Ø, Å, Æ, ß, É are all in the default
    // alphabet, so José and Gül cost exactly what Alex costs. Only the letters
    // outside it are the problem, and naming the difference is the point.
    for (const name of ["José", "Gül", "Renée", "Åsa", "Günther"]) {
      const cost = smsCost(REAL_BODY(name));
      expect(cost.encoding, `${name} was pushed out of GSM-7`).toBe("gsm7");
      expect(cost.segments, `${name} costs ${cost.segments} credits`).toBe(1);
    }
    // THE ALPHABET IS NOT SYMMETRIC, and this is the trap in reading it off a
    // guess: GSM 03.38 carries Ç at 0x09 and has no lowercase ç at all. So
    // "Françoise" is three credits and "José" is one, and only a real table
    // tells you which. This assertion exists so nobody "tidies" the table.
    expect(isGsm7("Ç")).toBe(true);
    expect(isGsm7("ç")).toBe(false);
    expect(smsCost(REAL_BODY("Françoise")).encoding).toBe("ucs2");
  });

  // THE DEFECT, NAMED. These are ordinary first names on a north London list of
  // 51,000 patients, copied verbatim out of the Dentally record.
  it("a first name outside GSM-7 costs the practice two or three credits, not one", () => {
    const cases: Array<[string, number]> = [
      ["Siân", 2],
      ["Małgorzata", 3],
      ["Ionuț", 3],
      ["Nguyễn", 3],
    ];
    for (const [name, segments] of cases) {
      const body = REAL_BODY(name);
      const cost = smsCost(body);
      expect(cost.encoding, `${name} should force UCS-2`).toBe("ucs2");
      expect(cost.segments, `${name}: ${body.length} units, ${cost.segments} segments`).toBe(segments);
      // …and the module says WHICH character did it, so a report is not a mystery.
      expect(cost.forcedUcs2By).not.toBeNull();
      expect(body).toContain(cost.forcedUcs2By as string);
    }
  });

  // THE RULING THIS FILE MAY NOT MAKE ON ITS OWN. Refusing would mean the
  // practice never texts a patient because of how their name is spelled.
  it("does NOT refuse a body for costing more than one credit", () => {
    const body = REAL_BODY("Małgorzata");
    expect(smsCost(body).segments).toBeGreaterThan(1);
    expect(checkTriageMessage(body, { firstName: "Małgorzata" })).toEqual({ ok: true });
  });

  it("still refuses a body that is genuinely over the septet ceiling", () => {
    const scan = checkTriageMessage(`Hi Alex, ${"N15 ".repeat(50)}here: link`, { firstName: "Alex" });
    expect(scan).toMatchObject({ ok: false, category: "too_long" });
  });

  // THE CEILING IS MEASURED IN SEPTETS, WHICH IS THE HALF `body.length` GOT
  // WRONG WITHOUT BEING ABOUT ALPHABETS AT ALL. 160 characters holding one
  // escape-table character is 161 septets: two segments the practice pays for,
  // and the old measure certified it as one credit.
  it("refuses 160 characters that are 161 septets, because an escape-table character costs two", () => {
    const body = `Hi Alex, N15 here: link ${"a".repeat(135)}[`;
    expect(body.length, "the fixture is not 160 characters").toBe(160);
    expect(gsm7LengthUnits(body)).toBe(161);
    expect(smsCost(body).segments).toBe(2);
    expect(checkTriageMessage(body, { firstName: "Alex" })).toMatchObject({
      ok: false,
      category: "too_long",
      matched: "161 chars",
    });
    // …and the same body one character shorter, with no escape, is accepted.
    expect(checkTriageMessage(`Hi Alex, N15 here: link ${"a".repeat(135)}a`, { firstName: "Alex" })).toEqual({
      ok: true,
    });
  });

  it("names the ceilings the carrier uses rather than a rounded guess", () => {
    expect(SMS_GSM7_SINGLE).toBe(160);
    expect(SMS_UCS2_SINGLE).toBe(70);
    // A UCS-2 body of exactly 70 units is one segment; 71 is two.
    expect(smsCost(`ł${"a".repeat(69)}`).segments).toBe(1);
    expect(smsCost(`ł${"a".repeat(70)}`).segments).toBe(2);
  });

  it("knows which characters GSM-7 carries and which it does not", () => {
    expect(isGsm7("Hi Alex, N15 Vitality Dental here.")).toBe(true);
    expect(isGsm7("José")).toBe(true);
    expect(isGsm7("Małgorzata")).toBe(false);
    expect(firstNonGsm7("Małgorzata")).toBe("ł");
    expect(firstNonGsm7("Alex")).toBeNull();
    // The curly punctuation a copy edit introduces without anybody noticing.
    for (const ch of ["’", "“", "…", "–"]) {
      expect(isGsm7(ch), `"${ch}" was treated as GSM-7`).toBe(false);
    }
  });
});

describe("the message scan", () => {
  it.each([
    ["urgency", "Hi Alex, N15 here. Urgent: fill this in before your visit: link"],
    ["urgency", "Hi Alex, N15 here. Action required before your visit: link"],
    ["clinical_question", "Hi Alex, N15 here. Any pain before your visit? link"],
    ["clinical_question", "Hi Alex, N15 here. How are your gums? link"],
    ["funding", "Hi Alex, N15 here. NHS patients please fill this in: link"],
    // THE SHARED PLATFORM BACKSTOP, WHICH NOTHING HERE USED TO EXERCISE.
    //
    // `checkTriageMessage` opens by calling `checkAgentReply` (copy.ts), and the
    // header calls funding jargon and clinical advice "the two universal rules".
    // Only the first half of that was ever pinned from this side: this module's
    // own FORBIDDEN_PATIENT_WORDS is a superset of the guardrail's funding list
    // for every practical phrasing, so the row above is caught by `fundingTermIn`
    // whether the shared call runs or not, and this file's own patterns catch
    // clinical QUESTIONS ("any pain?") but no clinical STATEMENT at all.
    //
    // These two rows are the shared call's entire marginal contribution — a
    // treatment recommendation and a safety assurance, both from
    // guardrail.ts's CLINICAL_PATTERNS and from nothing in this module.
    // MUTATION (T64): replace that call with a constant `{ ok: true }` and these
    // two go red while every other row here stays green.
    ["clinical", "Hi Alex, N15 here. You should book a filling: link"],
    ["clinical", "Hi Alex, N15 here. It is completely safe: link"],
    ["placeholder", "Hi Alex, {{practice}} here. Questions before your visit: link"],
    ["em_dash", "Hi Alex, N15 here — questions before your visit: link"],
  ])("refuses %s", (category, body) => {
    const scan = checkTriageMessage(body);
    expect(scan.ok).toBe(false);
    expect(scan.ok === false && scan.category).toBe(category);
  });

  it("refuses a preamble before the greeting", () => {
    const scan = checkTriageMessage("Here is your form. Hi Alex, N15 here: link", { firstName: "Alex" });
    expect(scan.ok === false && scan.category).toBe("preamble");
  });

  it("refuses a body that has grown past one credit", () => {
    const scan = checkTriageMessage(`Hi Alex, ${"N15 ".repeat(50)}here: link`, { firstName: "Alex" });
    expect(scan.ok === false && scan.category).toBe("too_long");
  });

  it("refuses an empty body rather than sending a blank text", () => {
    expect(checkTriageMessage("   ").ok).toBe(false);
  });

  // THE REASON THIS RULE EXISTS, stated as a test. The clinical questions live
  // BEHIND the link, where the server has already decided which bank applies. A
  // symptom question in the SMS bypasses the fork completely: every patient gets
  // it, including every patient on the short list.
  it("a symptom question in the MESSAGE would bypass the fork, and is refused", () => {
    const scan = checkTriageMessage("Hi Alex, N15 Vitality Dental here. Is your tooth sore? link");
    expect(scan.ok).toBe(false);
  });
});

// ===========================================================================
// RULING 3 (3 Sep 2026): a high discomfort score triggers no automatic action, so
// the patient must be told how to get help NOW — on the form the moment they
// score, and again on the way out.
// ===========================================================================
describe("the urgent-help line", () => {
  const FULL = projectBank("full", null);

  function form(answers: Record<string, string>, phone: string | null = null): string {
    return renderToStaticMarkup(
      createElement(PreVisitFormView, {
        practiceName: FACTS.practiceName,
        questions: FULL.questions,
        interest: INTEREST_TREATMENTS,
        answers,
        interestAnswers: {},
        status: "idle" as const,
        error: null,
        outstanding: 0,
        practicePhone: phone,
        onAnswer: () => {},
        onInterest: () => {},
        onSubmit: () => {},
      }),
    );
  }

  const NEEDLE = "call 111 for urgent dental advice";

  it("renders at the threshold and above", () => {
    for (const score of [URGENT_HELP_THRESHOLD, 8, 9, 10]) {
      expect(form({ "pain-now": String(score) }), `score ${score} showed no help line`).toContain(NEEDLE);
    }
  });

  it("does NOT render below the threshold", () => {
    for (const score of [0, 1, 5, URGENT_HELP_THRESHOLD - 1]) {
      expect(form({ "pain-now": String(score) }), `score ${score} showed a help line`).not.toContain(NEEDLE);
    }
    // ...nor when the question has not been answered at all.
    expect(form({})).not.toContain(NEEDLE);
  });

  it("quotes the SITE's number when the practice has supplied one", () => {
    expect(form({ "pain-now": "9" }, "020 8888 1234")).toContain("please call the practice on 020 8888 1234.");
  });

  it("NEVER invents a number: with none on file it drops the clause and keeps 111", () => {
    // Site.publicPhone is null for all three sites today. A guessed number in
    // patient copy is not acceptable, and a patient in pain must still be given a
    // route, so the sentence loses the number and keeps the service.
    const markup = form({ "pain-now": "9" }, null);
    expect(markup).toContain("please call the practice.");
    expect(markup).toContain(NEEDLE);
    expect(markup).not.toContain("null");
    expect(markup).not.toContain("undefined");
  });

  it("says 111, never NHS 111, because the crawl forbids the other word", () => {
    const line = urgentHelpLine("020 8888 1234");
    expect(line).toContain("call 111");
    expect(line).not.toMatch(/NHS/i);
    assertClean(line, "the urgent-help line");
  });

  it("carries no em-dash, which house style forbids in patient copy", () => {
    expect(urgentHelpLine(null)).not.toMatch(/[\u2014\u2013]/);
  });

  it("is announced to assistive technology rather than only coloured", () => {
    expect(form({ "pain-now": "9" })).toContain('role="status"');
  });

  it("appears AGAIN on the completion screen when a high score was given", () => {
    // Driven through the REAL answers, not a pre-set flag: the screen derives the
    // flag itself, so this exercises the derivation rather than a hop the wrapper
    // could break silently.
    const done = renderToStaticMarkup(
      createElement(PreVisitDone, {
        medicalLink: null,
        questions: FULL.questions,
        answers: { "pain-now": "9" },
        practicePhone: null,
      }),
    );
    expect(done).toContain(NEEDLE);
    // "There is nothing more to do" is true about the FORM and is a bad last word
    // to somebody in pain, so it must be qualified rather than left standing alone.
    expect(done.indexOf(TRIAGE_PUBLIC_COPY.doneBody)).toBeLessThan(done.indexOf(NEEDLE));
  });

  it("does NOT appear on the completion screen otherwise", () => {
    const cases: Record<string, string>[] = [{}, { "pain-now": "3" }];
    for (const answers of cases) {
      const done = renderToStaticMarkup(
        createElement(PreVisitDone, { medicalLink: null, questions: FULL.questions, answers, practicePhone: null }),
      );
      expect(done).not.toContain(NEEDLE);
    }
  });

  it("hasUrgentScore reads EVERY scale question, not just the shipped one", () => {
    // A practice can add a scale question of its own, and a high score on it
    // deserves the same sentence.
    const custom = [{ key: "custom-x", label: "How bad?", type: "scale" as const, kind: "symptom" as const, required: false, custom: true }];
    expect(hasUrgentScore(custom, { "custom-x": "9" })).toBe(true);
    expect(hasUrgentScore(custom, { "custom-x": "2" })).toBe(false);
    expect(hasUrgentScore(custom, {})).toBe(false);
    expect(hasUrgentScore(custom, { "custom-x": "not a number" })).toBe(false);
  });

  it("the whole line still passes the patient-facing funding crawl", () => {
    assertClean(form({ "pain-now": "10" }, "020 8888 1234"), "the form showing the urgent-help line");
  });
});

describe("the interest grid is required-but-refusable", () => {
  const bank = projectBank("brief", null);

  it("declining every row IS answering: outstanding falls to zero", () => {
    const answers = Object.fromEntries(
      bank.questions.filter((q) => q.required && q.type !== "interest").map((q) => [q.key, "yes"]),
    );
    const declined = Object.fromEntries(INTEREST_TREATMENTS.map((t) => [t.key, "not_now" as const]));
    expect(outstandingCount(bank.questions, INTEREST_TREATMENTS, answers, declined)).toBe(0);
  });

  it("a PARTLY answered grid is still outstanding, one per unanswered row", () => {
    const answers = Object.fromEntries(
      bank.questions.filter((q) => q.required && q.type !== "interest").map((q) => [q.key, "yes"]),
    );
    expect(
      outstandingCount(bank.questions, INTEREST_TREATMENTS, answers, { whitening: "yes" }),
    ).toBe(INTEREST_TREATMENTS.length - 1);
  });

  it("the refusal is offered on every row, in the rendered form", () => {
    const markup = renderToStaticMarkup(
      createElement(PreVisitFormView, {
        practiceName: FACTS.practiceName,
        questions: bank.questions,
        interest: INTEREST_TREATMENTS,
        answers: {},
        interestAnswers: {},
        status: "idle" as const,
        error: null,
        outstanding: 4,
        practicePhone: null,
        onAnswer: () => {},
        onInterest: () => {},
        onSubmit: () => {},
      }),
    );
    const declines = markup.split(TRIAGE_PUBLIC_COPY.interestDecline).length - 1;
    expect(declines, "every treatment row must offer the refusal").toBe(INTEREST_TREATMENTS.length);
    const accepts = markup.split(TRIAGE_PUBLIC_COPY.interestAccept).length - 1;
    expect(accepts).toBe(INTEREST_TREATMENTS.length);
  });

  it("the refusal is not disadvantaged: both buttons carry the same classes", () => {
    // A layout that made declining harder would be the dishonest way to raise the
    // yes rate, so the equality is pinned rather than left to review.
    const markup = renderToStaticMarkup(
      createElement(PreVisitFormView, {
        practiceName: FACTS.practiceName,
        questions: bank.questions,
        interest: INTEREST_TREATMENTS,
        answers: {},
        interestAnswers: {},
        status: "idle" as const,
        error: null,
        outstanding: 4,
        practicePhone: null,
        onAnswer: () => {},
        onInterest: () => {},
        onSubmit: () => {},
      }),
    );
    const buttons = [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)</g)];
    const accept = buttons.find((m) => m[2].includes(TRIAGE_PUBLIC_COPY.interestAccept));
    const decline = buttons.find((m) => m[2].includes(TRIAGE_PUBLIC_COPY.interestDecline));
    expect(accept).toBeDefined();
    expect(decline).toBeDefined();
    expect(decline?.[1]).toBe(accept?.[1]);
  });

  it("the grid says plainly that a yes commits the patient to nothing", () => {
    expect(TRIAGE_PUBLIC_COPY.interestNote).toMatch(/nothing is booked/i);
    expect(TRIAGE_PUBLIC_COPY.interestNote).toMatch(/nothing is charged/i);
  });
});

// ===========================================================================
// THE ONE LINE OF ORIENTATION HAS TO BE TRUE OF THE FORM UNDER IT.
//
// The crawls above prove what the screen strings must NOT say. Nothing proved
// that they were true, and one of them was not: the intro promised "you can skip
// anything you would rather talk about in person" while four required questions
// held the submit button shut. Ruling W3/9 settles the direction — copy matches
// code, never the reverse — so the sentence changed and this is the join that
// stops the two drifting apart again.
// ===========================================================================
describe("the intro is true of the form it sits above", () => {
  function render(fork: "full" | "brief") {
    const bank = projectBank(fork, null);
    const outstanding = outstandingCount(bank.questions, INTEREST_TREATMENTS, {}, {});
    return {
      bank,
      outstanding,
      markup: renderToStaticMarkup(
        createElement(PreVisitFormView, {
          practiceName: FACTS.practiceName,
          questions: bank.questions,
          interest: INTEREST_TREATMENTS,
          answers: {},
          interestAnswers: {},
          status: "idle" as const,
          error: null,
          outstanding,
          practicePhone: null,
          onAnswer: () => {},
          onInterest: () => {},
          onSubmit: () => {},
        }),
      ),
    };
  }

  it.each(["full", "brief"] as const)("the %s form really does refuse an untouched submit", (fork) => {
    // The premise, stated first, so the assertion below is about something real.
    const { bank, outstanding, markup } = render(fork);
    expect(bank.questions.filter((q) => q.required).length, `${fork} requires nothing`).toBeGreaterThan(0);
    expect(outstanding, `${fork} let an empty form through`).toBeGreaterThan(0);
    expect(markup, `${fork}'s submit button was not disabled`).toContain("disabled=");
  });

  it("the intro never promises a skip the form will not allow", () => {
    // MUTATION: put "you can skip anything you would rather talk about in person"
    // back on TRIAGE_PUBLIC_COPY.intro and this goes red.
    expect(
      /\bskip\b/i.test(TRIAGE_PUBLIC_COPY.intro),
      "the intro offers a skip while required questions hold the submit button shut",
    ).toBe(false);
    // And it still tells the patient which way round it is, rather than saying
    // nothing at all: the few that are needed are named as needed.
    expect(TRIAGE_PUBLIC_COPY.intro).toMatch(/optional/i);
    expect(TRIAGE_PUBLIC_COPY.intro).toMatch(/need/i);
  });

  it("the count line, which is the only explanation a stuck patient gets, still counts", () => {
    // If the intro is going to send somebody to this sentence, the sentence has
    // to agree with the number that disabled the button.
    const { outstanding } = render("full");
    expect(TRIAGE_PUBLIC_COPY.incomplete(outstanding)).toContain(String(outstanding));
    expect(TRIAGE_PUBLIC_COPY.incomplete(1)).toContain("1 question ");
  });
});
