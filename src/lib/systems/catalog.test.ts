import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  SYSTEMS,
  SYSTEM_SLUGS,
  SYSTEM_BY_SLUG,
  DRAIN_SOURCE_TO_SLUG,
  isControllableSystem,
} from "./catalog";
import { CLIENT_NAV } from "@/lib/nav";
import { writeSlugFor } from "@/lib/dentally/write-vocabulary";
import { TRIAGE_SYSTEM_SLUG } from "@/lib/triage/types";

// Headless systems: they DO server-side work (a public surface) but have no
// dashboard page, so no CLIENT_NAV slug exists for them. The systems control
// panel renders from SYSTEMS directly, so they still get an owner switch.
// "outreach" is headless too: the segment outreach engine ships before its UI
// workstream, so it has no CLIENT_NAV page yet but still needs an owner kill switch.
// "whatsapp-agent" is headless: the inbound WhatsApp agent is switched separately
// from outbound WhatsApp sending ('whatsapp'), but they share one nav module.
// "calendar-writes" is headless for exactly the same reason as "whatsapp-agent":
// moving an appointment is switched separately from reading the diary, but both
// live on the one 'calendar' nav module. The owner needs to be able to stop diary
// writes without hiding the diary.
// "staff-esign" is headless for the same reason: policy signing is a panel inside
// Staff HR and My work rather than a module, and it ships DISABLED (migration
// 0077) because the legal framing must be agreed before anyone signs anything —
// so the switch that turns it on has to exist somewhere the owner can reach.
// "treatment-closer" is headless for the same reason as "outreach": the closer's
// engine ships before its worklist UI, so it has no CLIENT_NAV page yet but must
// still have an owner switch. It is also a DEFAULT-OFF system.
// "postop-checkin" is headless on exactly the same terms: the aftercare engine and
// its triage path ship before the worklist UI, and it is DEFAULT-OFF too. Its
// escalations are visible without a page of its own, because they surface as tasks
// in the Task queue.
// "balance-reminders" is headless on the same terms: the outstanding-balance
// engine and its approval API ship before the panel, and it is DEFAULT-OFF too —
// a surface that tells patients they owe money must never be armed by the absence
// of a row.
// "booking-reply-context" is headless because it is a BEHAVIOUR of the booking
// agent rather than a module: it gives the agent the invite a reply is answering,
// so a "yes please" to a recall text offers the right appointment instead of
// starting a fresh interrogation. It is DEFAULT-OFF, and switching it off is the
// exact revert to the agent's previous behaviour.
const HEADLESS_SYSTEM_SLUGS = new Set([
  "online-booking",
  "outreach",
  "whatsapp-agent",
  "calendar-writes",
  "staff-esign",
  "treatment-closer",
  "postop-checkin",
  "balance-reminders",
  "booking-reply-context",
  // The alerts render inside Notifications, which is a passive surface with no
  // switch of its own, so the alerting system has no nav slug either.
  "anomaly-alerts",
  // "dentally-write-back" is headless because it is not a module at all: it is
  // the MASTER lever over what every other module writes back to Dentally. There
  // is no page to hide — the modules it governs keep their own pages and keep
  // working — so it has no nav slug, and its switch lives in the systems control
  // panel beside the modules it sits above. What it halts is visible on the
  // Dentally sync screen (/c/<client>/controls/sync), which lists every write it
  // held back.
  "dentally-write-back",
]);

/**
 * The source names the shared drain actually iterates, read out of the drain's own
 * source rather than copied into a list here.
 *
 * WHY FROM THE FILE. A module registered in the drain's SOURCES array but missing
 * from DRAIN_SOURCE_TO_SLUG is UNKILLABLE: the drain skips a system only when it
 * can turn the source name into a slug, so an unmapped source keeps sending after
 * the owner has switched it off. A hand-maintained list in this test cannot catch
 * that, because the same person who forgot the mapping edits the list.
 */
