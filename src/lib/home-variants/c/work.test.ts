import { describe, expect, it } from "vitest";
import {
  countWork,
  moduleHref,
  moneyWork,
  patientHref,
  sharePercent,
  WORK_MODULES,
} from "@/lib/home-variants/c/work";

const CLIENT = "vitality";

describe("moduleHref", () => {
  it("routes into the client area", () => {
    expect(moduleHref(CLIENT, "payments")).toBe("/c/vitality/payments");
    expect(moduleHref(CLIENT, "no-show-defence")).toBe("/c/vitality/no-show-defence");
  });

  it("escapes a client slug rather than pasting it into the path", () => {
    expect(moduleHref("a b/c", "patients")).toBe("/c/a%20b%2Fc/patients");
  });

  it("only names modules that exist in the platform", () => {
    // Guards the whole point of the whitelist: every destination on this screen
    // is a real route, so a rename upstream breaks the build and not the screen.
    expect(Object.keys(WORK_MODULES).sort()).toEqual([
      "calendar",
      "no-show-defence",
      "patients",
      "payments",
      "task-queue",
      "treatment-coordinator",
    ]);
  });
});

describe("patientHref", () => {
  it("opens the patient record by id", () => {
    expect(patientHref(CLIENT, "abc123")).toBe("/c/vitality/patients?patient=abc123");
  });

  it("escapes an id carrying url punctuation", () => {
    expect(patientHref(CLIENT, "a&b=c")).toBe("/c/vitality/patients?patient=a%26b%3Dc");
  });
});

describe("countWork", () => {
  const base = { clientSlug: CLIENT, module: "payments", verb: "Chase", one: "balance", many: "balances" } as const;

  it("names the job, the count and the destination", () => {
    const work = countWork({ ...base, metric: { value: 42, reason: null } });
    expect(work).not.toBeNull();
    expect(work?.text).toBe("Chase 42 balances");
    expect(work?.href).toBe("/c/vitality/payments");
    expect(work?.destination).toBe("Payments");
    expect(work?.description).toContain("Opens Payments");
    expect(work?.description).toContain("Nothing is sent from this screen.");
  });

  it("uses the singular for one", () => {
    expect(countWork({ ...base, metric: { value: 1, reason: null } })?.text).toBe("Chase 1 balance");
  });

  it("separates thousands, because the practice has five-digit counts", () => {
    expect(countWork({ ...base, metric: { value: 11_599, reason: null } })?.text).toBe(
      "Chase 11,599 balances",
    );
  });

  it("claims no work from a figure that could not be sourced", () => {
    expect(countWork({ ...base, metric: { value: null, reason: "Unavailable: ..." } })).toBeNull();
  });

  it("claims no work when there is none", () => {
    expect(countWork({ ...base, metric: { value: 0, reason: null } })).toBeNull();
  });

  it("claims no work from a negative, which would mean the arithmetic is wrong", () => {
    expect(countWork({ ...base, metric: { value: -4, reason: null } })).toBeNull();
  });
});

describe("moneyWork", () => {
  const base = {
    clientSlug: CLIENT,
    module: "payments",
    verb: "Collect",
    trailing: "unpaid on invoices raised in this period",
  } as const;

  it("prints sterling to the penny", () => {
    const work = moneyWork({ ...base, metric: { value: 124_050, reason: null } });
    expect(work?.text).toBe("Collect £1,240.50");
    expect(work?.href).toBe("/c/vitality/payments");
    expect(work?.description).toContain("unpaid on invoices raised in this period");
  });

  it("says nothing when nothing is outstanding", () => {
    expect(moneyWork({ ...base, metric: { value: 0, reason: null } })).toBeNull();
  });

  it("says nothing when the figure is unavailable", () => {
    expect(moneyWork({ ...base, metric: { value: null, reason: "Unavailable: ..." } })).toBeNull();
  });
});

describe("sharePercent", () => {
  it("rounds to a whole percent", () => {
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(2, 3)).toBe(67);
  });

  it("reports zero rather than NaN when the total is zero", () => {
    expect(sharePercent(0, 0)).toBe(0);
    expect(sharePercent(5, 0)).toBe(0);
  });

  it("survives a non-finite input", () => {
    expect(sharePercent(Number.NaN, 10)).toBe(0);
    expect(sharePercent(1, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
