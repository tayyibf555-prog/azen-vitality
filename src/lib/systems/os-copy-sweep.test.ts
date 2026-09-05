import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";

// The band's read layer is `server-only`, which node cannot resolve; this suite
// only needs its tile definitions.
vi.mock("server-only", () => ({}));

// The three workspaces are client components that call `useRouter` to refresh
// after a save. Nothing in this suite saves anything; the router is stubbed so
// the EMPTY STATE can be rendered, which is the only thing being read.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/c/vitality",
  useSearchParams: () => new URLSearchParams(),
}));

import { CLIENT_NAV } from "@/lib/nav";
import { FORBIDDEN_PATIENT_WORDS } from "@/lib/triage/forbidden";
import { previsitBody } from "@/lib/triage/copy";
import { OS_TILES } from "@/lib/home/os-band";
import { SYSTEMS, SYSTEM_SLUGS } from "./catalog";
import { FIRST_STEPS } from "./first-steps";
import { SYSTEM_VOCABULARY } from "./vocabulary";

// ===========================================================================
// THE COPY SWEEP: three rules that apply to the WHOLE platform, checked in one
// place because each of them was previously checked in none.
//
// 1. NO PATIENT-FACING SURFACE SAYS NHS OR PRIVATE. The rule is PRODUCT.md's
//    and section 0 item 7 of the programme charter. src/lib/triage/copy.test.ts
//    proves it for the pre-visit form by RENDERING it, which is the stronger
//    proof and covers one route tree. This sweep covers the OTHER public trees
//    — the assessment, the booking page, onboarding, the medical-history link,
//    the short-link lander — by crawling their source, which is weaker (a word
//    reaching them from a database is invisible to it) and is why it is an
//    addition to that suite and not a replacement for it.
//
// 2. NOTHING PROMISES THE PARKED PER-COMPUTER IT AGENT. "The installed
//    per-computer IT agent is PARKED by decision" (charter §4). The IT desk has
//    no software on any machine and no way to get one there, so any sentence
//    that mentions installing, remote access or an endpoint has to be a DENIAL.
//    This is what stops the module drifting into a promise the practice would
//    reasonably expect us to keep.
//
// 3. MODULE COPY USES THE PRACTICE'S VOCABULARY, NEVER AN INTERNAL SLUG. The
//    practice says "Pre-visit questions", "the IT desk", "Dentally write-back".
//    "pre-visit-triage" is a database value and a URL segment, and a screen that
//    prints one has stopped speaking the practice's language.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. The funding crawl over the public route trees.
// ---------------------------------------------------------------------------

/**
 * Every public tree a patient can land on.
 *
 * /fp17 IS EXEMPT, BY NAME AND FOR ONE REASON: the thing the patient is filling
 * in on that page IS an NHS dental declaration — a legal form, named in
 * legislation, which the patient is signing. Renaming it to protect them from
 * the word would leave them signing a document whose name they had not been
 * told. The exemption is exactly this route tree and nothing else, and the
 * assertion below proves the exemption is still needed rather than leaving a
 * stale hole in the crawl.
 */
const PUBLIC_TREES = ["src/app/pv", "src/app/assess", "src/app/book", "src/app/onboard", "src/app/mh", "src/app/go"];
const FUNDING_EXEMPT_TREE = "src/app/fp17";

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path)) out.push(path);
    }
  };
  walk(join(process.cwd(), dir));
  return out;
}

/**
 * Lines that could reach a screen: comment lines are dropped, because the rule is
 * about what a patient reads and a comment explaining the rule would otherwise
 * break it. Crude on purpose — a heuristic that over-reports is a nuisance, one
 * that under-reports is a hole, and this one only ever drops a line that BEGINS
 * as a comment.
 */
function copyLines(file: string): Array<{ line: number; text: string }> {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
}

