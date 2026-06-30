import { describe, it, expect } from "vitest";
import {
  snippet,
  directionFromAgentRole,
  toInboxChannel,
  groupThreads,
} from "./normalise";
import type { InboxMessage } from "./types";

function msg(p: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: "agent:1",
    contactRef: "patient:123",
    contactName: "Sarah Lindqvist",
    channel: "sms",
    direction: "inbound",
    body: "Hi there",
    at: "2026-06-18T09:00:00.000Z",
    source: "agent",
    ...p,
  };
}

describe("snippet", () => {
  it("collapses whitespace and trims", () => {
    expect(snippet("  hello   world \n there ")).toBe("hello world there");
  });
  it("truncates long bodies with an ellipsis", () => {
    const out = snippet("a".repeat(120), 10);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBe(10);
  });
});

describe("directionFromAgentRole", () => {
  it("maps patient to inbound, everything else to outbound", () => {
    expect(directionFromAgentRole("patient")).toBe("inbound");
    expect(directionFromAgentRole("agent")).toBe("outbound");
    expect(directionFromAgentRole("system")).toBe("outbound");
  });
});

describe("toInboxChannel", () => {
  it("normalises known channels and defaults to sms", () => {
    expect(toInboxChannel("whatsapp")).toBe("whatsapp");
    expect(toInboxChannel("email")).toBe("email");
    expect(toInboxChannel("after_hours")).toBe("after-hours");
    expect(toInboxChannel("after-hours")).toBe("after-hours");
    expect(toInboxChannel("sms")).toBe("sms");
    expect(toInboxChannel("anything")).toBe("sms");
  });
});

describe("groupThreads", () => {
  it("groups by contactRef and sorts messages oldest-first", () => {
    const threads = groupThreads([
      msg({ id: "agent:2", at: "2026-06-18T10:00:00.000Z", body: "Second", direction: "outbound" }),
      msg({ id: "agent:1", at: "2026-06-18T09:00:00.000Z", body: "First" }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((m) => m.id)).toEqual(["agent:1", "agent:2"]);
  });

  it("derives lastAt, lastSnippet, channel and unread from the newest message", () => {
    const threads = groupThreads([
      msg({ id: "a", at: "2026-06-18T09:00:00.000Z", body: "old", direction: "inbound" }),
      msg({
        id: "b",
        at: "2026-06-18T11:00:00.000Z",
        body: "newest reply from us",
        direction: "outbound",
        channel: "whatsapp",
      }),
    ]);
    expect(threads[0].lastAt).toBe("2026-06-18T11:00:00.000Z");
    expect(threads[0].lastSnippet).toBe("newest reply from us");
    expect(threads[0].channel).toBe("whatsapp");
    // newest is outbound -> nothing awaiting a reply
    expect(threads[0].unread).toBe(false);
  });

  it("flags unread when the newest message is inbound", () => {
    const threads = groupThreads([
      msg({ id: "a", at: "2026-06-18T09:00:00.000Z", direction: "outbound" }),
      msg({ id: "b", at: "2026-06-18T10:00:00.000Z", direction: "inbound" }),
    ]);
    expect(threads[0].unread).toBe(true);
  });

  it("returns threads newest-activity first", () => {
    const threads = groupThreads([
      msg({ id: "old", contactRef: "patient:1", contactName: "A", at: "2026-06-18T08:00:00.000Z" }),
      msg({ id: "new", contactRef: "patient:2", contactName: "B", at: "2026-06-18T12:00:00.000Z" }),
    ]);
    expect(threads.map((t) => t.contactRef)).toEqual(["patient:2", "patient:1"]);
  });

  it("merges messages from different sources into one thread by contactRef", () => {
    const threads = groupThreads([
      msg({ id: "agent:1", source: "agent", at: "2026-06-18T09:00:00.000Z", direction: "inbound" }),
      msg({
        id: "recall:1",
        source: "recall",
        at: "2026-06-18T08:00:00.000Z",
        direction: "outbound",
        body: "Time for your check-up",
        contactName: "Sarah L",
      }),
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0].messages.map((m) => m.source)).toEqual(["recall", "agent"]);
  });

  it("uses the most recent non-empty name for the contact", () => {
    const threads = groupThreads([
      msg({ id: "1", at: "2026-06-18T09:00:00.000Z", contactName: "Unknown 4521" }),
      msg({ id: "2", at: "2026-06-18T10:00:00.000Z", contactName: "Sarah Lindqvist" }),
    ]);
    expect(threads[0].contactName).toBe("Sarah Lindqvist");
  });
});
