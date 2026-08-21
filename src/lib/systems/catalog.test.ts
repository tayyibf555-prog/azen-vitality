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
const HEADLESS_SYSTEM_SLUGS = new Set([
  "online-booking",
  "outreach",
  "whatsapp-agent",
  "calendar-writes",
  "staff-esign",
  "treatment-closer",
  "postop-checkin",
  "balance-reminders",
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
