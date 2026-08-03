import { describe, it, expect } from "vitest";
import {
  afterHoursFallbackSms,
  escapeForTwiml,
  inHoursCallbackSms,
  practiceNameFor,
  spokenClosedAlreadyTexted,
  spokenClosedNoText,
  spokenClosedTextSent,
  spokenOpenNoText,
  spokenOpenTextSent,
} from "./callback-copy";
import { checkAgentReply } from "@/lib/agent/guardrail";

// ---------------------------------------------------------------------------
// Everything a caller to the practice line hears or is texted.
//
// Two properties are load-bearing and neither is visible from the route:
//   1. the practice is NAMED (a text from an unknown number that does not say
//      who it is from reads as spam, and is ignored);
//   2. no line carries NHS / private / funding wording (project rule, every
//      patient-facing agent), mirroring the sweep in
//      src/app/api/webhooks/twilio/voice/area11-12-after-hours-voice.test.ts.
// ---------------------------------------------------------------------------

const PRACTICE = "Test Dental";

/** Every patient-facing line this module can produce, named. */
const LINES: [string, string][] = [
  ["spokenOpenNoText", spokenOpenNoText(PRACTICE)],
  ["spokenOpenTextSent", spokenOpenTextSent(PRACTICE)],
  ["spokenClosedNoText", spokenClosedNoText(PRACTICE)],
  ["spokenClosedTextSent", spokenClosedTextSent(PRACTICE)],
  ["spokenClosedAlreadyTexted", spokenClosedAlreadyTexted(PRACTICE)],
  ["afterHoursFallbackSms", afterHoursFallbackSms(PRACTICE)],
  ["inHoursCallbackSms", inHoursCallbackSms(PRACTICE)],
];

describe("callback copy — the practice is named", () => {
  it.each(LINES)("%s carries the practice name", (_name, line) => {
    expect(line).toContain(PRACTICE);
  });

  it("resolves the name from the site config, not a literal", () => {
    // site-cc is a real configured site; its display name is what a caller hears.
    expect(practiceNameFor("site-cc")).toBe("N15 Vitality Dental");
  });

  it("falls back to a generic label rather than guessing a brand for an unknown site", () => {
    // Naming the WRONG practice to a patient is worse than naming none.
    const name = practiceNameFor("site-does-not-exist");
    expect(name).toBe("the practice");
    expect(name).not.toMatch(/vitality/i);
  });
});

describe("callback copy — no NHS, private or funding wording", () => {
  it.each(LINES)("%s carries no funding vocabulary", (_name, line) => {
    expect(line).not.toMatch(/\b(NHS|private|privately|band [123])\b/i);
  });

  it.each(LINES)("%s passes the deterministic agent guardrail", (_name, line) => {
    expect(checkAgentReply(line).ok).toBe(true);
  });

  it("the sweep is real: a funding line in this shape would be caught", () => {
    const bad = `Hi, sorry we missed you at ${PRACTICE}. We can see you on the NHS next week.`;
    expect(bad).toMatch(/\b(NHS|private|privately|band [123])\b/i);
    expect(checkAgentReply(bad).ok).toBe(false);
  });
});

describe("callback copy — house style", () => {
  it.each(LINES)("%s uses British English and no em-dash", (_name, line) => {
    expect(line).not.toContain("—");
    expect(line).not.toMatch(/\borganiz|\bcolor\b|\bcanceled\b/);
  });

  it.each(LINES)("%s never tells the caller to hold, because the line is then hung up", (_name, line) => {
    expect(line.toLowerCase()).not.toContain("hold");
  });
});

describe("callback copy — a text is only promised when one went", () => {
  it("the 'no text' lines promise nothing", () => {
    for (const line of [spokenOpenNoText(PRACTICE), spokenClosedNoText(PRACTICE)]) {
      expect(line).not.toMatch(/sent you a text|texted you/i);
    }
  });

  it("the 'text sent' lines say so plainly", () => {
    expect(spokenOpenTextSent(PRACTICE)).toContain("just sent you a text");
    expect(spokenClosedTextSent(PRACTICE)).toContain("just sent you a text");
    expect(spokenClosedAlreadyTexted(PRACTICE)).toContain("already texted you");
  });

  it("the closed lines say the practice is closed, and the open lines do not", () => {
    expect(spokenClosedNoText(PRACTICE)).toContain("currently closed");
    expect(spokenClosedTextSent(PRACTICE)).toContain("currently closed");
    expect(spokenOpenNoText(PRACTICE)).not.toContain("closed");
    expect(spokenOpenTextSent(PRACTICE)).not.toContain("closed");
  });

  it("the in-hours text promises a callback, not opening hours", () => {
    const sms = inHoursCallbackSms(PRACTICE);
    expect(sms).toContain("call you back");
    expect(sms).not.toContain("closed");
  });
});

describe("escapeForTwiml", () => {
  it("escapes an ampersand in a practice name so the TwiML stays valid", () => {
    expect(escapeForTwiml(spokenOpenNoText("Smith & Partners"))).toContain("Smith &amp; Partners");
    expect(escapeForTwiml("Smith & Partners")).not.toMatch(/&(?!amp;)/);
  });

  it("escapes angle brackets so a name can never inject TwiML verbs", () => {
    expect(escapeForTwiml("<Hangup/>")).toBe("&lt;Hangup/&gt;");
  });

  it("leaves apostrophes alone, which are legal in an XML text node", () => {
    // Escaping them would churn every existing spoken line for nothing.
    expect(escapeForTwiml("We're currently closed.")).toBe("We're currently closed.");
  });

  it("leaves every existing line byte-identical", () => {
    for (const [, line] of LINES) expect(escapeForTwiml(line)).toBe(line);
  });
});