function drainSourceNames(): string[] {
  const src = readFileSync(
    join(process.cwd(), "src/app/api/messaging/drain/route.ts"),
    "utf8",
  );
  const block = src.slice(src.indexOf("const SOURCES: OutboxSource[] = ["));
  const end = block.indexOf("\n];");
  return [...block.slice(0, end).matchAll(/\{\s*name:\s*"([a-z-]+)"/g)].map((m) => m[1]);
}

describe("systems catalog", () => {
  it("every non-headless system slug is a real CLIENT_NAV module", () => {
    const navSlugs = new Set(CLIENT_NAV.flatMap((g) => g.items.map((i) => i.slug)));
    for (const s of SYSTEMS) {
      if (HEADLESS_SYSTEM_SLUGS.has(s.slug)) continue;
      expect(navSlugs.has(s.slug), `${s.slug} is not a known module slug`).toBe(true);
    }
  });

  it("every headless system slug exists in the catalog (no stale exemptions)", () => {
    for (const slug of HEADLESS_SYSTEM_SLUGS) {
      expect(isControllableSystem(slug), `${slug} exempted but not in SYSTEMS`).toBe(true);
    }
  });

  it("has no duplicate slugs", () => {
    expect(SYSTEM_SLUGS.length).toBe(new Set(SYSTEM_SLUGS).size);
  });

  it("every system carries owner-facing copy for what halts", () => {
    for (const s of SYSTEMS) {
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.halts.length).toBeGreaterThan(0);
      expect(s.group.length).toBeGreaterThan(0);
    }
  });

  it("maps every drain source to a controllable system slug", () => {
    for (const [source, slug] of Object.entries(DRAIN_SOURCE_TO_SLUG)) {
      expect(isControllableSystem(slug), `${source} -> ${slug} not controllable`).toBe(true);
    }
    // EVERY source the drain iterates is mapped, and nothing is mapped that the
    // drain does not iterate. Both directions matter: an unmapped source is an
    // unkillable one, and a stale mapping is a switch pointing at nothing.
    const sources = drainSourceNames();
    expect(sources.length, "the SOURCES scan found nothing; it has gone stale").toBeGreaterThan(5);
    expect([...sources].sort()).toEqual(Object.keys(DRAIN_SOURCE_TO_SLUG).sort());
    // The tricky remaps are correct.
    expect(DRAIN_SOURCE_TO_SLUG.noshow).toBe("no-show-defence");
    expect(DRAIN_SOURCE_TO_SLUG.coordinator).toBe("treatment-coordinator");
    // An unmapped source is an UNKILLABLE source: the drain skips a system only
    // when it can turn the source name into a slug, so the closer being here is
    // what makes its kill switch reach its outbox.
    expect(DRAIN_SOURCE_TO_SLUG.closer).toBe("treatment-closer");
    expect(DRAIN_SOURCE_TO_SLUG.postop).toBe("postop-checkin");
    expect(DRAIN_SOURCE_TO_SLUG.collection).toBe("balance-reminders");
    // The diary's reschedule texts are stopped by the same switch that stops the
    // moves themselves, so a halted write can never still text the patient.
    expect(DRAIN_SOURCE_TO_SLUG.diary).toBe("calendar-writes");
  });

  it("SYSTEM_BY_SLUG resolves and isControllableSystem rejects unknowns", () => {
    expect(SYSTEM_BY_SLUG.get("recall")?.label).toBe("Recall concierge");
    expect(isControllableSystem("recall")).toBe(true);
    expect(isControllableSystem("settings")).toBe(false); // owner tool, not a system
    expect(isControllableSystem("nope")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A `halts` sentence names every door the switch closes (ruling W3/9).
// ---------------------------------------------------------------------------
//
// `halts` is not decoration. It is the sentence the control panel prints under a
// running system — "Running. <halts>" (src/components/client/systems/
// systems-view.tsx) — and it is what an owner reads while deciding whether one
// flip is enough. A switch that closes two doors and describes one is a switch
// the owner will believe he has not fully thrown.
//
// BOTH assertions below derive the requirement from the code that does the work
// rather than from the sentence itself, which is the only shape that survives a
// later edit: the day the co-pilot's diary kinds stop resolving `calendar-writes`,
// or the day the implant scan stops asking for `pre-visit-triage`, the copy
// requirement is wrong and these go red in the other direction rather than
// standing as stale prose nobody re-reads.

describe("what a switch halts is described in full", () => {
  it("the diary switch says it stops the co-pilot booking, moving and cancelling too", () => {
    // THE DERIVATION. `writeSlugFor("copilot", kind)` is what the write gate
    // actually asks (src/lib/dentally/write-gate.ts) before a co-pilot
    // appointment write, so this is the co-pilot's real dependence on this
    // switch, not a claim about it.
    const kinds = ["appointment.create", "appointment.update", "appointment.cancel"] as const;
    for (const kind of kinds) {
      expect(
        writeSlugFor("copilot", kind),
        `copilot ${kind} no longer resolves calendar-writes — the halts sentence below is now wrong`,
      ).toBe("calendar-writes");
    }
    const halts = SYSTEM_BY_SLUG.get("calendar-writes")?.halts ?? "";
    expect(halts, "the calendar-writes row lost its halts sentence").not.toBe("");
    expect(
      halts,
      "the diary switch also stops the co-pilot booking, moving and cancelling, and the owner is not told",
    ).toMatch(/co-pilot/i);
    expect(
      halts,
      "it says the co-pilot is affected but not what it can no longer do",
    ).toMatch(/\bbook\b[\s\S]*\bcancel\b/i);
    // The desk half is still described: the sentence gained a clause, it did not
    // trade one fact for another.
    expect(halts).toMatch(/from the diary/i);
  });

  it("the pre-visit switch says the implant list stops growing, because it does", () => {
    // THE DERIVATION. Both doors onto the implant scan gate on this slug before
    // reading anything, which is what makes the list fail-closed under the one
    // switch (ruling W3/21). Read out of the routes so that a door which stops
    // asking turns this red.
    const doors = ["src/app/api/previsit/mining-sweep/route.ts", "src/app/api/previsit/mining-run/route.ts"];
    for (const door of doors) {
      const src = readFileSync(join(process.cwd(), door), "utf8");
      expect(src, `${door} no longer imports the triage slug`).toContain("TRIAGE_SYSTEM_SLUG");
      expect(
        src,
        `${door} no longer gates on the pre-visit switch — the implant list is not fail-closed any more`,
      ).toMatch(/isSystemEnabled\([^)]*TRIAGE_SYSTEM_SLUG\)/);
    }
    expect(TRIAGE_SYSTEM_SLUG).toBe("pre-visit-triage");
    const halts = SYSTEM_BY_SLUG.get("pre-visit-triage")?.halts ?? "";
    expect(halts, "the pre-visit row lost its halts sentence").not.toBe("");
    expect(
      halts,
      "switching pre-visit questions off also stops the implant-candidate list being built, and the owner is not told",
    ).toMatch(/implant-candidate list/i);
    // BOTH callers named, because an owner who knows only about the scan would
    // reasonably expect his own button still to work.
    expect(halts, "the halts sentence does not name the scan").toMatch(/nightly scan/i);
    expect(halts, "the halts sentence does not name the owner's own button").toMatch(
      /Build \/ refresh candidates/i,
    );
    // The questionnaire half is still described.
    expect(halts).toMatch(/no pre-visit questionnaires are sent/i);
  });
});
