// THE PERMISSIONS SCREEN IS PERSON-FIRST AND COLLAPSED, and this suite pins the
// three things that restructure could quietly break: that a closed row shows no
// switches at all, that an open one shows EVERY capability group, and that a
// person the server would refuse to write still cannot be touched here.
//
// TECHNIQUE. vitest runs environment:"node" and collects only src/**\/*.test.ts,
// so this is createElement + renderToStaticMarkup for what the row PAINTS, plus
// the component source read as text for what a static render cannot show — which
// state the screen starts in, and that no part of it scrolls sideways any more.
// Same split as flow-inspector.test.ts.
//
// WHAT IS NOT HELD HERE. Whether a write is ALLOWED is the server's answer and is
// pinned in src/lib/capabilities/admin-rules.test.ts and
// src/app/api/permissions/route.test.ts. Nothing on this screen is a security
// boundary; these tests hold that the screen does not INVITE a click the server
// will refuse.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CAPABILITIES } from "@/lib/capabilities/keys";
import { PROTECTED_SUBJECT_ROLES } from "@/lib/capabilities/admin-rules";
import {
  GROUP_LABEL,
  PermissionsLegend,
  PersonAccordionRow,
  decidedForPerson,
  groupCapabilities,
  personLockReason,
  type CapabilityCol,
  type PersonRow,
} from "./permissions-view";

const HERE = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(HERE, "permissions-view.tsx"), "utf8");

/** Source with comments stripped: what the file DOES, not what it explains. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const code = codeOnly(source);

/** React escapes its way out; asserting on raw copy passes only by luck. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Every switch the markup actually contains, as its opening tag. */
function switchTags(html: string): string[] {
  return html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
}

/** Switches a screen reader — and a mouse — would find unusable. */
function disabledSwitches(html: string): string[] {
  return switchTags(html).filter((tag) => tag.includes("disabled="));
}

/**
 * The markup with every `title` attribute removed.
 *
 * A hover tooltip is not an explanation: it is invisible on a touch screen and
 * to anyone who never happens to hover. Asserting a reason against THIS proves
 * the screen says it out loud, not that some row carries it as a tooltip.
 */
function withoutTooltips(html: string): string {
  return html.replace(/ title="[^"]*"/g, "");
}

// ---------------------------------------------------------------------------
// Fixtures. The REAL catalog, shaped exactly the way /api/permissions shapes it,
// so "every group" means every group the platform actually has.
// ---------------------------------------------------------------------------

const COLUMNS: CapabilityCol[] = CAPABILITIES.map((c) => ({
  key: c.key,
  group: c.group,
  label: c.label,
  description: c.description,
  destructive: c.destructive,
  locked: Boolean(c.locked),
}));

const GROUPS = groupCapabilities(COLUMNS);

const LOCKED_COLUMN = COLUMNS.find((c) => c.locked)!;
const OPEN_COLUMN = COLUMNS.find((c) => !c.locked)!;

function person(overrides: Partial<PersonRow> = {}): PersonRow {
  return {
    id: "person-1",
    name: "Blerta Azemaj",
    email: "blerta@example.com",
    role: "client_coordinator",
    cells: COLUMNS.map((c) => ({ capability: c.key, held: false, source: "role" as const })),
    ...overrides,
  };
}

function withOverride(p: PersonRow, capability: string): PersonRow {
  return {
    ...p,
    cells: p.cells.map((c) =>
      c.capability === capability ? { ...c, held: true, source: "granted" as const } : c,
    ),
  };
}

const NOOP = () => {};

function renderRow(opts: {
  person: PersonRow;
  expanded: boolean;
  protectedRoles?: string[];
  actorId?: string | null;
}): string {
  const protectedRoles = new Set(opts.protectedRoles ?? [...PROTECTED_SUBJECT_ROLES]);
  const actorId = opts.actorId ?? null;
  const lockReason = personLockReason(opts.person, protectedRoles, actorId);
  return renderToStaticMarkup(
    createElement(PersonAccordionRow, {
      person: opts.person,
      groups: GROUPS,
      expanded: opts.expanded,
      onExpandToggle: NOOP,
      lockReason,
      busy: new Set<string>(),
      lockedReason: (p: PersonRow, c: CapabilityCol) =>
        c.locked
          ? "This one comes with being an owner. It cannot be switched on or off for anybody."
          : personLockReason(p, protectedRoles, actorId),
      onToggle: NOOP,
      onReset: NOOP,
    }),
  );
}

// ---------------------------------------------------------------------------
// 1. COLLAPSED IS THE DEFAULT, AND COLLAPSED MEANS NOTHING BUT THE NAME.
// ---------------------------------------------------------------------------

