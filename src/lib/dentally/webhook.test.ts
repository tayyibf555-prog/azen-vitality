import { describe, it, expect } from "vitest";
import { verifyWebhookToken, parseWebhookEvent } from "./webhook";
import { classifyEvent } from "./webhook-dispatch";

describe("verifyWebhookToken", () => {
  it("returns true when provided matches the secret", () => {
    expect(verifyWebhookToken("s3cret", "s3cret")).toBe(true);
  });

  it("returns false when provided does not match the secret", () => {
    expect(verifyWebhookToken("nope", "s3cret")).toBe(false);
  });

  it("returns false for differing lengths (no out-of-range read)", () => {
    expect(verifyWebhookToken("s3cre", "s3cret")).toBe(false);
    expect(verifyWebhookToken("s3crett", "s3cret")).toBe(false);
  });

  it("returns false when provided is empty, null or undefined", () => {
    expect(verifyWebhookToken("", "s3cret")).toBe(false);
    expect(verifyWebhookToken(null, "s3cret")).toBe(false);
    expect(verifyWebhookToken(undefined, "s3cret")).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("parses an appointment.updated event with state timestamps", () => {
    const parsed = parseWebhookEvent({
      event: "appointment.updated",
      id: "evt_1",
      data: {
        id: "appt_1",
        site_id: "site-cc",
        did_not_attend_at: "2026-06-19T10:00:00Z",
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.eventType).toBe("appointment.updated");
    expect(parsed?.dentallyEventId).toBe("evt_1");
    expect(parsed?.siteId).toBe("site-cc");
    expect(parsed?.resource).toEqual({
      id: "appt_1",
      site_id: "site-cc",
      did_not_attend_at: "2026-06-19T10:00:00Z",
    });
  });

  it("parses a patient.updated event", () => {
    const parsed = parseWebhookEvent({
      type: "patient.updated",
      event_id: "evt_2",
      object: { id: "pat_1", site_id: "site-bn", first_name: "Sarah" },
    });
    expect(parsed?.eventType).toBe("patient.updated");
    expect(parsed?.dentallyEventId).toBe("evt_2");
    expect(parsed?.siteId).toBe("site-bn");
    expect(parsed?.resource).toEqual({
      id: "pat_1",
      site_id: "site-bn",
      first_name: "Sarah",
    });
  });

  it("falls back to headers for event type and delivery id", () => {
    const parsed = parseWebhookEvent(
      { data: { id: "appt_2", site_id: "site-cc" } },
      { "x-dentally-event": "appointment.created", "x-dentally-delivery": "del_9" },
    );
    expect(parsed?.eventType).toBe("appointment.created");
    expect(parsed?.dentallyEventId).toBe("del_9");
    expect(parsed?.siteId).toBe("site-cc");
  });

  it("falls back to body for the resource and site id", () => {
    const parsed = parseWebhookEvent({
      event: "appointment.cancelled",
      site_id: "site-top",
      cancelled_at: "2026-06-19T11:00:00Z",
    });
    expect(parsed?.eventType).toBe("appointment.cancelled");
    expect(parsed?.dentallyEventId).toBeNull();
    expect(parsed?.siteId).toBe("site-top");
    // resource defaults to the body itself when no data/object/payload key.
    expect(parsed?.resource).toMatchObject({
      event: "appointment.cancelled",
      cancelled_at: "2026-06-19T11:00:00Z",
    });
  });

  it("returns null when no event type can be resolved", () => {
    expect(parseWebhookEvent({})).toBeNull();
    expect(parseWebhookEvent({ data: { id: "x" } })).toBeNull();
  });

  it("returns null for garbage / non-object bodies", () => {
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent("not-json")).toBeNull();
    expect(parseWebhookEvent(42)).toBeNull();
    expect(parseWebhookEvent(undefined)).toBeNull();
  });
});

describe("classifyEvent", () => {
  it("classifies appointment.* as appointment", () => {
    expect(classifyEvent("appointment.updated")).toBe("appointment");
    expect(classifyEvent("appointment.created")).toBe("appointment");
  });

  it("classifies patient.* as patient", () => {
    expect(classifyEvent("patient.updated")).toBe("patient");
    expect(classifyEvent("patient.deleted")).toBe("patient");
  });

  it("classifies anything else as other", () => {
    expect(classifyEvent("invoice.paid")).toBe("other");
    expect(classifyEvent("")).toBe("other");
  });
});
