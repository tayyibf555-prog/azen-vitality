import { describe, it, expect } from "vitest";
import { buildAskPrompt, parseCopilotAnswer, askCopilot } from "./copilot";
import type { KnowledgeNode, Tier } from "./types";
import type { RankedNode } from "./retrieval";

function node(p: Partial<KnowledgeNode>): KnowledgeNode {
  return {
    id: "n", clientId: "vitality", siteId: null, parentId: "h", kind: "item",
    title: "t", body: "b", rawInput: null, tier: 1 as Tier, tags: [],
    source: "manual_note", sourceRef: null, classification: null, status: "active",
    createdBy: null, createdAt: "", updatedAt: "", ...p,
  };
}

function ranked(p: Partial<KnowledgeNode>): RankedNode {
  const n = node(p);
  return { node: n, score: 1, snippet: n.body ?? "" };
}

function fakeClient(jsonText: string) {
  return {
    messages: {
      create: async () => ({ content: [{ type: "text", text: jsonText }] }),
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

function throwingClient() {
  return {
    messages: {
      create: async () => {
        throw new Error("api down");
      },
    },
  } as unknown as import("@anthropic-ai/sdk").default;
}

describe("buildAskPrompt", () => {
  it("system mentions JSON output format", () => {
    const { system } = buildAskPrompt("What is the refund policy?", []);
    expect(system).toMatch(/JSON/i);
  });

  it("system instructs no em-dash", () => {
    const { system } = buildAskPrompt("What is the refund policy?", []);
    expect(system).toMatch(/no em-dash/i);
  });

  it("system instructs to use only provided knowledge and not guess", () => {
    const { system } = buildAskPrompt("What is the refund policy?", []);
    expect(system).toMatch(/only/i);
    expect(system).toMatch(/do not guess/i);
  });

  it("user contains the question and a provided item's id+title", () => {
    const r = ranked({ id: "abc123", title: "Refund policy", body: "Refunds take 14 days." });
    const { user } = buildAskPrompt("What is the refund policy?", [r]);
    expect(user).toContain("What is the refund policy?");
    expect(user).toContain("abc123");
    expect(user).toContain("Refund policy");
  });
});

describe("parseCopilotAnswer", () => {
  it("maps cited ids to titles from ranked nodes", () => {
    const r1 = ranked({ id: "id1", title: "Greeting script" });
    const r2 = ranked({ id: "id2", title: "Refund policy" });
    const json = JSON.stringify({ answer: "Use the greeting script.", citedIds: ["id1"] });
    const result = parseCopilotAnswer(json, [r1, r2]);
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toEqual({ id: "id1", title: "Greeting script" });
  });

  it("drops an id that is NOT in ranked (model cannot cite out-of-clearance nodes)", () => {
    const r1 = ranked({ id: "id1", title: "Visible node" });
    const json = JSON.stringify({ answer: "Some answer.", citedIds: ["id1", "id-ghost"] });
    const result = parseCopilotAnswer(json, [r1]);
    expect(result.citations.map((c) => c.id)).toEqual(["id1"]);
  });

  it("strips em-dashes from the answer", () => {
    const json = JSON.stringify({ answer: "Call back — same day.", citedIds: [] });
    const result = parseCopilotAnswer(json, []);
    expect(result.answer).not.toMatch(/[—–]/);
  });

  it("falls back to raw text with empty citations on malformed JSON", () => {
    const result = parseCopilotAnswer("not json at all", []);
    expect(result.answer).toContain("not json at all");
    expect(result.citations).toEqual([]);
    expect(result.groundedIn).toBe(0);
  });

  it("sets groundedIn to ranked.length", () => {
    const r1 = ranked({ id: "x1" });
    const r2 = ranked({ id: "x2" });
    const json = JSON.stringify({ answer: "ok", citedIds: [] });
    const result = parseCopilotAnswer(json, [r1, r2]);
    expect(result.groundedIn).toBe(2);
  });
});

describe("askCopilot", () => {
  it("returns the 'nothing in the brain yet' answer WITHOUT calling the client when ranked is empty", async () => {
    const result = await askCopilot("What is the policy?", [], throwingClient());
    expect(result.answer).toContain("do not have anything about that in the brain yet");
    expect(result.citations).toEqual([]);
    expect(result.groundedIn).toBe(0);
  });

  it("returns the parsed answer and citations from a fake client with valid JSON", async () => {
    const r1 = ranked({ id: "n1", title: "Greeting script", body: "Greet every caller by name." });
    const json = JSON.stringify({ answer: "Greet every caller by name.", citedIds: ["n1"] });
    const result = await askCopilot("How do we greet callers?", [r1], fakeClient(json));
    expect(result.answer).toBe("Greet every caller by name.");
    expect(result.citations).toEqual([{ id: "n1", title: "Greeting script" }]);
    expect(result.groundedIn).toBe(1);
  });

  it("returns a graceful error message when the API throws", async () => {
    const r1 = ranked({ id: "n1", title: "Some node", body: "Some content." });
    const result = await askCopilot("Any question?", [r1], throwingClient());
    expect(result.answer).toContain("could not answer just now");
    expect(result.citations).toEqual([]);
    expect(result.groundedIn).toBe(1);
  });
});
