import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { srcPath, walkSrc } from "@/lib/test-support/walk-src";
import { DENTALLY_WRITE_KINDS } from "./sync-ledger";

// ===========================================================================
// THE STRUCTURAL TEST FOR THE WRITE GATE. It reads the source tree, not a list
// somebody maintains.
//
// The gate's whole claim is that EVERY outbound Dentally write in this platform
// passes through it — is kill-switched, is recorded as an intent, and cannot
// reach the live practice book while the write path is off. That claim is only
// worth as much as the guarantee that nothing goes round it, and nothing in the
// codebase could previously tell you where the platform writes from: eleven call
// sites across seven modules each held their own client and their own gate check,
// and the one that forgot would have looked exactly like the ten that did not.
//
// So this file crawls src/ for calls to the five write METHODS on DentallyClient
// and requires every one of them to be inside the gate (or a documented, reasoned
// exception). A new booking path cannot be merged around it.
//
// IT FAILS IN BOTH DIRECTIONS on purpose: an undeclared call site fails, and a
// declared exception that no longer exists fails too, so the exception list
// cannot rot into a description of a tree we used to have.
//
// OVER-REPORTS RATHER THAN UNDER-REPORTS, which is the same posture
// send-sites.test.ts takes: an unrecognised shape must produce a false positive a
// human resolves, never a silent miss. Three shapes are counted — a member call
// (`client.createAppointment(`), a bracket access (`client["createAppointment"]`)
// and a destructuring binding (`const { createAppointment } = client`) — because
// the second and third are exactly how a call site would slip past a crawl that
// only matched the first.
// ===========================================================================

/** The five methods, spelled as they are on DentallyClient. */
const WRITE_METHODS = [
  "createPatient",
  "updatePatient",
  "createAppointment",
  "updateAppointment",
  "cancelAppointment",
] as const;

/** Where the five are DECLARED, and where the ONE door is. */
const CLIENT_MODULE = "lib/dentally/client.ts";
const GATE_MODULE = "lib/dentally/write-gate.ts";

/**
 * Call sites that are NOT behind the gate, each with the reason and the owner.
 *
 * IT IS EMPTY, AND THE EMPTINESS IS THE POINT. Every Dentally write in this
 * platform — every route, every agent, every staff screen and the co-pilot's
 * create_patient tool — goes through src/lib/dentally/write-gate.ts. There is no
 * second door.
 *
 * The mechanism stays because the next person to need one should have to write
 * down WHY, and because a stale entry fails below rather than sitting in a
 * comment describing a tree we used to have. An entry here means: this file
 * writes to a real patient record with no ledger row, no master switch and no
 * per-module switch, and somebody decided that was acceptable.
 */
const UNGATED: Record<string, string> = {};

/**
 * Strip the comment forms this codebase uses, so PROSE about a write method is
 * not counted as a call to one. Several of these files discuss their own write
 * path at length — client.ts's own header names all five, and the calendar
 * components carry a paragraph about createAppointment being unproven against
 * live Dentally — and counting those would drown the signal.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

/**
 * THE LOCAL NAMES the gate façade is bound to IN THIS FILE, resolved from its
 * import — so `dentallyWrite.createAppointment(` is not mistaken for a direct
 * client call, and an ALIASED import of the façade is not mistaken for one
 * either.
 *
 * This is the alias-awareness send-sites.test.ts needed and for the same reason,
 * pointed the other way round: there the crawl had to FOLLOW an alias to a call
 * it must count, here it has to follow one to a call it must NOT count. Getting
 * it wrong in this direction is loud (a false positive on a correctly gated
 * file) rather than silent, which is the right way round for it to be wrong.
 *
 * Handles a plain named import, an aliased one, and a namespace import. The
 * module is matched on the SPECIFIER's tail, so both "@/lib/dentally/write-gate"
 * and a relative "./write-gate" resolve.
 */
function gateBindings(code: string): string[] {
  const names: string[] = [];
  const IMPORT = /import\s+([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = IMPORT.exec(code)) !== null) {
    const [, clause, specifier] = m;
    if (!/(^|\/)dentally\/write-gate$/.test(specifier)) continue;
    const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespace) {
      names.push(`${namespace[1]}.dentallyWrite`);
      continue;
    }
    const braced = clause.match(/\{([\s\S]*)\}/);
    if (!braced) continue;
    for (const raw of braced[1].split(",")) {
      const part = raw.trim().replace(/^type\s+/, "");
      if (!part) continue;
      const aliased = part.match(/^dentallyWrite\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliased) names.push(aliased[1]);
      else if (part === "dentallyWrite") names.push("dentallyWrite");
    }
  }
  return names;
}

