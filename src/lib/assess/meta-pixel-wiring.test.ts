// THE META-TRACKING CHAIN: migration -> repository -> settings route -> public
// pages -> the three quizzes -> the submit route -> the outbound call.
//
// WHAT THIS SUITE IS AND IS NOT. The RULES — the pixel grammar, the config
// collapse, the consent vocabulary, the payload — are pure and are tested against
// themselves in meta-pixel.test.ts, meta-pixel-consent.test.ts and
// meta-capi.test.ts, called for real. What is left over, and what a refactor
// breaks in silence, is the WIRING: a page that stops projecting the config down
// to one field, a route that stops asking the validator, a quiz that stops sending
// the visitor's answer, a submit path that starts caring whether Meta replied.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts.
// Every link here is a server component, an API route, a service-role repository
// or a large client component — none of them callable in this environment. So each
// is held by reading its source, the same split custom-theme-wiring.test.ts uses
// for 0081's chain.
//
// THE SIX CLAIMS:
//   1. the migration is written, not applied, changes nothing live, and holds no
//      credential;
//   2. every query is scoped to one practice, and no read path can fail a page;
//   3. the settings route carries four guards, in order, and validates;
//   4. both public pages send the browser ONE field, and never in preview;
//   5. all three quizzes send this device's own answer, and none of them invents
//      one;
//   6. the submit route cannot be failed, slowed unboundedly, or made to spend, by
//      anything Meta does.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_PATH = "supabase/migrations/0083_assess_meta_pixel.sql";
const REPO_PATH = "src/lib/assess/meta-pixel-repository.ts";
const SENDER_PATH = "src/lib/assess/meta-capi-send.ts";
const ROUTE_PATH = "src/app/api/meta-ads/pixel/route.ts";
const SUBMIT_PATH = "src/app/api/smile-assessment/submit/route.ts";
const CAMPAIGN_PAGE_PATH = "src/app/assess/[client]/[slug]/page.tsx";
const GENERIC_PAGE_PATH = "src/app/assess/[client]/page.tsx";
const COMPONENT_PATH = "src/components/assess/meta-pixel.tsx";
const PANEL_PATH = "src/components/client/meta-ads/tracking-panel.tsx";
const WORKSPACE_PATH = "src/components/client/meta-ads/meta-ads-workspace.tsx";

const QUIZZES = [
  "src/components/assess/assessment-quiz.tsx",
  "src/components/assess/deterministic-assessment-quiz.tsx",
  "src/components/assess/guided-assessment-quiz.tsx",
];

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * Source with comments stripped: what a file DOES, not what it explains.
 *
 * LINE COMMENTS COME OFF FIRST, and that order is not cosmetic. The campaign page
 * carries the sentence "The /assess/* paths are public" in a `//` comment, and
 * `/assess/*` is a perfectly good OPENING of a block comment. Stripping block
 * comments first therefore deletes everything from that sentence to the next `*​/`
 * anywhere in the file — which, the moment a JSX comment is added lower down, is
 * most of the page. The test then passes or fails on the presence of a comment
 * three hundred lines away from the code it is about.
 */