describe("the list of people is collapsed", () => {
  it("a collapsed person shows their name and role and NOT a single switch", () => {
    const html = renderRow({ person: person(), expanded: false });
    expect(html).toContain("Blerta Azemaj");
    expect(html).toContain("Practice manager");
    // The whole point of the redesign: no wall of toggles until you ask for one.
    expect(html).not.toContain('role="switch"');
    expect(occurrences(html, 'role="switch"')).toBe(0);
  });

  it("a collapsed person renders no capability group headings and no capability labels", () => {
    const html = renderRow({ person: person(), expanded: false });
    for (const { group } of GROUPS) {
      expect(html).not.toContain(esc(GROUP_LABEL[group] ?? group));
    }
    expect(html).not.toContain(esc(OPEN_COLUMN.label));
  });

  it("the screen opens with nobody expanded, and only one person at a time", () => {
    // Static render cannot reach the container's state (it fetches in an effect),
    // so this is the source: the open id starts null, and picking a second person
    // replaces the first rather than adding to it.
    expect(code).toContain("useState<string | null>(null)");
    expect(code).toContain("current === person.id ? null : person.id");
  });

  it("the summary line says how many capabilities were set by hand for that person", () => {
    const plain = renderRow({ person: person(), expanded: false });
    expect(plain).toContain("Follows their role");

    const edited = withOverride(withOverride(person(), OPEN_COLUMN.key), COLUMNS[1].key);
    expect(decidedForPerson(edited)).toBe(2);
    expect(renderRow({ person: edited, expanded: false })).toContain("2 set by hand");
  });
});

// ---------------------------------------------------------------------------
// 2. THE DISCLOSURE IS A REAL ONE.
// ---------------------------------------------------------------------------

describe("the expand control is a keyboard-reachable disclosure", () => {
  it("the summary is a button carrying aria-expanded and aria-controls", () => {
    const closed = renderRow({ person: person(), expanded: false });
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('aria-controls="permissions-panel-person-1"');
    expect(closed).toContain('type="button"');

    const open = renderRow({ person: person(), expanded: true });
    expect(open).toContain('aria-expanded="true"');
  });

  it("the panel it names exists when open, and points back at the button", () => {
    const open = renderRow({ person: person(), expanded: true });
    expect(open).toContain('id="permissions-panel-person-1"');
    expect(open).toContain('aria-labelledby="permissions-person-person-1"');
    expect(open).toContain('id="permissions-person-person-1"');
  });
});

// ---------------------------------------------------------------------------
// 3. AN OPEN PERSON SHOWS THEIR WHOLE PERMISSION SET.
// ---------------------------------------------------------------------------

describe("an expanded person shows every capability group", () => {
  it("heads every group in the real catalog", () => {
    const html = renderRow({ person: person(), expanded: true });
    expect(GROUPS.length).toBeGreaterThan(1);
    for (const { group } of GROUPS) {
      expect(html).toContain(esc(GROUP_LABEL[group] ?? group));
    }
  });

  it("renders one switch per capability, named for the capability AND the person", () => {
    const html = renderRow({ person: person(), expanded: true });
    expect(occurrences(html, 'role="switch"')).toBe(COLUMNS.length);
    expect(html).toContain(esc(`${OPEN_COLUMN.label} for Blerta Azemaj`));
  });

  it("labels each capability and explains what it means, without a sideways scroll", () => {
    const html = renderRow({ person: person(), expanded: true });
    expect(html).toContain(esc(OPEN_COLUMN.label));
    expect(html).toContain(esc(OPEN_COLUMN.description));
    // The old grid was one wide table per group; nothing may scroll sideways now.
    expect(code).not.toContain("overflow-x-auto");
    expect(code).not.toContain("min-w-max");
    expect(code).not.toContain("gridTemplateColumns");
  });
});

// ---------------------------------------------------------------------------
// 4. LOCKED ROWS STAY LOCKED, AND STILL SAY WHY.
// ---------------------------------------------------------------------------

