// THE FOLLOW-UP CHAIN: migration -> repository -> submit route -> send path ->
// PATCH route -> card.
//
// WHAT THIS SUITE IS AND IS NOT. The RULES — what "off" means, what a template may
// say, how a token is filled in — are pure and are called for real in
// follow-up.test.ts. What is left over, and what a refactor breaks in silence, is
// the WIRING: a submit route that stops asking whether this campaign follows
// everyone up, a send path that resolves an override and then drafts anyway, a
// PATCH route that stores wording without scanning it, a repository query that
// forgets its client_id.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts.
// The submit route, the send path, the PATCH route and the repository are all
// unreachable in that environment (they reach for a Supabase service-role client,
// requireUser, and the Anthropic SDK), so each is held by READING ITS SOURCE — the
// same split custom-theme-wiring.test.ts and campaign-theme.test.ts use for 0079
// and 0081. The CARD is different: it renders, so it is rendered.
//
// THE SIX CLAIMS:
//   1. the migration is written, not applied, and changes nothing that is live;
//   2. the submit route's bridge is gated by the rule, and by nothing else new —
//      the four conditions beside it are untouched;
//   3. the send path chooses the text AFTER consent, suppression and
//      deliverability, and the output guardrail still runs on whatever it chose;
//   4. every follow-up query is scoped to one practice, and the write scans;
//   5. the PATCH route keeps its four guards, reads presence not truthiness, and
//      refuses wording the sender would refuse;
//   6. the card says what is in force, and a pre-0082 campaign's card is the card
//      it was before.

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CampaignCard } from "@/components/client/smile-assessment/campaigns-panel";
import { FOLLOW_UP_TRIGGERS, followUpTriggerLabel } from "./follow-up";

const MIGRATION_PATH = "supabase/migrations/0082_assessment_follow_up.sql";
const LIB_PATH = "src/lib/smile-assessment/follow-up.ts";
const REPO_PATH = "src/lib/smile-assessment/campaign-repository.ts";
const SUBMIT_PATH = "src/app/api/smile-assessment/submit/route.ts";
const CONTACT_PATH = "src/lib/speed-to-lead/contact.ts";
const PATCH_PATH = "src/app/api/smile-assessment/campaign/[slug]/route.ts";
const PANEL_PATH = "src/components/client/smile-assessment/campaigns-panel.tsx";