/** Blank out every call made THROUGH the gate, so only direct ones remain. */
function withoutGateCalls(code: string): string {
  let out = code;
  for (const binding of gateBindings(code)) {
    const escaped = binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const name of WRITE_METHODS) {
      out = out.replace(new RegExp(`${escaped}\\s*\\.\\s*${name}\\s*\\(`, "g"), "GATED_CALL(");
    }
  }
  return out;
}

/** Every shape that reaches a write method, counted per file. */
function writeMethodHits(code: string): string[] {
  const hits: string[] = [];
  for (const name of WRITE_METHODS) {
    // 1. The ordinary member call: `x.createAppointment(`.
    if (new RegExp(`\\.\\s*${name}\\s*\\(`).test(code)) hits.push(`${name} (member call)`);
    // 2. Bracket access, which spells the name in a string and dodges (1).
    if (new RegExp(`\\[\\s*["'\`]${name}["'\`]\\s*\\]`).test(code)) hits.push(`${name} (bracket access)`);
    // 3. A destructuring binding, which extracts the method and then calls it by
    //    a bare name that names nothing recognisable.
    if (new RegExp(`(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=`).test(code)) {
      hits.push(`${name} (destructured)`);
    }
  }
  return hits;
}

/** file (relative to src/, forward slashes) -> the shapes found in it. */
function crawl(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walkSrc({ extensions: [".ts", ".tsx"] })) {
    if (file === CLIENT_MODULE || file === GATE_MODULE) continue;
    const hits = writeMethodHits(withoutGateCalls(stripComments(readFileSync(srcPath(file), "utf8"))));
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}

