import { describe, it, expect } from "vitest";
import {
  DELIVERY_LABEL,
  SOURCE_LABEL,
  belongsOnRecord,
  normaliseDeliveryStatus,
  sourceLabel,
} from "./delivery";
import { CORRESPONDENCE_SOURCE_NAMES } from "./repository";
import { DRAIN_SOURCE_TO_SLUG } from "@/lib/systems/catalog";
import type { DeliveryStatus } from "./types";

describe("normaliseDeliveryStatus", () => {
  it("maps the vocabulary the eleven message tables actually use", () => {
    expect(normaliseDeliveryStatus("sent")).toBe("sent");
    expect(normaliseDeliveryStatus("failed")).toBe("failed");
    expect(normaliseDeliveryStatus("draft")).toBe("draft");
    expect(normaliseDeliveryStatus("discarded")).toBe("discarded");
  });

  it("collapses approved/queued/sending into one 'not gone yet' state", () => {
    // The difference between them is the drain's business, not the record's: to a
    // reader all three mean "a human signed it off and the patient does not have it".
    expect(normaliseDeliveryStatus("approved")).toBe("queued");
    expect(normaliseDeliveryStatus("queued")).toBe("queued");
    expect(normaliseDeliveryStatus("sending")).toBe("queued");
  });

  it("is tolerant of casing and padding, because eleven tables were written by hand", () => {
    expect(normaliseDeliveryStatus(" Sent ")).toBe("sent");
    expect(normaliseDeliveryStatus("FAILED")).toBe("failed");
  });

  it("NEVER rounds an unrecognised status up to 'sent'", () => {
    // The whole point. A value nobody has seen must not become a delivery claim.
    expect(normaliseDeliveryStatus("delivered_maybe")).toBe("unknown");
    expect(normaliseDeliveryStatus("")).toBe("unknown");
    expect(normaliseDeliveryStatus(null)).toBe("unknown");
    expect(normaliseDeliveryStatus(undefined)).toBe("unknown");
  });
});

describe("belongsOnRecord", () => {
  it("keeps everything that left, or tried to", () => {
    expect(belongsOnRecord("sent")).toBe(true);
    expect(belongsOnRecord("failed")).toBe(true);
    expect(belongsOnRecord("queued")).toBe(true);
  });

  it("keeps an unknown status rather than dropping a message that may have been sent", () => {
    expect(belongsOnRecord("unknown")).toBe(true);
  });

  it("excludes drafts and discarded drafts: neither was ever said to the patient", () => {
    expect(belongsOnRecord("draft")).toBe(false);
    expect(belongsOnRecord("discarded")).toBe(false);
  });
});

describe("DELIVERY_LABEL", () => {
  it("has words for every state, so no status can render blank", () => {
    const all: DeliveryStatus[] = ["sent", "failed", "queued", "unknown", "draft", "discarded"];
    for (const s of all) expect(DELIVERY_LABEL[s]).toBeTruthy();
  });

  it("does not claim delivery it cannot observe", () => {
    // "Sent" means the network accepted it. "Delivered" would be asserting the
    // handset received it, which is a different fact carried by a webhook.
    expect(DELIVERY_LABEL.sent).toBe("Sent");
    expect(DELIVERY_LABEL.sent).not.toMatch(/delivered/i);
    // Blunt on purpose: the reader's next action is to contact the patient another way.
    expect(DELIVERY_LABEL.failed).toBe("Not delivered");
  });
});

describe("source registry coverage", () => {
  /**
   * THE GUARD THAT MATTERS. This tab was missing six whole modules because a new
   * lifecycle agent could ship a messaging table, wire it into the drain, and never
   * be added to the correspondence read. Nothing failed; the record just quietly
   * stopped being complete. These two tests make that a build failure.
   */
  it("reads a source for every module the drain can send from", () => {
    const registered = new Set(CORRESPONDENCE_SOURCE_NAMES);
    const missing = Object.keys(DRAIN_SOURCE_TO_SLUG).filter((name) => !registered.has(name));
    expect(missing, `drain sources absent from the correspondence read: ${missing.join(", ")}`).toEqual([]);
  });

  it("has human words for every source it reads", () => {
    const unlabelled = CORRESPONDENCE_SOURCE_NAMES.filter((n) => SOURCE_LABEL[n] === undefined);
    expect(unlabelled, `sources with no label: ${unlabelled.join(", ")}`).toEqual([]);
  });

  it("covers the two senders that are NOT drain sources", () => {
    // The agent spine (live two-way conversation) and speed-to-lead (first contact,
    // sent outside the drain entirely) have no outbox, so the drain check above
    // cannot see them. They are the easiest two to forget.
    expect(CORRESPONDENCE_SOURCE_NAMES).toContain("agent");
    expect(CORRESPONDENCE_SOURCE_NAMES).toContain("speed-to-lead");
  });

  it("falls back to the raw slug rather than rendering nothing", () => {
    expect(sourceLabel("recall")).toBe("Recall");
    expect(sourceLabel("a-module-invented-tomorrow")).toBe("a-module-invented-tomorrow");
  });
});