function codeOnly(source: string): string {
  return source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

const migration = read(MIGRATION_PATH);
const repo = codeOnly(read(REPO_PATH));
const sender = codeOnly(read(SENDER_PATH));
const route = codeOnly(read(ROUTE_PATH));
const submit = codeOnly(read(SUBMIT_PATH));
const campaignPage = codeOnly(read(CAMPAIGN_PAGE_PATH));
const genericPage = codeOnly(read(GENERIC_PAGE_PATH));

/* ---------------------------------------------------------------------------
 * 1. The migration.
 * ------------------------------------------------------------------------- */

describe("0083 is written, not applied, and is inert either way", () => {
  it("creates the table with the house posture", () => {
    expect(migration).toContain("create table if not exists client_meta_pixel");
    expect(migration).toContain("alter table client_meta_pixel enable row level security");
    // POST-0012: no anon/authenticated grants at all. Everything goes through the
    // service-role client, so RLS alone would be a lock with the key left in it.
    expect(migration).toContain("revoke all on client_meta_pixel from anon, authenticated");
    // A setting, not a list: one practice, one answer.
    expect(migration).toContain("client_id          text not null unique");
  });

  // MUTATION: default `enabled` to true "so the feature shows something", and
  // every practice on the platform starts calling Facebook the moment somebody
  // types an id into a support ticket.
  it("defaults both switches OFF, in the schema and not only in the code", () => {
    expect(migration).toContain("enabled            boolean not null default false");
    expect(migration).toContain("advanced_matching  boolean not null default false");
  });

  it("seeds nothing and changes no existing row", () => {
    expect(migration).toContain("WRITTEN BUT NOT APPLIED");
    expect(migration.toLowerCase()).not.toContain("insert into client_meta_pixel");
    expect(migration.toLowerCase()).not.toContain("alter table smile_assessment_campaign");
  });

  // MUTATION: add an `access_token` column "so each practice can have its own".
  // A bearer credential over an ad dataset in a row is a credential in every
  // backup, export and `select *` on somebody's screen. The environment holds it.
  it("holds no credential column of any kind", () => {
    const columns = migration.slice(migration.indexOf("create table"));
    for (const forbidden of ["token", "secret", "password", "credential"]) {
      expect(columns.toLowerCase().includes(`${forbidden} `), `0083 declares a ${forbidden} column`).toBe(
        false,
      );
    }
  });
});

/* ---------------------------------------------------------------------------
 * 2. The repository.
 * ------------------------------------------------------------------------- */

describe("every query names the practice, and no read can fail a page", () => {
  it("is server-only, so none of it can be imported into a browser bundle", () => {
    expect(read(REPO_PATH).startsWith('import "server-only";')).toBe(true);
  });

  // MUTATION: drop one .eq("client_id", …) and a read returns whichever practice
  // the database felt like — there is no RLS underneath to catch it, because the
  // service-role client is above it by design.
  it("scopes every read and every write by client_id", () => {
    const queries = repo.split(".from(").slice(1);
    expect(queries.length).toBeGreaterThanOrEqual(3);
    for (const query of queries) {
      const statement = query.slice(0, query.indexOf(";"));
      const scoped = statement.includes('.eq("client_id"')
        ? true
        : statement.includes(".upsert(") && statement.includes("client_id: input.clientId");
      expect(scoped, `a query in ${REPO_PATH} is not client-scoped: ${statement.slice(0, 80)}`).toBe(
        true,
      );
    }
  });

  // MUTATION: build the config by copying three columns across. Going through the
  // pure collapse is what makes the read-back re-validation unavoidable rather
  // than remembered — a row whose pixel_id is no longer digits comes back OFF.
  it("re-checks the grammar at the single place a row becomes a config", () => {
    expect(repo).toContain("function rowToConfig");
    expect(repo).toContain("metaPixelConfig({");
    // Both readers go through it; neither builds a config by hand.
    expect(repo.match(/rowToConfig\(/g)?.length).toBeGreaterThanOrEqual(3);
    // ...and rowToConfig itself hands the row to the PURE collapse rather than
    // assembling a config from three columns, which is what makes the read-back
    // re-validation structural instead of remembered.
    const start = repo.indexOf("function rowToConfig");
    const body = repo.slice(start, repo.indexOf("\n}", start));
    expect(body).toContain("metaPixelConfig({");
    expect(body).toContain("return META_PIXEL_OFF;");
  });

  // MUTATION: let resolveMetaPixel throw. A transient database blip then 500s a
  // paid ad destination, and fails a patient's submission, over a tracking pixel.
  it("resolves through a reader that cannot throw, and fails to OFF", () => {
    const start = repo.indexOf("export async function resolveMetaPixel");
    expect(start).toBeGreaterThan(-1);
    const body = repo.slice(start, repo.indexOf("\n}", start));
    // THE READ IS INSIDE THE try, not merely near one.
    const tryAt = body.indexOf("try {");
    const readAt = body.indexOf(".from(");
    const catchAt = body.indexOf("} catch");
    expect(tryAt).toBeGreaterThan(-1);
    expect(tryAt).toBeLessThan(readAt);
    expect(readAt).toBeLessThan(catchAt);
    // ...and every exit is META_PIXEL_OFF, never a re-throw.
    expect(body).not.toContain("throw");
    expect(body.match(/return META_PIXEL_OFF;/g)?.length).toBeGreaterThanOrEqual(3);
  });

  // MUTATION: keep the pixel id when tracking is switched off, "in case they turn
  // it back on". A live dataset id in a row that claims to be off is exactly the
  // shape a later bug turns into an unexpected pixel.
  it("clears the id and the matching switch when tracking is switched off", () => {
    expect(repo).toContain("pixel_id: config.enabled ? config.pixelId : null");
    expect(repo).toContain("advanced_matching: config.enabled ? config.advancedMatching : false");
    // One row per practice, enforced at the write as well as in the schema.
    expect(repo).toContain('onConflict: "client_id"');
  });

  it("the owner's screen is TOLD about the un-applied migration; the page is not", () => {
    expect(repo).toContain("class MetaPixelTableMissingError");
    // The screen-facing read throws it...
    const settings = repo.slice(repo.indexOf("export async function getMetaPixelSettings"));
    expect(settings.slice(0, settings.indexOf("\n}"))).toContain("throw new MetaPixelTableMissingError()");
    // ...and it names the file, so a switch that will not save is explicable.
    expect(read(REPO_PATH)).toContain("0083_assess_meta_pixel.sql");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The settings route.
 * ------------------------------------------------------------------------- */

describe("the settings route carries four guards, in order", () => {
  // MUTATION: the API-layer lesson again. The page guard never runs on an API
  // route, so requireUser + requireClientAccess alone would admit every role
  // attached to the practice — a nurse could switch on conversion tracking for
  // every public funnel the practice runs.
  it("runs requireUser -> client -> module -> owner", () => {
    const user = route.indexOf("await requireUser()");
    const client = route.indexOf("requireClientAccess(auth");
    const moduleGate = route.indexOf('requireModuleApiAccess(auth, "meta-ads")');
    const owner = route.indexOf("requireOwnerRole(auth)");
    for (const [what, at] of Object.entries({ user, client, moduleGate, owner })) {
      expect(at, `${ROUTE_PATH} never calls the ${what} guard`).toBeGreaterThan(-1);
    }
    expect(user).toBeLessThan(client);
    expect(client).toBeLessThan(moduleGate);
    expect(moduleGate).toBeLessThan(owner);
    // Each one is RETURNED, not merely evaluated: a guard whose Response is
    // dropped compiles, reads as a lock and does nothing.
    expect(route).toContain("if (denied) return denied;");
    expect(route).toContain("if (moduleDenied) return moduleDenied;");
    expect(route).toContain("if (roleDenied) return roleDenied;");
  });

  // MUTATION: add a method that resolves the client itself and the four guards
  // become three. Every exported handler must enter through the one door.
  it("puts every method through the same authorise()", () => {
    const methods = [...route.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g)].map(
      (m) => m[1],
    );
    expect(methods.sort()).toEqual(["GET", "PUT"]);
    for (const method of methods) {
      const start = route.indexOf(`export async function ${method}(`);
      const next = route.indexOf("\nexport ", start + 1);
      const body = route.slice(start, next === -1 ? undefined : next);
      expect(body, `${method} does not authorise`).toContain("authorise(");
      expect(body, `${method} does not return the guard's Response`).toContain(
        "if (access instanceof Response) return access;",
      );
    }
  });

  // MUTATION: store `body` directly. The digits-only grammar is the injection
  // guard for a value that ends up inside a <script> on a public page.
  it("validates, answers 422 with the failures, and stores only what it validated", () => {
    expect(route).toContain("validatePixelConfig(body)");
    expect(route).toContain("describePixelConfigFailures(checked.failures)");
    expect(route).toContain("422");
    expect(route).toContain("config: checked.config");
    expect(route).not.toContain("pixelId: body.pixelId");
  });

  it("names the un-applied migration on the write path, and answers honestly on the read", () => {
    expect(route).toContain("e instanceof MetaPixelTableMissingError");
    expect(route).toContain("503");
    expect(route).toContain("migrationPending: true");
  });

  // MUTATION: return the access token so the settings screen can show it. It has
  // no field on the config, is read only inside the server-only sender, and must
  // never be named in a route that answers a browser.
  it("never touches the access token", () => {
    expect(route).not.toContain("META_CAPI_ACCESS_TOKEN");
    expect(route).not.toContain("access_token");
    expect(route.toLowerCase()).not.toContain("process.env");
  });
});

/* ---------------------------------------------------------------------------
 * 4. The public pages.
 * ------------------------------------------------------------------------- */

describe("both public pages send the browser one field, and nothing in preview", () => {
  it.each([
    ["campaign", CAMPAIGN_PAGE_PATH, campaignPage],
    ["generic", GENERIC_PAGE_PATH, genericPage],
  ])("the %s page resolves on the server and projects to a pixel id", (_label, path, src) => {
    expect(src, `${path} does not read the config`).toContain("resolveMetaPixel(clientRecord.id)");
    // MUTATION: pass the whole config down. `advancedMatching` — the switch that
    // decides whether a patient's hashed details leave the server — would then be
    // a field in the page's serialised props for anyone to read.
    expect(src, `${path} does not project through publicMetaPixelId`).toContain(
      "publicMetaPixelId(",
    );
    expect(src).toContain("<MetaPixel pixelId={metaPixelId} />");
    expect(src).not.toContain("<MetaPixel config");
  });

  // MUTATION: drop the preview check and an owner clicking through their own
  // funnel from the builder is counted as a visitor — teaching the ad account
  // that staff are patients, on the practice's money.
  it.each([
    ["campaign", campaignPage],
    ["generic", genericPage],
  ])("the %s page tracks nothing in preview mode", (_label, src) => {
    // Whatever else the expression does, `previewMode` short-circuits it to null
    // before publicMetaPixelId is ever reached.
    const at = src.indexOf("previewMode");
    const projectAt = src.indexOf("publicMetaPixelId(", at);
    expect(at).toBeGreaterThan(-1);
    expect(projectAt).toBeGreaterThan(at);
    expect(src.slice(at, projectAt)).toContain("null");
  });

  // MUTATION: leave the generic page's pixel un-gated. The campaign page 404s
  // when `smile-assessment` is switched off, so its pixel is behind the switch by
  // construction; THIS page has no such check, and a new public surface honours
  // the switch itself rather than inheriting somebody else's.
  it("the generic page gates its pixel on the kill switch, STRICTLY", () => {
    expect(genericPage).toContain(
      'isSystemEnabledStrict(clientRecord.id, "smile-assessment")',
    );
    // Strict, not the fail-open reader: a systems read that errors must mean "no
    // pixel", never "a third-party request nobody sanctioned".
    expect(genericPage).not.toContain("isSystemEnabled(clientRecord.id");
    // ...and the campaign page needs none, because it already shut the door.
    expect(campaignPage).toContain(
      'if (!(await isSystemEnabled(clientRecord.id, "smile-assessment"))) notFound();',
    );
  });

  // MUTATION: fetch the theme and the pixel one after the other. Two serial round
  // trips on a force-dynamic page that paid traffic lands on, for no reason.
  it("the campaign page reads the theme and the pixel together", () => {
    expect(campaignPage).toContain("const [custom, metaPixel] = await Promise.all([");
  });

  it("the component is the only thing the pages mount, and it is gated on the id", () => {
    const component = codeOnly(read(COMPONENT_PATH));
    expect(component).toContain("if (!pixelId) return null;");
    expect(component).toContain('if (snapshot !== "granted") return;');
    // The decision is read as an EXTERNAL STORE, with the server answering
    // "unknown" — which is what keeps the banner out of the server's HTML.
    expect(component).toContain("useSyncExternalStore(");
    expect(component).toContain("metaConsentServerSnapshot,");
    // Injection happens in an effect, never in the markup. meta-pixel.test.ts
    // asserts the consequence on the rendered bytes; this pins the mechanism.
    expect(component).toContain("injectMetaPixel(pixelId)");
    expect(component).not.toContain("dangerouslySetInnerHTML");
    expect(component).not.toContain("next/script");
  });
});

/* ---------------------------------------------------------------------------
 * 5. The three quizzes.
 * ------------------------------------------------------------------------- */

describe("every quiz sends this device's own answer, and none of them invents one", () => {
  // MUTATION: wire two of the three. The Classic, Guided and deterministic funnels
  // are three separate submit handlers, and a practice running an authored funnel
  // would silently get no conversions at all.
  it.each(QUIZZES)("%s posts the meta fields and fires the browser event", (path) => {
    const src = codeOnly(read(path));
    expect(src).toContain("const meta = metaSubmitFields();");
    expect(src).toContain("...meta,");
    expect(src).toContain("trackMetaLead(meta.metaEventId);");
    // The id is minted BEFORE the post, so the same one reaches both halves and
    // Meta counts one conversion rather than two.
    expect(src.indexOf("const meta = metaSubmitFields();")).toBeLessThan(
      src.indexOf('fetch("/api/smile-assessment/submit"'),
    );
    expect(src.indexOf('fetch("/api/smile-assessment/submit"')).toBeLessThan(
      src.indexOf("trackMetaLead(meta.metaEventId);"),
    );
  });

  // MUTATION: hard-code metaConsent: true in a quiz "for testing". The server
  // trusts this field for exactly one thing — whether a hash may leave — so it
  // must only ever come from the shared helper that reads the stored decision.
  it.each(QUIZZES)("%s never asserts consent itself", (path) => {
    const src = codeOnly(read(path));
    expect(src).not.toMatch(/metaConsent:\s*true/);
    expect(src).not.toContain("localStorage");
  });
});

/* ---------------------------------------------------------------------------
 * 6. The submit route and the outbound call.
 * ------------------------------------------------------------------------- */

describe("nothing Meta does can reach the patient", () => {
  it("the event is behind the config AND the kill switch", () => {
    // MUTATION: fire the event before the kill-switch read. Switching the system
    // off has to shut every door, and a call to Facebook about a patient is an
    // outbound act like any other.
    expect(submit).toContain("if (smileEnabled && client) {");
    expect(submit).toContain("const metaPixel = await resolveMetaPixel(client.id);");
    expect(submit).toContain("if (metaPixel.enabled) {");
    expect(submit.indexOf("const smileEnabled")).toBeLessThan(
      submit.indexOf("resolveMetaPixel(client.id)"),
    );
  });

  // MUTATION: default the consent flag to true, or read it with a truthiness
  // check. A missing field would then unlock hashed contact details for every
  // submission from an older cached page.
  it("takes the visitor's consent from the body, strictly, and never infers it", () => {
    expect(submit).toContain("consented: body.metaConsent === true,");
    expect(submit).not.toMatch(/consented:\s*true/);
    // Advanced matching is NOT passed in: it comes from the practice's stored
    // config inside the sender, so a caller cannot turn it on for one submission.
    expect(submit).not.toContain("advancedMatching");
  });

  // MUTATION: branch on the send result. The moment the submit route reads it,
  // a Meta outage becomes a patient-facing failure.
  it("ignores the result entirely", () => {
    expect(submit).toContain("await sendAssessmentLeadEvent({");
    expect(submit).not.toMatch(/(const|let)\s+\w+\s*=\s*await sendAssessmentLeadEvent/);
  });

  it("the URL it reports is built from resolved records, not from the caller", () => {
    expect(submit).toContain("const origin = new URL(request.url).origin;");
    expect(submit).toContain("`/assess/${client.slug}/${campaign.slug}`");
    // Never the caller's own clientSlug/campaignSlug strings.
    expect(submit).not.toContain("`/assess/${clientSlug}");
  });

  // MUTATION: let the sender throw. It is called from inside the submit route's
  // main try block, so a throw would be caught — and turned into the route's
  // 500 "could not record your assessment", after the assessment was recorded.
  it("the sender has no throwing path at all", () => {
    expect(sender).not.toContain("throw ");
    // One try wrapping the whole body, and a catch that returns.
    const start = sender.indexOf("export async function sendAssessmentLeadEvent");
    const body = sender.slice(start);
    expect(body.indexOf("try {")).toBeLessThan(body.indexOf("if (!config.enabled"));
    expect(body).toContain('return { sent: false, reason: "error" };');
  });

  it("costs nothing at all for a practice that has not switched tracking on", () => {
    // MUTATION: read the environment or consume a budget row before the config
    // check. Every submission on the platform would then pay for a feature almost
    // nobody uses.
    const start = sender.indexOf("export async function sendAssessmentLeadEvent");
    const body = sender.slice(start);
    const configAt = body.indexOf("if (!config.enabled");
    expect(configAt).toBeGreaterThan(-1);
    expect(configAt).toBeLessThan(body.indexOf("process.env"));
    expect(configAt).toBeLessThan(body.indexOf("consumeBudget("));
    expect(configAt).toBeLessThan(body.indexOf("fetch("));
  });

  // MUTATION: spend first and check later. This is a public endpoint whose
  // outbound call hits a practice's own ad account quota.
  it("consumes the budget before the call, and treats any doubt as a refusal", () => {
    expect(sender.indexOf("consumeBudget(")).toBeLessThan(sender.indexOf("fetch("));
    expect(sender).toContain("`meta-capi:${input.clientId}`");
    // consumeBudget fails OPEN by design; a throw here must still mean "skip".
    expect(sender).toContain("allowed = false;");
    expect(sender).toContain('if (!allowed) return { sent: false, reason: "budget" };');
  });

  it("time-boxes the call, so a patient never waits on an ad platform", () => {
    expect(sender).toContain("AbortSignal.timeout(CAPI_TIMEOUT_MS)");
    expect(read(SENDER_PATH)).toMatch(/CAPI_TIMEOUT_MS = \d{3,4};/);
  });

  // MUTATION: put the token in the query string, which Meta also accepts. A
  // credential in a URL is a credential in every proxy, CDN and error-reporter log
  // between here and Graph.
  it("keeps the token in the body, out of the URL, and out of the logs", () => {
    expect(sender).toContain("access_token: token");
    expect(sender).not.toContain("access_token=");
    expect(sender).not.toMatch(/console\.\w+\([^)]*token/);
    // And the error BODY is never read: Meta quotes the payload back, hashes and
    // all, and a logged error body would undo the care taken over the payload.
    expect(sender).not.toContain("response.text()");
    expect(sender).not.toContain("response.json()");
  });

  it("reads the token from the environment and from nowhere else", () => {
    expect(sender).toContain('const TOKEN_ENV = "META_CAPI_ACCESS_TOKEN"');
    expect(sender).toContain("process.env[TOKEN_ENV]");
    expect(repo).not.toContain("META_CAPI_ACCESS_TOKEN");
  });
});

/* ---------------------------------------------------------------------------
 * 7. The owner's screen.
 * ------------------------------------------------------------------------- */

describe("the settings tab exists and says what it does", () => {
  it("is mounted in the Meta Ads workspace", () => {
    const workspace = codeOnly(read(WORKSPACE_PATH));
    expect(workspace).toContain('{ key: "tracking", label: "Tracking"');
    expect(workspace).toContain('{tab === "tracking" ? <TrackingPanel clientSlug={clientSlug} /> : null}');
  });

  // MUTATION: pre-validate in the browser. A second implementation of the gate is
  // one free to disagree with the gate that actually decides.
  it("leaves the decision to the server and shows what it says back", () => {
    const panel = codeOnly(read(PANEL_PATH));
    expect(panel).toContain('method: "PUT"');
    expect(panel).toContain("/api/meta-ads/pixel");
    expect(panel).not.toContain("validatePixelConfig");
    expect(panel).not.toContain("normalisePixelId");
    // Re-seeded from what was STORED, so switching off visibly clears the id.
    expect(panel).toContain("setPixelId(data.settings.pixelId ?? \"\");");
  });

  it("tells the owner what their visitors actually experience", () => {
    // Not decoration: the practice is the data controller answering for this, and
    // an owner who cannot describe their own tracking has been badly served.
    const panel = read(PANEL_PATH);
    expect(panel).toContain("asked once");
    expect(panel).toContain("no cookie is set");
    expect(panel).toContain("hashed");
  });
});