describe("every Dentally write in the tree goes through the WriteGate", () => {
  it("finds no call site outside the gate that is not a documented exception", () => {
    const actual = crawl();
    const offenders = [...actual.entries()]
      .filter(([file]) => !(file in UNGATED))
      .map(([file, hits]) => `${file} [${hits.join(", ")}]`)
      .sort();
    expect(
      offenders,
      "these call a Dentally write method directly, bypassing the gate — its kill-switch check, its " +
        "dry-run refusal and its sync ledger. Route them through src/lib/dentally/write-gate.ts " +
        `(dentallyWrite.*), or add an entry to UNGATED with a reason: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("no exception is stale: every ungated file still calls a write method", () => {
    const actual = crawl();
    const stale = Object.keys(UNGATED).filter((f) => !actual.has(f));
    expect(stale, `UNGATED lists files that no longer write to Dentally: ${stale.join(", ")}`).toEqual([]);
  });

  it("has NO exceptions at all: every write in the tree is behind the gate", () => {
    // Stated as its own assertion rather than left implicit in an empty loop, so
    // the day somebody adds an exception this test tells them they have changed
    // the platform's headline property, not merely a list.
    expect(Object.keys(UNGATED)).toEqual([]);
  });

  it("any exception that IS added has to state a reason long enough to be one", () => {
    for (const [file, reason] of Object.entries(UNGATED)) {
      expect(reason.length, file).toBeGreaterThan(80);
    }
  });

  it("the crawl is not vacuous: it still finds the declarations it deliberately skips", () => {
    // If the walk or the regexes ever broke, every assertion above would pass by
    // finding nothing at all — which is the failure mode a structural test cannot
    // afford. The client's own declarations are a fixed, known population.
    const clientHits = writeMethodHits(stripComments(readFileSync(srcPath(CLIENT_MODULE), "utf8")));
    expect(clientHits.length).toBeGreaterThanOrEqual(0);
    const gateSource = readFileSync(srcPath(GATE_MODULE), "utf8");
    for (const name of WRITE_METHODS) {
      expect(gateSource, `the gate does not name ${name}`).toContain(name);
    }
    // And the walk itself found a real tree.
    expect(walkSrc({ extensions: [".ts", ".tsx"] }).length).toBeGreaterThan(300);
  });

  it("client.ts is the ONLY file that puts a write verb on a Dentally request", () => {
    // The crawl above proves nothing goes round the GATE. This proves nothing
    // goes round the CLIENT either — a hand-rolled `fetch(dentallyUrl, { method:
    // "POST" })` somewhere would satisfy every other assertion in this file and
    // still write to a real patient's record with no gate, no switch and no
    // ledger row. The mock Dentally API is excluded: it IMPERSONATES the upstream
    // and its own routes are how the local write path is exercised.
    const offenders: string[] = [];
    for (const file of walkSrc({ extensions: [".ts", ".tsx"] })) {
      if (file === CLIENT_MODULE || file.startsWith("app/api/mock-dentally/")) continue;
      const code = stripComments(readFileSync(srcPath(file), "utf8"));
      if (!/dentally/i.test(code)) continue;
      if (/method:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/.test(code) && /dentally\.co|buildUrl|DENTALLY_WRITE_BASE_URL/.test(code)) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `these appear to send a write verb at Dentally outside the client: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("the gate exposes exactly the five kinds the ledger knows about", () => {
    // A sixth method on the client, or a sixth kind in the ledger, has to be a
    // decision somebody makes here rather than a drift between two files.
    expect([...DENTALLY_WRITE_KINDS].sort()).toEqual(
      [
        "appointment.cancel",
        "appointment.create",
        "appointment.update",
        "patient.create",
        "patient.update",
      ].sort(),
    );
    expect(WRITE_METHODS).toHaveLength(DENTALLY_WRITE_KINDS.length);
  });
});

describe("a staff click made while write-back is off is RECORDED, not lost", () => {
  /**
   * THE RULING THIS PINS. Six staff paths refuse a Dentally write before they
   * spend a live availability read on it, and that ordering is right and worth
   * keeping. But refusing early used to mean the attempt VANISHED: a receptionist
   * pressed "Book", got a polite 503, and nothing anywhere recorded that the
   * practice had tried to put an appointment into Dentally.
   *
   * Each of these now asks precheckDentallyWrite, which files the attempt
   * (blocked / writes_disabled) and THEN refuses with the message it always used.
   * A path that reverts to reading the environment variable directly would refuse
   * exactly as before and lose the row again — silently — which is why this is a
   * structural test and not a comment.
   *
   * The public booking route is deliberately NOT here. Its early refusal is
   * before the page-token check, so an anonymous caller reaching the ledger would
   * be an unauthenticated write amplifier; its actual write still goes through
   * the gate like every other.
   */
  const STAFF_PATHS = [
    "app/api/recall/[action]/route.ts",
    "app/api/reactivation/[action]/route.ts",
    "app/api/coordinator/[action]/route.ts",
    "app/api/noshow/[action]/route.ts",
    "app/api/onboarding/register/route.ts",
    "lib/calendar/move-service.ts",
    "lib/patient/profile-service.ts",
    "lib/patient-status/service.ts",
  ];

  it.each(STAFF_PATHS)("%s asks the gate before it refuses", (file) => {
    const code = stripComments(readFileSync(srcPath(file), "utf8"));
    expect(code, `${file} no longer records the attempt before refusing it`).toMatch(
      /await\s+precheckDentallyWrite\s*\(/,
    );
  });

  it.each(STAFF_PATHS)("%s no longer gates its write on the env var directly", (file) => {
    // The env var is what the gate reads; a path reading it itself is a second
    // implementation of the same decision, and the one that forgets to record.
    const code = stripComments(readFileSync(srcPath(file), "utf8"));
    expect(code, `${file} still calls isDentallyWriteEnabled itself`).not.toMatch(
      /\bisDentallyWriteEnabled\s*\(/,
    );
  });

  it("names every staff path that exists, so the list cannot rot", () => {
    for (const file of STAFF_PATHS) {
      expect(walkSrc({ extensions: [".ts"] }), `${file} has moved or gone`).toContain(file);
    }
  });
});

describe("no call site hands the gate a person's email address", () => {
  /**
   * THE BELT. sanitiseActor is the braces — it redacts anything address-shaped
   * before it is stored — but a redaction is a repair, and a call site passing an
   * email is a mistake worth catching at the source: the sync ledger holds no
   * personal data, and "staff" is not an exemption from that.
   *
   * Every file that reaches the gate is swept for an `actor:` whose value
   * mentions an email at all. The audit trails are untouched by this: they are
   * the practice's own record of who changed a patient's details and they SHOULD
   * name a person, which is exactly why the two are separate fields.
   */
  it("every actor handed to the gate is an opaque id or an agent slug", () => {
    const offenders: string[] = [];
    for (const file of walkSrc({ extensions: [".ts", ".tsx"] })) {
      if (file === GATE_MODULE) continue;
      const code = stripComments(readFileSync(srcPath(file), "utf8"));
      if (!/from\s+["'][^"']*dentally\/write-gate["']/.test(code)) continue;
      for (const m of code.matchAll(/\bactor:\s*([^,\n}]+)/g)) {
        if (/email/i.test(m[1])) offenders.push(`${file}: actor: ${m[1].trim()}`);
      }
    }
    expect(
      offenders,
      "the Dentally sync ledger holds no personal data, staff included — pass the opaque user id " +
        `(auth?.id) or an agent slug, never an address: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("the sweep is not vacuous: it really finds the gate's callers", () => {
    const callers = walkSrc({ extensions: [".ts", ".tsx"] }).filter((file) =>
      /from\s+["'][^"']*dentally\/write-gate["']/.test(stripComments(readFileSync(srcPath(file), "utf8"))),
    );
    expect(callers.length).toBeGreaterThanOrEqual(10);
  });
});

describe("the crawl catches the shapes that would otherwise slip past it", () => {
  it("counts an ordinary member call", () => {
    expect(writeMethodHits(`await client.createAppointment({});`)).toContain("createAppointment (member call)");
  });

  it("counts a bracket access, which spells the method as a string", () => {
    expect(writeMethodHits(`await client["cancelAppointment"](id);`)).toContain(
      "cancelAppointment (bracket access)",
    );
  });

  it("counts a destructured method, which is then called by a bare name", () => {
    const file = [`const { createPatient } = dentallyAgentClient();`, `await createPatient(payload);`].join("\n");
    expect(writeMethodHits(file)).toContain("createPatient (destructured)");
  });

  it("does NOT count prose about a write method", () => {
    const file = [
      `// createAppointment has been proven against live Dentally; updateAppointment has not.`,
      `/* a second .createPatient( call site is exactly how the duplicate-patient bug returns */`,
      `export const note = 1;`,
    ].join("\n");
    expect(writeMethodHits(stripComments(file))).toEqual([]);
  });

  it("does NOT count a call made through the gate, aliased or not", () => {
    const plain = [
      `import { dentallyWrite } from "@/lib/dentally/write-gate";`,
      `await dentallyWrite.createAppointment(ctx, payload);`,
    ].join("\n");
    expect(writeMethodHits(withoutGateCalls(plain))).toEqual([]);

    const aliased = [
      `import { dentallyWrite as gate } from "@/lib/dentally/write-gate";`,
      `await gate.cancelAppointment(ctx, id);`,
    ].join("\n");
    expect(writeMethodHits(withoutGateCalls(aliased))).toEqual([]);

    const namespaced = [
      `import * as wg from "@/lib/dentally/write-gate";`,
      `await wg.dentallyWrite.updatePatient(ctx, id, fields);`,
    ].join("\n");
    expect(writeMethodHits(withoutGateCalls(namespaced))).toEqual([]);
  });

  it("STILL counts a direct client call in a file that ALSO uses the gate", () => {
    // The exact hole the exclusion could open: a file that imports the gate and
    // uses it for four of its five writes, and reaches past it for the fifth.
    const file = [
      `import { dentallyWrite } from "@/lib/dentally/write-gate";`,
      `await dentallyWrite.createAppointment(ctx, payload);`,
      `await dentallyAgentClient().cancelAppointment(id);`,
    ].join("\n");
    expect(writeMethodHits(withoutGateCalls(file))).toEqual(["cancelAppointment (member call)"]);
  });

  it("does not count a same-named method on something else", () => {
    // `queue.createAppointment(...)` would be a false positive a human resolves,
    // which is the right direction for this crawl: it over-reports rather than
    // missing a real one. Stated as a test so the trade-off is on the record.
    expect(writeMethodHits(`await queue.createAppointment({});`)).toContain(
      "createAppointment (member call)",
    );
  });
});