describe("no funding word reaches a patient on any public surface", () => {
  it("crawls every public route tree", () => {
    const hits: string[] = [];
    for (const tree of PUBLIC_TREES) {
      for (const file of sourceFiles(tree)) {
        for (const { line, text } of copyLines(file)) {
          for (const re of FORBIDDEN_PATIENT_WORDS) {
            if (re.test(text)) hits.push(`${file.replace(process.cwd() + "/", "")}:${line} ${text.trim().slice(0, 100)}`);
          }
        }
      }
    }
    expect(hits, `funding words on a patient-facing surface:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the one exempt tree is exempt because it still needs to be", () => {
    // If FP17's pages ever stop naming the declaration, the exemption is dead
    // wood and should be deleted rather than left standing as a hole.
    const named = sourceFiles(FUNDING_EXEMPT_TREE).some((f) =>
      copyLines(f).some(({ text }) => /\bnhs\b/i.test(text)),
    );
    expect(named, "the FP17 funding exemption is no longer needed — delete it").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. The parked IT agent.
// ---------------------------------------------------------------------------

/** Words that only ever appear in a sentence about software on somebody's machine. */
const ENDPOINT_WORDS = /\b(install(?:s|ed|ing|ation)?|remote(?:ly)?|endpoint|take over your (?:screen|computer))\b/i;
/** A sentence carrying one of those words must also carry one of these. */
const DENIAL = /\b(never|no|not|cannot|can't|without|nothing|nobody)\b/i;

/** Every string a person reads about the IT desk, from every surface that has one. */
function itDeskCopy(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const navItem = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "it-desk");
  if (navItem?.note) out.push({ where: "nav note", text: navItem.note });
  const system = SYSTEMS.find((s) => s.slug === "it-desk");
  if (system) out.push({ where: "catalog halts", text: system.halts });
  out.push({ where: "vocabulary starts", text: SYSTEM_VOCABULARY["it-desk"].starts });
  out.push({ where: "first step", text: FIRST_STEPS["it-desk"].step });
  for (const file of ["src/components/client/itdesk/it-desk-view.tsx", "src/components/client/itdesk/it-desk-workspace.tsx"]) {
    for (const { line, text } of prose(join(process.cwd(), file))) {
      out.push({ where: `${file}:${line}`, text });
    }
  }
  return out;
}

/**
 * The lines of a component that are PROSE rather than code: at least four words
 * and at least one space-separated pair of ordinary words. `endpoint="/api/..."`
 * is a route, not a promise, and a crawl that cannot tell the two apart gets
 * loosened until it proves nothing.
 */
function prose(file: string): Array<{ line: number; text: string }> {
  return copyLines(file).filter(({ text }) => {
    const words = text.trim().replace(/[<>{}()[\]"'`=/]/g, " ").split(/\s+/).filter((w) => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w));
    return words.length >= 6;
  });
}