function read(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/** Source with comments stripped: what a file DOES, not what it explains. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const migration = read(MIGRATION_PATH);
const lib = codeOnly(read(LIB_PATH));
const repo = codeOnly(read(REPO_PATH));
const submit = codeOnly(read(SUBMIT_PATH));
const contact = codeOnly(read(CONTACT_PATH));
const patchRoute = codeOnly(read(PATCH_PATH));
const panel = codeOnly(read(PANEL_PATH));

/* ---------------------------------------------------------------------------
 * 1. The migration.
 * ------------------------------------------------------------------------- */

describe("0082 is written, not applied, and is inert either way", () => {
  it("adds exactly three columns to one existing table", () => {
    expect(migration).toContain("alter table smile_assessment_campaign");
    for (const column of ["follow_up_enabled", "follow_up_trigger", "follow_up_template"]) {
      expect(migration).toContain(`add column if not exists ${column}`);
    }
    expect(migration).not.toMatch(/create table/i);
  });

  // MUTATION: default follow_up_enabled to true and every existing campaign gains
  // a behaviour the moment someone runs the file — which is the one thing a
  // migration that "changes nothing that is live" must not do.
  it("defaults the switch to false, so running it switches nothing on", () => {
    expect(migration).toMatch(/follow_up_enabled boolean not null default false/);
  });

  it("seeds nothing, backfills nothing and updates nothing", () => {
    const statements = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/\binsert\s+into\b/i);
    expect(statements).not.toMatch(/^\s*update\s+/im);
    expect(statements).not.toMatch(/\bdelete\s+from\b/i);
  });

  // The list of legal triggers lives in TypeScript with a test, in one place. A
  // CHECK constraint would be a second, weaker copy that turns adding a trigger
  // into a migration — the call 0059, 0078, 0079 and 0081 all made.
  it("puts no CHECK constraint on the trigger", () => {
    expect(migration).not.toMatch(/\bcheck\s*\(/i);
  });

  it("names itself in the error the write path raises when it is missing", () => {
    expect(repo).toContain("0082_assessment_follow_up.sql");
  });
});

/* ---------------------------------------------------------------------------
 * 2. The submit route: who is bridged.
 * ------------------------------------------------------------------------- */

describe("the submit bridge asks the rule, and the rest of the gate is untouched", () => {
  // MUTATION: leave `band === "high"` in the bridge condition and the trigger is
  // dead configuration — an owner switches "every submission" on and nothing
  // happens, with no error to explain it.
  it("gates the bridge on shouldFollowUp, not on the band directly", () => {
    expect(submit).toContain("const followUp = followUpConfig(campaign);");
    expect(submit).toMatch(
      /if \(shouldFollowUp\(followUp, band\) && hasContact && trusted && smileEnabled && speedToLeadEnabled\)/,
    );
    // The old expression must be GONE from the bridge. It survives elsewhere in
    // the file (the response message a high scorer reads), which is why this is
    // scoped to the `if` rather than to the whole source.
    expect(submit).not.toMatch(/if \(band === "high" &&/);
  });

  // The four conditions beside it are the reason this widening is safe. If any of
  // them is dropped, "every submission" stops meaning "every submission we were
  // already allowed to contact".
  it("still requires a contact, a trusted submit, and BOTH kill switches", () => {
    expect(submit).toContain("const hasContact = Boolean(phone || email);");
    expect(submit).toContain('isSystemEnabledForSend(client?.id ?? "", "smile-assessment")');
    expect(submit).toContain('isSystemEnabledForSend(client?.id ?? "", "speed-to-lead")');
    expect(submit).toContain("verifySubmitToken(");
  });

  // MUTATION: move the config read (or the bridge) above insertResponse and a
  // submission stops being recorded when the bridge throws. Recording the
  // assessment is unconditional and comes first; contacting is the extra.
  it("records the response before it decides anything about contacting", () => {
    expect(submit.indexOf("await insertResponse(")).toBeGreaterThan(0);
    expect(submit.indexOf("await insertResponse(")).toBeLessThan(
      submit.indexOf("shouldFollowUp(followUp, band)"),
    );
  });

  // The durable budgets are the public endpoint's real spend ceiling and they are
  // consumed before any of this. A trigger of 'all' multiplies how many
  // submissions reach the bridge, so the ceiling mattering MORE is the point.
  it("still consumes both durable budgets before any of it", () => {
    expect(submit.indexOf("consumeBudget(`smile-submit-ip:")).toBeLessThan(
      submit.indexOf("shouldFollowUp(followUp, band)"),
    );
    expect(submit.indexOf("consumeBudget(`smile-submit:")).toBeLessThan(
      submit.indexOf("shouldFollowUp(followUp, band)"),
    );
  });

  it("creates no second send path: contactLead is still the only sender it calls", () => {
    expect(submit.match(/await contactLead\(/g)).toHaveLength(1);
    expect(submit).not.toContain("sendMessage(");
  });
});

/* ---------------------------------------------------------------------------
 * 3. The send path: what the message says.
 * ------------------------------------------------------------------------- */

describe("the send path chooses the text at one seam, after every gate", () => {
  const at = (needle: string) => {
    const index = contact.indexOf(needle);
    expect(index, `contact.ts no longer contains ${needle}`).toBeGreaterThan(-1);
    return index;
  };

  // THE HEADLINE CLAIM. An override is wording, not permission: everything that
  // decides whether this patient may be messaged at all has already run by the
  // time the text is chosen.
  //
  // MUTATION: hoist the override resolution and the `const body =` above the
  // consent or suppression checks and this fails — and a practice's own wording
  // starts reaching people who opted out.
  it("consults consent, suppression and deliverability BEFORE the text is chosen", () => {
    const seam = at("const body = firstTouch");
    expect(at("if (!channelConsented(lead))")).toBeLessThan(seam);
    expect(at("const suppressed =")).toBeLessThan(seam);
    expect(at("await validateMobile(to)")).toBeLessThan(seam);
    expect(at("await validateEmail(to)")).toBeLessThan(seam);
    expect(at("MAX_FAILED_CONTACT_ATTEMPTS")).toBeLessThan(seam);
  });

  it("uses the override when there is one and drafts when there is not", () => {
    expect(contact).toMatch(
      /const body = firstTouch\s*\?\s*renderFollowUpTemplate\(firstTouch, \{ name: lead\.name, practice: client\?\.name \}\)\s*:\s*\(await draftFirstContact\(/,
    );
  });

  // MUTATION: resolve the override only in the submit route and pass it in. The
  // SLA sweep, the intake route and the missed-call bridge all call contactLead
  // with no campaign context, so a lead whose first send failed would be retried
  // with a DIFFERENT message from the one its owner wrote.
  it("resolves the override from the lead's own response, so every caller gets it", () => {
    expect(contact).toContain("await latestResponseByLead(lead.id)");
    expect(contact).toContain("if (response?.campaignId)");
    expect(contact).toContain(
      "firstTouch = firstTouchOverride(await getCampaignFollowUp(clientId, response.campaignId));",
    );
    // contactLead's signature is unchanged: no caller had to learn anything.
    expect(contact).toContain(
      "export async function contactLead(lead: SpeedToLeadLead, campaign?: CampaignContext): Promise<void>",
    );
  });

  // MUTATION: exempt an override from checkAgentReply because "the owner wrote it
  // and it was scanned at write time". Then a row edited by hand, a template
  // stored before a pattern was added, or a value substituted into it reaches a
  // patient with no backstop at all.
  it("runs the output guardrail on the body whatever wrote it", () => {
    const guard = at("const guard = checkAgentReply(body, { includePrice: false });");
    expect(at("const body = firstTouch")).toBeLessThan(guard);
    expect(guard).toBeLessThan(at("result = await sendMessage("));
    // One body, one send: the two sources converge before anything leaves.
    expect(contact.match(/await sendMessage\(\{/g)).toHaveLength(1);
  });

  it("costs no model call when the practice wrote the message", () => {
    // draftFirstContact is reached only through the ternary's else branch, so an
    // override never enters it. One call site, inside the expression.
    expect(contact.match(/draftFirstContact\(/g)).toHaveLength(1);
  });

  // The read is scoped and cheap: a lead that never came through an assessment
  // makes no extra query at all.
  it("makes the extra read only for a lead that came through a campaign", () => {
    expect(contact).toContain("if (response?.campaignId)");
    expect(contact).toContain('const clientId = getSite(lead.siteId)?.clientId ?? "";');
  });
});

/* ---------------------------------------------------------------------------
 * 4. The repository.
 * ------------------------------------------------------------------------- */

describe("the repository scopes every follow-up query and scans every write", () => {
  const followUpBlock = repo.slice(
    repo.indexOf("export async function setCampaignFollowUp"),
    repo.indexOf("export async function updateCampaignFlow"),
  );

  it("has a follow-up block to read", () => {
    expect(followUpBlock.length).toBeGreaterThan(200);
  });

  // The service-role client bypasses RLS, so the .eq("client_id") IS the tenancy
  // boundary. A campaign id travelling on a response row is not an authorisation.
  it("scopes both the write and the read to one practice", () => {
    expect(followUpBlock).toContain('.eq("client_id", clientId)');
    expect(followUpBlock.match(/\.eq\("client_id", clientId\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  // MUTATION: write the template straight into the patch. The route's validator is
  // then the only gate, and "everyone remembers to call the validator" is a hope.
  it("validates the wording in the one place the column is written", () => {
    expect(followUpBlock).toContain("validateFollowUpTemplate(input.template)");
    expect(followUpBlock).toContain("throw new FollowUpTemplateRejectedError(checked.failures)");
    expect(followUpBlock).toContain("patch.follow_up_template = checked.template;");
  });

  it("reads presence, not truthiness, so a field left out is left alone", () => {
    expect(followUpBlock).toContain("if (input.enabled !== undefined)");
    expect(followUpBlock).toContain("if (input.trigger !== undefined)");
    expect(followUpBlock).toContain("if (input.template !== undefined)");
  });

  // MUTATION: let getCampaignFollowUp throw. A configuration read then takes down
  // a first contact — a patient does not hear back because a column is missing.
  it("never lets the SEND path's read fail a first contact", () => {
    expect(followUpBlock).toContain("if (error || !data) return FOLLOW_UP_OFF;");
    expect(followUpBlock).toMatch(/catch \{\s*return FOLLOW_UP_OFF;\s*\}/);
    // ...while the OWNER's write reports the missing migration by name.
    expect(followUpBlock).toContain("throw new FollowUpColumnsMissingError()");
  });

  // MUTATION: coerce the three columns on read and an un-migrated database stops
  // being distinguishable from a configured one.
  it("defaults all three columns to OFF for a row that predates 0082", () => {
    expect(repo).toContain("followUpEnabled: r.follow_up_enabled === true,");
    expect(repo).toContain(
      'followUpTrigger: typeof r.follow_up_trigger === "string" ? r.follow_up_trigger : null,',
    );
    expect(repo).toContain(
      'followUpTemplate: typeof r.follow_up_template === "string" ? r.follow_up_template : null,',
    );
  });
});

/* ---------------------------------------------------------------------------
 * 5. The PATCH route.
 * ------------------------------------------------------------------------- */

describe("the PATCH route keeps its guards and refuses what the sender would", () => {
  // No new route was added for this feature, so the module-api guard coverage is
  // satisfied by the route that already existed — but only while these four are
  // still here, in this order.
  it("carries the four guards, in order, before it reads a single field", () => {
    const requireUser = patchRoute.indexOf("await requireUser()");
    const clientAccess = patchRoute.indexOf("requireClientAccess(auth, client.id)");
    const moduleAccess = patchRoute.indexOf('requireModuleApiAccess(auth, "smile-assessment")');
    const firstField = patchRoute.indexOf('has("followUpEnabled")');
    expect(requireUser).toBeGreaterThan(-1);
    expect(requireUser).toBeLessThan(clientAccess);
    expect(clientAccess).toBeLessThan(moduleAccess);
    expect(moduleAccess).toBeLessThan(firstField);
  });

  it("reads presence off the body for all five fields", () => {
    expect(patchRoute).toContain(
      "const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);",
    );
    for (const key of ["status", "theme", "followUpEnabled", "followUpTrigger", "followUpTemplate"]) {
      expect(patchRoute).toContain(`has("${key}")`);
    }
    // A body with none of them is still refused.
    expect(patchRoute).toContain("if (!hasStatus && !hasTheme && !hasFollowUp)");
  });

  // MUTATION: send followUpEnabled on every save. The route would then restate a
  // field the owner did not touch, which is the exact thing presence-semantics
  // exist to prevent, and two people editing one campaign would overwrite each
  // other's unrelated settings.
  it("writes only the fields that were sent", () => {
    expect(patchRoute).toContain("...(hasFollowUpEnabled ? { enabled: followUpEnabled as boolean }");
    expect(patchRoute).toContain("...(hasFollowUpTrigger ? { trigger: followUpTrigger");
    expect(patchRoute).toContain("...(hasFollowUpTemplate ? { template: followUpTemplate");
  });

  it("checks the trigger against the closed list and the switch against a boolean", () => {
    expect(patchRoute).toContain("!isFollowUpTrigger(followUpTrigger)");
    expect(patchRoute).toContain('typeof followUpEnabled !== "boolean"');
  });

  // MUTATION: drop the validator here and the route 500s on non-compliant wording
  // (the repository still refuses it) instead of telling the owner which word.
  it("scans the wording at the door and reports every reason", () => {
    expect(patchRoute).toContain("validateFollowUpTemplate(followUpTemplate)");
    expect(patchRoute).toContain("describeFollowUpTemplateFailures(checked.failures)");
  });

  // MUTATION: swallow the missing-column error and an owner flips a switch that
  // never takes, on a deployment where 0082 has not been applied, with nothing on
  // screen to say why.
  it("reports an un-applied 0082 as a 503 rather than a silent success", () => {
    expect(patchRoute).toContain("e instanceof FollowUpColumnsMissingError) return bad(e.message, 503)");
  });

  it("validates before it looks the campaign up, so a refused write touches nothing", () => {
    expect(patchRoute.indexOf("validateFollowUpTemplate(followUpTemplate)")).toBeLessThan(
      patchRoute.indexOf("await getCampaignBySlug(client.id, slug)"),
    );
  });
});

/* ---------------------------------------------------------------------------
 * 6. The card, rendered.
 * ------------------------------------------------------------------------- */

const BASE = {
  id: "campaign-1",
  slug: "spring-invisalign",
  name: "Spring Invisalign",
  goal: "invisalign",
  goalLabel: "Invisalign / teeth straightening",
  targetBudget: "any",
  budgetLabel: "Any budget",
  headline: "Is Invisalign right for you?",
  intro: null,
  idealCustomer: null,
  goalNote: null,
  status: "active" as const,
  createdBy: null,
  createdAt: "2026-08-16T00:00:00Z",
  updatedAt: "2026-08-16T00:00:00Z",
  url: "https://example.test/assess/vitality/spring-invisalign",
  path: "/assess/vitality/spring-invisalign",
  responseCount: 12,
};

function card(extra: Record<string, unknown>): string {
  return renderToStaticMarkup(
    createElement(CampaignCard, {
      clientSlug: "vitality",
      campaign: { ...BASE, ...extra },
      togglingId: null,
      openCanvasFor: null,
      onToggleStatus: () => {},
      onCampaignUpdated: () => {},
    } as never),
  );
}

describe("the card says what is in force without being opened", () => {
  it("shows the default state for a campaign nobody has configured", () => {
    const html = card({});
    expect(html).toContain("Follow-up");
    expect(html).toContain("Default");
    expect(html).toContain("Only a strong match, we write it");
    expect(html).not.toContain("Configured");
  });

  // MUTATION: read `campaign.followUpEnabled` where the row is absent and the
  // pre-0082 card and the switched-off card stop being the same card. They are
  // the same behaviour, so they have to be the same pixels.
  it("renders a pre-0082 campaign byte-identically to a switched-off one", () => {
    expect(card({})).toBe(
      card({ followUpEnabled: false, followUpTrigger: null, followUpTemplate: null }),
    );
  });

  it("names the trigger in force, from the shared catalogue", () => {
    const html = card({ followUpEnabled: true, followUpTrigger: "all", followUpTemplate: null });
    expect(html).toContain("Configured");
    expect(html).toContain(followUpTriggerLabel("all"));
    expect(html).toContain("we write it");
  });

  it("says when the practice's own wording is the one being sent", () => {
    const html = card({
      followUpEnabled: true,
      followUpTrigger: "high",
      followUpTemplate: "Hi {name}, it is {practice}. Shall we find you a time?",
    });
    expect(html).toContain("your wording");
  });

  // MUTATION: trust the stored trigger on the card and a hand-edited row makes
  // the summary claim something the server would never do.
  it("falls back to the narrower trigger for a value it does not recognise", () => {
    const html = card({ followUpEnabled: true, followUpTrigger: "everyone" });
    expect(html).toContain(followUpTriggerLabel("high"));
    expect(html).not.toContain(followUpTriggerLabel("all"));
  });

  // THE COPY NEVER LEAKS TO THE PATIENT'S PAGE. The card is the owner's screen;
  // the template is rendered here as a summary word only, never as the message
  // itself, and the closed panel prints none of it.
  it("does not print the stored message on the closed row", () => {
    const html = card({
      followUpEnabled: true,
      followUpTrigger: "high",
      followUpTemplate: "Hi {name}, a very distinctive sentence.",
    });
    expect(html).not.toContain("a very distinctive sentence");
  });
});

describe("the panel is wired to the shared rules, not to its own copies", () => {
  it("uses the shared validator and the shared trigger catalogue", () => {
    expect(panel).toContain("validateFollowUpTemplate(template)");
    expect(panel).toContain("FOLLOW_UP_TRIGGERS.map(");
    expect(panel).toContain("followUpTriggerLabel(");
    expect(panel).toContain("isFollowUpTrigger(campaign.followUpTrigger)");
  });

  it("uses the shared switch primitive rather than a fourth private one", () => {
    expect(panel).toContain("<Toggle");
    expect(panel).not.toMatch(/role="switch"/);
  });

  // MUTATION: PATCH the whole form every time. The route reads presence, so an
  // unchanged field would be restated, and a colleague's edit to another setting
  // in the same campaign would be silently overwritten.
  it("PATCHes only what changed, on the route the other card controls use", () => {
    expect(panel).toContain("if (enabled !== storedEnabled) body.followUpEnabled = enabled;");
    expect(panel).toContain("if (trigger !== storedTrigger) body.followUpTrigger = trigger;");
    expect(panel).toContain("if (templateChanged) body.followUpTemplate = nextTemplate;");
    expect(panel).toContain("/api/smile-assessment/campaign/${encodeURIComponent(campaign.slug)}");
  });

  // MUTATION: mark the card optimistically. A colour that reverts is visible; a
  // contact rule that reverted would leave an owner believing the practice is
  // texting people it is not.
  it("only claims the new state after the server agrees", () => {
    const save = panel.indexOf("async function save()");
    const update = panel.indexOf("onCampaignUpdated(campaign.id, {\n        followUpEnabled");
    const check = panel.indexOf("if (!res.ok || !data.ok) {\n        throw new Error(data.error");
    expect(save).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(save);
    expect(update).toBeGreaterThan(check);
  });

  it("offers exactly the triggers the server accepts", () => {
    for (const trigger of FOLLOW_UP_TRIGGERS) {
      expect(followUpTriggerLabel(trigger).length).toBeGreaterThan(0);
    }
    // The options are generated from the catalogue, so a third trigger appears in
    // the control the day it appears in the list, and not before.
    expect(panel).not.toMatch(/<option key="high"/);
  });
});

describe("the lib is the only place the rules live", () => {
  // MUTATION: re-list the banned wording inside follow-up.ts. It would drift from
  // the funnel's list the first time a pattern was added for the landing pages.
  it("reuses the funnel's scan rather than restating it", () => {
    expect(lib).toContain('import { scanFlowCopyText, type FlowCopyHit } from "./flow-copy";');
    expect(lib).toContain("scanFlowCopyText(TEMPLATE_WHERE, template)");
  });

  it("reuses the send path's own guardrail, with the same price posture", () => {
    expect(lib).toContain('import { checkAgentReply, type GuardrailCategory } from "@/lib/agent/guardrail";');
    expect(lib).toContain("checkAgentReply(template, { includePrice: false })");
    // The sender calls it exactly the same way, so the two cannot disagree.
    expect(contact).toContain("checkAgentReply(body, { includePrice: false })");
  });

  it("stays pure: no I/O, no React, no server imports", () => {
    expect(lib).not.toContain("server-only");
    expect(lib).not.toContain("@/lib/supabase");
    expect(lib).not.toContain("from \"react\"");
    expect(lib).not.toMatch(/\bfetch\(/);
  });
});