describe("locked rows stay locked", () => {
  it("an owner's every switch is disabled, and the panel says why", () => {
    const owner = person({ id: "owner-1", name: "Jawad Khursheed", role: "client_owner" });
    const html = renderRow({ person: owner, expanded: true });
    // Every capability is still SHOWN — the owner can read what an owner holds —
    // and not one of them can be clicked.
    expect(switchTags(html)).toHaveLength(COLUMNS.length);
    expect(disabledSwitches(html)).toHaveLength(COLUMNS.length);
    // SAID OUT LOUD, not merely hung off a tooltip.
    expect(withoutTooltips(html)).toContain(
      esc("An owner's permissions cannot be changed here."),
    );
  });

  it("your own row is disabled, and tells you to ask the other owner", () => {
    const me = person({ id: "me-1", role: "client_coordinator" });
    const html = renderRow({ person: me, expanded: true, actorId: "me-1" });
    expect(disabledSwitches(html)).toHaveLength(COLUMNS.length);
    expect(withoutTooltips(html)).toContain(
      esc("You cannot change your own permissions. Ask the other owner."),
    );
  });

  it("an editable person's switches are live, apart from the owner-only ones", () => {
    const html = renderRow({ person: person(), expanded: true, actorId: "somebody-else" });
    expect(html).not.toContain(esc("An owner's permissions cannot be changed here."));
    expect(html).not.toContain(esc("You cannot change your own permissions. Ask the other owner."));
    const lockedColumns = COLUMNS.filter((c) => c.locked).length;
    expect(lockedColumns).toBeGreaterThan(0);
    expect(disabledSwitches(html)).toHaveLength(lockedColumns);
    expect(switchTags(html).length - disabledSwitches(html).length).toBe(
      COLUMNS.length - lockedColumns,
    );
  });

  it("an owner-only capability is refused for everybody, and wears the lock the legend explains", () => {
    expect(LOCKED_COLUMN).toBeTruthy();
    const html = renderRow({ person: person(), expanded: true, actorId: "somebody-else" });
    const reason = esc(
      "This one comes with being an owner. It cannot be switched on or off for anybody.",
    );
    // EXACTLY the owner-only capabilities carry it, and no others: a reason that
    // leaked onto an ordinary row would grey a switch the server would happily
    // have written.
    expect(occurrences(html, `title="${reason}"`)).toBe(COLUMNS.filter((c) => c.locked).length);
    expect(html).toContain("lucide-lock");
  });

  it("the person-level lock is computed by ONE function, shared by the banner and the switch", () => {
    const owner = person({ role: "client_owner" });
    expect(personLockReason(owner, new Set(PROTECTED_SUBJECT_ROLES), null)).toBe(
      "An owner's permissions cannot be changed here.",
    );
    expect(personLockReason(person(), new Set(PROTECTED_SUBJECT_ROLES), "person-1")).toBe(
      "You cannot change your own permissions. Ask the other owner.",
    );
    expect(personLockReason(person(), new Set(PROTECTED_SUBJECT_ROLES), "someone-else")).toBeNull();
    // `lockedReason` must keep composing with it rather than growing a second copy.
    expect(code).toContain("return personLockReason(person, protectedRoles, actorId);");
  });
});

// ---------------------------------------------------------------------------
// 5. THE LEGEND AND THE RESET ARROW SURVIVED THE RESTRUCTURE.
// ---------------------------------------------------------------------------

describe("the legend still explains the screen", () => {
  it("names all three meanings", () => {
    const html = renderToStaticMarkup(createElement(PermissionsLegend));
    expect(html).toContain(
      esc("Set by hand for this person — the arrow puts it back to their role"),
    );
    expect(html).toContain(esc("Comes with being an owner; cannot be given to anyone else"));
    expect(html).toContain("An owner");
    expect(html).toContain(esc("row, and your own, cannot be changed here."));
  });

  it("the legend is rendered on the screen itself, not just exported", () => {
    expect(code).toContain("<PermissionsLegend />");
  });
});

describe("the revert-to-role-default arrow is still reachable", () => {
  it("a capability set by hand offers a reset control that names itself", () => {
    const edited = withOverride(person(), OPEN_COLUMN.key);
    const html = renderRow({ person: edited, expanded: true });
    expect(html).toContain(
      esc(`Reset ${OPEN_COLUMN.label} for Blerta Azemaj to their role default`),
    );
    expect(html).toContain(esc("Set by hand. Reset to what their role allows."));
  });

  it("a capability that follows the role offers no reset", () => {
    const html = renderRow({ person: person(), expanded: true });
    expect(html).not.toContain("to their role default");
  });

  it("the reset deletes the override rather than writing the role's answer back", () => {
    // The absence of a row IS "ask the role" — see the DELETE handler's comment.
    expect(code).toContain('method: "DELETE"');
  });
});

// ---------------------------------------------------------------------------
// 6. THE RESTRUCTURE DID NOT CROSS THE RSC BOUNDARY.
// ---------------------------------------------------------------------------

describe("the screen stays on the client side of the boundary", () => {
  it("is one client component, and pulls in no shared primitive that a server page renders with functions", () => {
    expect(source.trimStart().startsWith('"use client"')).toBe(true);
    // DataTable and Tabs must never be dragged into a file like this: the lesson
    // is that a shared primitive with function props cannot become a client
    // component, and the crash only shows at render.
    expect(code).not.toContain("DataTable");
    expect(code).not.toContain("Tabs");
  });
});