describe("nothing promises the per-computer IT agent that is parked", () => {
  it("every sentence that mentions installing or remote access is a denial", () => {
    const promises = itDeskCopy()
      .filter(({ text }) => ENDPOINT_WORDS.test(text) && !DENIAL.test(text))
      .map(({ where, text }) => `${where}: ${text.trim().slice(0, 120)}`);
    expect(
      promises,
      `IT desk copy that reads as a promise of software on a machine:\n${promises.join("\n")}`,
    ).toEqual([]);
  });

  it("the denial is actually made, on the module's own page", () => {
    const view = readFileSync(
      join(process.cwd(), "src/components/client/itdesk/it-desk-view.tsx"),
      "utf8",
    );
    expect(view).toMatch(/no way to see, reach or control any computer/i);
    expect(view).toMatch(/there is no software of ours on any machine/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Slugs are not vocabulary.
// ---------------------------------------------------------------------------

/**
 * Hyphenated compounds the PRACTICE says out loud. They happen to be slugs too,
 * and banning them would be banning English: a receptionist says "after-hours",
 * an owner says "the co-pilot", everybody says "no-show". Kept short and
 * explicit, because every entry is a hole in the crawl and a hole nobody can
 * read is how a crawl dies.
 */
const PRACTICE_WORDS = new Set(["after-hours", "co-pilot", "no-show"]);

/**
 * The internal names that must never be printed. Derived from the catalog and the
 * nav rather than typed here, so a new module's slug joins the ban automatically.
 *
 * Single-word slugs ("recall", "equipment", "compliance") are excluded because
 * they are ordinary English AND are what the practice calls those things — there
 * is no second name to prefer. Hyphenated ones are the risk: "pre-visit-triage"
 * and "dentally-write-back" have proper names ("Pre-visit questions", "Dentally
 * write-back") and printing the slug means a screen stopped using them.
 */
function bannedSlugs(): string[] {
  const all = new Set<string>([...SYSTEM_SLUGS, ...CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug))]);
  return [...all].filter((s) => s.includes("-") && !PRACTICE_WORDS.has(s));
}

/**
 * Every string this lane puts in front of a person.
 *
 * `needsFirst` IS EXCLUDED BY NAME, and the exclusion is paid for rather than
 * assumed. It carries environment variable names, cron job names and account
 * names — DENTALLY_WRITE_ENABLED, PUBLIC_BASE_URL, /api/previsit/sweep — which
 * have no other name to be called by, and the person reading that line is the
 * person who arranges them. vocabulary.test.ts pins that it is the roster's own
 * list and not something typed into a screen, which is what the exclusion would
 * otherwise let through.
 */
function userVisibleCopy(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  for (const group of CLIENT_NAV) {
    for (const item of group.items) {
      out.push({ where: `nav label ${item.slug}`, text: item.label });
      if (item.note) out.push({ where: `nav note ${item.slug}`, text: item.note });
    }
  }
  for (const system of SYSTEMS) {
    out.push({ where: `catalog label ${system.slug}`, text: system.label });
    out.push({ where: `catalog halts ${system.slug}`, text: system.halts });
    // ROSTER-DERIVED SENTENCES ARE EXCLUDED, BY NAME AND WITH A REASON. Those
    // belong to the switch-on runbook (src/lib/agent-wiring/roster.ts), are
    // addressed to the person doing the go-live, and cross-reference other
    // agents by the slug printed on their switch — "becomes a speed-to-lead
    // lead" is how that reader finds the next thing to turn on. This lane
    // cannot launder its own copy through the hole, because vocabulary.test.ts
    // pins every roster-derived sentence to the roster's own string by identity.
    //
    // THE EXCLUSION IS FOR THE SLUG RULE ONLY, and it is paid for rather than
    // assumed: two roster sentences (`after-hours`, `smile-assessment`) really do
    // say "speed-to-lead", deliberately, because that is the name printed on the
    // switch the reader is being sent to next. Feeding them in here would ban the
    // cross-reference rather than close a hole.
    //
    // The hole the wave-3 review DID find through this condition was a different
    // rule — a sentence written in the deployment's environment-variable names —
    // and it is closed a few lines below over BOTH sources, where the slug
    // exclusion has no bearing. See "no switch-on sentence is written in
    // deployment identifiers".
    if (SYSTEM_VOCABULARY[system.slug].source === "module") {
      out.push({ where: `vocabulary starts ${system.slug}`, text: SYSTEM_VOCABULARY[system.slug].starts });
    }
  }
  for (const step of Object.values(FIRST_STEPS)) {
    out.push({ where: `first step ${step.key}`, text: `${step.surface} ${step.step}` });
  }
  for (const tile of OS_TILES) {
    out.push({ where: `os tile ${tile.key}`, text: tile.label });
  }
  return out;
}

describe("module copy speaks the practice's language, never a slug", () => {
  it("no hyphenated internal slug appears in anything a person reads", () => {
    const banned = bannedSlugs();
    expect(banned.length, "the slug list came back empty; it has gone stale").toBeGreaterThan(10);
    const hits: string[] = [];
    for (const { where, text } of userVisibleCopy()) {
      for (const slug of banned) {
        // Word-boundaried so "Pre-visit questions" is fine and
        // "pre-visit-triage" is not.
        if (new RegExp(`(^|[^A-Za-z0-9-])${slug}([^A-Za-z0-9-]|$)`).test(text)) {
          hits.push(`${where}: "${slug}" in "${text.slice(0, 90)}"`);
        }
      }
    }
    expect(hits, `internal slugs in user-visible copy:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the Operating system band's tiles are named the way the practice names them", () => {
    for (const tile of OS_TILES) {
      expect(tile.label).not.toBe(tile.moduleSlug);
      expect(tile.label[0]).toBe(tile.label[0].toUpperCase());
    }
  });
});

// ---------------------------------------------------------------------------
// 3b. Nor a deployment identifier — over BOTH sources this time.
// ---------------------------------------------------------------------------
//
// SCREAMING_SNAKE_CASE is an identifier, not a word. An owner holding the
// control panel has no way to read the value of `RECALL_DAILY_CONTACT_LIMIT`,
// has never been told the name, and cannot act on a sentence written in it.
//
// WHY IT IS CHECKED HERE AS WELL AS AT SOURCE. The rule is enforced where the
// sentences are written — src/lib/agent-wiring/roster.test.ts, "never names an
// environment variable" — and that is the assertion an author trips first. This
// is the SCREEN's own guard: `starts` reaches the practice through
// SYSTEM_VOCABULARY, from two different files by two different routes, and the
// wave-3 review found three offenders at once precisely because the crawl above
// sees only one of those routes. A rule enforced in one file is enforced for the
// authors who happen to edit that file.
//
// `needsFirst` IS STILL EXEMPT, by the same named citation as above
// (src/lib/systems/vocabulary.ts:50-55): it is the field where these names
// belong, printed under "Needs first" to the person who arranges them. The floor
// assertion below reads it with the same regex, so this cannot rot into a rule
// that matches nothing anywhere.

/** SCREAMING_SNAKE_CASE. Global, and only ever used with String.match. */
const DEPLOYMENT_IDENTIFIER = /\b[A-Z][A-Z0-9]{2,}(?:_[A-Z0-9]+)+\b/g;

describe("no switch-on sentence is written in deployment identifiers", () => {
  /** Every switch-on sentence a practice reads, from BOTH sources. */
  function switchOnSentences(): Array<{ where: string; text: string }> {
    const out: Array<{ where: string; text: string }> = [];
    for (const system of SYSTEMS) {
      const v = SYSTEM_VOCABULARY[system.slug];
      if (!v) continue;
      out.push({ where: `vocabulary starts ${system.slug} (${v.source})`, text: v.starts });
      out.push({ where: `catalog halts ${system.slug}`, text: system.halts });
    }
    for (const step of Object.values(FIRST_STEPS)) {
      out.push({ where: `first step ${step.key}`, text: step.step });
    }
    return out;
  }

  it("not on the control panel, the module page or the band", () => {
    const sentences = switchOnSentences();
    expect(
      sentences.length,
      "the switch-on crawl came back nearly empty; it has gone stale",
    ).toBeGreaterThan(30);
    // BOTH sources are actually in the crawl — the condition on the slug crawl
    // above must not be copied down here by a later edit.
    expect(
      new Set(SYSTEMS.map((s) => SYSTEM_VOCABULARY[s.slug]?.source).filter(Boolean)),
      "every vocabulary sentence now comes from one source; the both-sources claim is stale",
    ).toEqual(new Set(["roster", "module"]));
    const hits = sentences
      .filter(({ text }) => (text.match(DEPLOYMENT_IDENTIFIER) ?? []).length > 0)
      .map(({ where, text }) => `${where}: ${[...new Set(text.match(DEPLOYMENT_IDENTIFIER) ?? [])].join(", ")}`);
    expect(
      hits,
      `these print a deployment identifier to the practice owner:\n${hits.join("\n")}\n` +
        `Put the NUMBER in the sentence and leave the name in "Needs first".`,
    ).toEqual([]);
  });

  it("and the crawl can still see one where the name belongs", () => {
    // The floor. A "nothing matched" assertion over a regex nobody has proved
    // still matches is an always-true guard (ruling W3/17), so the same regex is
    // run over the one field that deliberately DOES carry these names.
    const needs = Object.values(SYSTEM_VOCABULARY).flatMap((v) => v.needsFirst);
    expect(needs.length, "no system declares a prerequisite at all").toBeGreaterThan(5);
    expect(
      needs.join(" ").match(DEPLOYMENT_IDENTIFIER) ?? [],
      "no prerequisite names an environment variable any more; the regex may have stopped matching",
    ).toContain("PUBLIC_BASE_URL");
  });
});

// ---------------------------------------------------------------------------
// 4. The empty states say what to do first — on the screen, not in a constant.
// ---------------------------------------------------------------------------

describe("every wave-1 surface's empty state says what to do first", () => {
  /**
   * Rendered, not grepped. A first step written into `first-steps.ts` and never
   * printed is exactly the failure this is for: the constant would satisfy a
   * source crawl while the practice looked at a blank table.
   */
  async function renderEmpty(module: string, extra: Record<string, unknown> = {}): Promise<string> {
    switch (module) {
      case "equipment": {
        const { EquipmentWorkspace } = await import("@/components/client/equipment/equipment-workspace");
        return renderToStaticMarkup(
          createElement(EquipmentWorkspace, {
            clientSlug: "vitality",
            assets: [],
            sites: [],
            systemEnabled: false,
            registerUnreadable: false,
            ...extra,
          }),
        );
      }
      case "it-desk": {
        const { ItDeskWorkspace } = await import("@/components/client/itdesk/it-desk-workspace");
        return renderToStaticMarkup(
          createElement(ItDeskWorkspace, {
            clientSlug: "vitality",
            playbooksByArea: [],
            contact: { name: "", company: "", phone: "", email: "", hours: "", notes: "" },
            contactUnavailable: false,
            canEditContact: true,
            systemEnabled: false,
            ...extra,
          }),
        );
      }
      case "pre-visit-triage": {
        const { PreVisitWorkspace } = await import("@/components/client/previsit/previsit-workspace");
        return renderToStaticMarkup(
          createElement(PreVisitWorkspace, {
            clientSlug: "vitality",
            isOwner: true,
            treatments: [],
            interest: [],
            interestCounts: {},
            mining: [],
            miningTitle: "Implant interest",
            miningCoverage: "",
            miningExclusions: "",
            miningCaveats: [],
            systemEnabled: false,
            ...extra,
          }),
        );
      }
      case "authorities": {
        const { AuthoritiesPanel } = await import("@/components/client/copilot/authorities-panel");
        return renderToStaticMarkup(createElement(AuthoritiesPanel, { clientSlug: "vitality", ...extra }));
      }
      default:
        throw new Error(`no empty-state renderer for ${module}`);
    }
  }

  /**
   * A distinctive fragment of each shared first step, as it must appear on
   * screen. Apostrophe-free on purpose: React escapes `'` to `&#x27;` in static
   * markup, so a fragment carrying one fails for a reason that has nothing to do
   * with the copy being present.
   */
  const ON_SCREEN: Array<[string, string]> = [
    ["equipment", "Import the register you already keep for CQC"],
    ["it-desk", "IT contact — the person or company a problem goes to"],
    ["pre-visit-triage", "Review the two question lists"],
  ];

  for (const [module, fragment] of ON_SCREEN) {
    it(`${module} prints its first step when it is empty`, async () => {
      // The fragment is a piece of the SHARED sentence, not a lookalike typed
      // into the component. If the two ever part company the constant has
      // stopped being the thing on the screen, and this goes red rather than
      // passing on a coincidence.
      expect(FIRST_STEPS[module].step).toContain(fragment);
      const html = await renderEmpty(module);
      expect(html).toContain(fragment);
    });
  }

  /**
   * The surfaces whose first step cannot be RENDERED here, proved instead by the
   * component's own call — NAMING THIS KEY. Never "somebody, somewhere, calls
   * firstStepFor", which is what the reverse-direction check used to settle for.
   *
   * The approved-sources panel is the only one: it is collapsed until an owner
   * opens it and its list arrives from a fetch, so a static render of the default
   * state prints the closed drawer and nothing else. What is proved is that this
   * component asks for THIS key's sentence and prints what it is handed.
   */
  const CITED_IN_SOURCE: Array<[string, string, string]> = [
    [
      "authorities",
      "src/components/client/copilot/authorities-panel.tsx",
      "Add the first source your practice trusts",
    ],
  ];

  /**
   * THE SURFACE WITH NO PAGE OF ITS OWN — named, rendered, and the reason it is
   * a third list rather than a fourth hole.
   *
   * `dentally-write-back` is a lever, not a module. It has no module page to
   * hold an empty state, and its Operating system band tile is the one tile
   * with `countsWhileOff` (src/lib/home/os-band.ts), so the band always resolves
   * it to a figure or a fact and the `off` branch that carries a first step is
   * unreachable for exactly this tile. The screen that can carry the sentence is
   * the control panel's own switched-off row — one tab to the left of the
   * Dentally sync tab the sentence tells the owner to read — so that is where it
   * is printed, and it is rendered here rather than grepped for.
   *
   * This list replaces the one-key exemption that stood below ("the first step
   * no screen prints"): the handoff landed in wave 3b — `SystemRow` gained the
   * `firstStep` field /api/systems was already sending, and the off row prints
   * it. The two facts that made the hole are still pinned, below.
   */
  const ON_A_SWITCHED_OFF_ROW: Array<[string, string]> = [
    ["dentally-write-back", "Read the Dentally sync tab first"],
  ];

  for (const [key, fragment] of ON_A_SWITCHED_OFF_ROW) {
    it(`${key} prints its first step on the control panel's switched-off row`, async () => {
      expect(FIRST_STEPS[key].step).toContain(fragment);
      const { SystemRowLine } = await import("@/components/client/systems/systems-view");
      const html = renderToStaticMarkup(
        createElement(SystemRowLine, {
          row: {
            slug: key,
            label: "Dentally write-back",
            group: "Dentally",
            halts: "Nothing this platform does reaches your Dentally book.",
            starts: "Appointments and patient records made here start reaching your Dentally book.",
            needsFirst: [],
            firstStep: FIRST_STEPS[key].step,
            enabled: false,
            updatedAt: null,
            updatedBy: null,
          },
          busy: false,
          onToggle: () => {},
        }),
      );
      expect(html).toContain(fragment);
      // ...and the row is fed by the route, not only by this test: /api/systems
      // projects `vocabularyFor(slug).firstStep`, which is this same sentence.
      expect(SYSTEM_VOCABULARY[key].firstStep).toBe(FIRST_STEPS[key].step);
    });
  }

  for (const [key, file, fragment] of CITED_IN_SOURCE) {
    it(`the ${key} panel asks for its own first step by name and prints it`, () => {
      expect(FIRST_STEPS[key].step).toContain(fragment);
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Keyed and printed: a component that called for somebody else's sentence,
      // or called for its own and dropped it on the floor, fails here.
      expect(source, `${file} does not print firstStepFor("${key}")`).toMatch(
        new RegExp(`\\{\\s*firstStepFor\\("${key}"\\)\\?\\.step\\s*\\}`),
      );
    });
  }

  /**
   * THE EXEMPTION THAT CLOSED, AND THE TWO FACTS THAT MUST NOT COME BACK.
   *
   * `dentally-write-back` stood here as the one first step no screen printed —
   * written, serialised by /api/systems, and read by nobody. The handoff landed
   * in wave 3b, so the key now sits in ON_A_SWITCHED_OFF_ROW above and is
   * proved by a render rather than excused by a list.
   *
   * What survives the exemption is the pair of facts that made the hole, kept
   * so that closing it cannot be quietly undone: the band still CANNOT print
   * this sentence (its tile counts while off, deliberately — held-back writes
   * accrue because the system is off, so a tile that went quiet while off would
   * hide the number the owner came for), and the panel still CAN.
   */
  it("the write-back first step still has the one screen that can carry it", () => {
    const writeBack = OS_TILES.find((t) => t.systemSlug === "dentally-write-back");
    expect(
      writeBack?.countsWhileOff,
      "the band's write-back tile stopped counting while off — it can print the first step again, and two screens now carry one sentence",
    ).toBe(true);
    const panel = readFileSync(
      join(process.cwd(), "src/components/client/systems/systems-view.tsx"),
      "utf8",
    );
    expect(
      panel,
      "the control panel stopped rendering firstStep — the write-back sentence reaches nobody again",
    ).toMatch(/row\.firstStep/);
  });

  it("every first step is accounted for: rendered, cited, or named as reaching no screen", () => {
    // THE REVERSE DIRECTION, PER KEY. A sentence in `first-steps.ts` that no
    // component ever prints is dead copy pretending to be a feature, and the
    // check that stood here could not see one: its second disjunct never
    // mentioned the key, so a single file calling `firstStepFor` anywhere in the
    // four trees made every key look used, for ever (ruling W3/17).
    const accounted = [
      ...ON_SCREEN.map(([key]) => key),
      ...ON_A_SWITCHED_OFF_ROW.map(([key]) => key),
      ...CITED_IN_SOURCE.map(([key]) => key),
    ].sort();
    // No key is proved twice: a duplicate would let a real gap hide behind it.
    expect(new Set(accounted).size, "a first step is accounted for twice").toBe(accounted.length);
    expect(
      accounted,
      "a first step is written with no screen proof — render it, cite it, or name it",
    ).toEqual(Object.keys(FIRST_STEPS).sort());
  });
});

// ---------------------------------------------------------------------------
// 5. The pre-visit link is its OWN text, and every surface that describes its
//    delivery says so (ruling W3/9: copy matches code, never the reverse).
// ---------------------------------------------------------------------------

/**
 * WHAT THE CODE ACTUALLY DOES, which is what these sentences have to match.
 *
 * `previsitBody` (src/lib/triage/copy.ts) composes ONE standalone SMS carrying
 * ONE link, under a 160-character one-credit ceiling — its own comment records
 * why the medical-history link is not in it (two signed links do not fit in one
 * credit, so the handover moved to the thank-you screen) and why the appointment
 * time is not in it either ("the time is in the confirmation the no-show module
 * already sends"). It is enqueued into the module's own `previsit_touch` /
 * `previsit_outbox` by the pre-visit sweep, which is `enqueueSend`'s only caller
 * in the tree, on its own schedule (appointment start minus PREVISIT_LEAD_HOURS,
 * default 24). The drain lists `previsit` as a source of its own and marks it
 * `transactional: true`, so it is exempt from the once-per-day cap and cannot
 * even collapse into the no-show reminder that is drafted for the same hour.
 *
 * So a surface that says the questionnaire is "sent with the reminder" is not
 * loose wording, it is a wrong number: it tells the owner that switching this
 * module on adds no messages, when it adds one text — one credit, one
 * interruption — per upcoming appointment. Both directions are asserted here,
 * because the forbidden-phrase half alone is satisfied by saying nothing at all.
 */
const CO_DELIVERY =
  /\b(?:with|alongside|together with|attached to|as part of|inside|bundled with|piggyback(?:ed|ing)? on)\s+(?:the\s+)?(?:appointment\s+|no-show\s+)?(?:reminder|confirmation|medical[-\s]history\s+link)\b/i;

/** Every sentence the platform prints about how the pre-visit link is delivered. */
function previsitDeliveryCopy(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const navItem = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "pre-visit-triage");
  if (navItem?.note) out.push({ where: "nav note (src/lib/nav.ts)", text: navItem.note });
  const system = SYSTEMS.find((s) => s.slug === "pre-visit-triage");
  if (system) out.push({ where: "catalog halts (src/lib/systems/catalog.ts)", text: system.halts });
  out.push({
    // Identical by identity to the roster's `firstTick` (vocabulary.test.ts pins
    // that), so this entry covers the control panel AND the roster at once.
    where: "control panel starts / roster firstTick",
    text: SYSTEM_VOCABULARY["pre-visit-triage"].starts,
  });
  return out;
}

describe("the pre-visit questionnaire is described as the separate text it is", () => {
  it("no surface claims it travels with the reminder or the medical-history link", () => {
    const surfaces = previsitDeliveryCopy();
    expect(surfaces.length, "the pre-visit copy surfaces came back empty; the crawl has gone stale").toBe(3);
    const hits = surfaces
      .filter(({ text }) => CO_DELIVERY.test(text))
      .map(({ where, text }) => `${where}: "${text.slice(0, 120)}"`);
    expect(
      hits,
      `copy claiming the pre-visit link rides inside another message:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  it("the two surfaces that describe the delivery say it is its own message", () => {
    // The catalog's `halts` is about switching OFF and is deliberately not asked
    // to carry this; the nav note and the control panel's "what switching it on
    // starts" are the two an owner reads while deciding to turn it on.
    const navItem = CLIENT_NAV.flatMap((g) => g.items).find((i) => i.slug === "pre-visit-triage");
    for (const [where, text] of [
      ["nav note", navItem?.note ?? ""],
      ["control panel starts", SYSTEM_VOCABULARY["pre-visit-triage"].starts],
    ] as Array<[string, string]>) {
      expect(text, `${where} is empty`).not.toBe("");
      expect(text, `${where} does not say the invite is its own text`).toMatch(/\bits own text\b/i);
      expect(text, `${where} does not say it is separate from the other messages`).toMatch(/\bseparate\b/i);
      expect(text, `${where} does not name the cost of switching it on`).toMatch(
        /\bone extra (?:message|text) per appointment\b/i,
      );
    }
  });

  it("the message the module actually sends carries one link and mentions nothing else", () => {
    // The anchor for the copy rule above: if this ever became a two-link message
    // the sentences would be wrong in the other direction, and this goes red.
    const body = previsitBody({
      firstName: "Priya",
      practiceName: "Vitality Dental",
      link: "https://example.test/pv/abcdefghijklmnopqrstuv",
    });
    expect(body.match(/https?:\/\//g) ?? []).toHaveLength(1);
    expect(body).not.toMatch(/reminder|medical|history|appointment time/i);
  });
});

// ---------------------------------------------------------------------------
// 6. A first step never presents the switch as the last step when the sweep
//    behind it has no scheduled job (ruling W3/7: registration truth).
// ---------------------------------------------------------------------------
//
// THE FAILURE THIS IS FOR, in the order it happened. The platform's own first
// step said "review the two question lists, then switch the system on. Nothing
// is sent to a patient until you do." The owner does exactly that; from that
// second the control panel says "Running.", the module's banner disappears and
// Home's tile prints a bare nought — for a sweep the scheduler has never been
// told about, which therefore sends nothing that day or any other. Every word
// on the screen was true and the practice was still waiting on a system that
// could not start.
//
// The control panel now carries the fact twice (`registrationWarning` on the on
// row, "Needs first" on the off row), but this sentence is printed on two
// screens that carry NEITHER: the module's own empty state and the Operating
// system band. So the sentence says it itself.
//
// BOTH DIRECTIONS, which is the whole point of deriving it. SWEEPS_WITH_NO_CRON_JOB
// is the tree's browser-side record of registration truth and is pinned against
// the runbook's cron table by cron-registration.test.ts. The day one of these
// jobs is registered and its slug leaves that list, the warning in the first
// step is the stale sentence — and this goes red for the opposite reason.

describe("a first step says so when its sweep has no scheduled job", () => {
  /** The sentence warns, in the practice's words, that the job is not registered. */
  const WARNS = /scheduled job/i;
  const NOT_YET = /has not been done yet|never been registered|not (?:yet )?registered/i;

  it("the pair of lists actually overlap, or there is nothing to prove", async () => {
    const { SWEEPS_WITH_NO_CRON_JOB } = await import("@/components/client/systems/systems-view");
    expect(SWEEPS_WITH_NO_CRON_JOB.length, "no sweep is recorded as unregistered").toBeGreaterThan(0);
    const overlap = Object.keys(FIRST_STEPS).filter((k) => SWEEPS_WITH_NO_CRON_JOB.includes(k));
    expect(
      overlap,
      "no first step belongs to an unregistered sweep any more; the rule below proves nothing",
    ).toContain("pre-visit-triage");
  });

  it("every first step for an unregistered sweep warns, and no other one does", async () => {
    const { SWEEPS_WITH_NO_CRON_JOB } = await import("@/components/client/systems/systems-view");
    const missing: string[] = [];
    const stale: string[] = [];
    for (const step of Object.values(FIRST_STEPS)) {
      const unregistered = SWEEPS_WITH_NO_CRON_JOB.includes(step.key);
      const warns = WARNS.test(step.step) && NOT_YET.test(step.step);
      if (unregistered && !warns) missing.push(step.key);
      if (!unregistered && warns) stale.push(step.key);
    }
    expect(
      missing,
      `these first steps end at the switch, but the sweep behind them has no scheduled job, so ` +
        `switching on starts nothing: ${missing.join(", ")}`,
    ).toEqual([]);
    expect(
      stale,
      `these first steps warn about an unregistered job for a sweep the scheduler now holds: ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("the warning reaches the module's own empty state, not only the control panel", async () => {
    // Rendered, for the same reason as section 4: a warning written into the
    // constant and dropped by the component is the failure being guarded.
    const html = await renderEmptyPreVisit();
    expect(html).toContain("nothing is sent after that either");
  });
});

/**
 * The pre-visit workspace's empty state. A narrow copy of section 4's renderer,
 * kept local so this section does not reach into that describe's closure.
 */
async function renderEmptyPreVisit(): Promise<string> {
  const { PreVisitWorkspace } = await import("@/components/client/previsit/previsit-workspace");
  return renderToStaticMarkup(
    createElement(PreVisitWorkspace, {
      clientSlug: "vitality",
      isOwner: true,
      treatments: [],
      interest: [],
      interestCounts: {},
      mining: [],
      miningTitle: "Implant interest",
      miningCoverage: "",
      miningExclusions: "",
      miningCaveats: [],
      systemEnabled: false,
    }),
  );
}
