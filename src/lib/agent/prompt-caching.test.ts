// PROMPT CACHING, PINNED.
//
// runAgentTurn is the only agent loop in the product: the 24/7 SMS booking agent
// (up to 4 rounds an inbound) and the owner co-pilot (up to 6 rounds a question)
// both run it. Every round re-sends the whole tool schema and the whole system
// prompt, so those two blocks — not the conversation — are the bulk of the spend.
//
// The saving depends on THREE things, and a test that only checks the first is
// worthless, because the other two fail SILENTLY: an uncacheable prefix does not
// error, it just bills at 1x for ever.
//
//   1. the breakpoint is actually on the wire, on the SYSTEM block (which, because
//      the wire order is tools -> system -> messages, covers the tools too);
//   2. the prefix is byte-IDENTICAL on every round of a turn — one varying byte
//      ahead of the breakpoint and nothing after it can be read from cache;
//   3. the prefix clears the model's minimum cacheable length (1,024 tokens on
//      Sonnet 5) — under it the marker is ignored with no error and no cache.
//
// All three are asserted here, against the REAL prompts and the REAL tool arrays.

import { describe, it, expect, vi, afterEach } from "vitest";
vi.mock("server-only", () => ({}));

import { runAgentTurn } from "./run";
import { AGENT_TOOLS } from "./tools";
import { buildSystemPrompt } from "./prompt";
import { COPILOT_TOOLS } from "@/lib/copilot/tools";
import { buildCopilotSystemPrompt } from "@/lib/copilot/prompt";
import type { AgentContext } from "./types";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * A conservative floor on token count. Real English prose and JSON tokenize at
 * roughly 3-4 characters per token, so chars/4 never OVER-states the token count:
 * if this passes, the prefix really is over the model's minimum.
 */
const MIN_CACHEABLE_TOKENS = 1024; // Sonnet 5
const floorTokens = (s: string) => Math.floor(s.length / 4);

function textMessage(text: string) {
  return { stop_reason: "end_turn", content: [{ type: "text", text }] };
}
function toolUseMessage(id: string, name: string, input: object) {
  return { stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] };
}

const KNOWN_PATIENT: AgentContext = {
  patientId: "pat-1",
  siteId: "site-cc",
  phone: "+447700900123",
  channel: "sms",
  patientName: "Priya",
  treatment: "Invisalign",
  fundingType: null,
  lastVisitAt: "2025-11-04T09:00:00.000Z",
  recallDueAt: "2026-05-04T09:00:00.000Z",
  isKnownPatient: true,
  usps: ["Open on Saturdays", "0% finance available"],
};

describe("prompt caching: the breakpoint reaches the wire", () => {
  it("sends the system prompt as ONE cached text block, not a bare string", async () => {
    const create = vi.fn().mockResolvedValue(textMessage("Hello."));
    await runAgentTurn([{ role: "user", content: "hi" }], {
      anthropic: { messages: { create } } as never,
      dispatch: vi.fn(),
      systemPrompt: "THE SYSTEM PROMPT",
      tools: AGENT_TOOLS,
    });

    const args = create.mock.calls[0][0];
    expect(Array.isArray(args.system)).toBe(true);
    expect(args.system).toEqual([
      { type: "text", text: "THE SYSTEM PROMPT", cache_control: { type: "ephemeral" } },
    ]);
    // The tools still go up as tools: the breakpoint covers them by ORDER
    // (tools render before system), not by being copied into the system block.
    expect(args.tools).toBe(AGENT_TOOLS);
  });

  it("uses exactly ONE breakpoint (the API allows at most four)", async () => {
    const create = vi.fn().mockResolvedValue(textMessage("Hello."));
    await runAgentTurn([{ role: "user", content: "hi" }], {
      anthropic: { messages: { create } } as never,
      dispatch: vi.fn(),
      systemPrompt: "sys",
      tools: AGENT_TOOLS,
    });
    const json = JSON.stringify(create.mock.calls[0][0]);
    expect(json.split('"cache_control"').length - 1).toBe(1);
  });
});

describe("prompt caching: the prefix is stable across the rounds of one turn", () => {
  it("sends a byte-identical system+tools prefix on EVERY round", async () => {
    // Three rounds: two tool calls then the reply. If any round differed by a
    // single byte ahead of the breakpoint, rounds 2 and 3 would be cache misses.
    const create = vi
      .fn()
      .mockResolvedValueOnce(toolUseMessage("t1", "find_slots", { treatment: "Exam" }))
      .mockResolvedValueOnce(toolUseMessage("t2", "treatment_info", { treatment: "Exam" }))
      .mockResolvedValueOnce(textMessage("Monday at 9am suits?"));
    const systemPrompt = buildSystemPrompt(KNOWN_PATIENT);

    await runAgentTurn([{ role: "user", content: "can I book" }], {
      anthropic: { messages: { create } } as never,
      dispatch: vi.fn().mockResolvedValue("{}"),
      systemPrompt,
      tools: AGENT_TOOLS,
    });

    expect(create).toHaveBeenCalledTimes(3);
    const prefixes = create.mock.calls.map((c) =>
      JSON.stringify({ model: c[0].model, tools: c[0].tools, system: c[0].system }),
    );
    expect(new Set(prefixes).size).toBe(1);
    // ...and it really is the cached shape, on the last round too.
    expect(prefixes[0]).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it("keeps the prefix stable across the retry the leaked-markup guard forces", async () => {
    // The guard pushes two extra MESSAGES and re-calls. Messages sit AFTER the
    // breakpoint, so the cached prefix must be untouched by that.
    const create = vi
      .fn()
      .mockResolvedValueOnce(textMessage('<invoke name="book">'))
      .mockResolvedValueOnce(textMessage("Sorry about that. Shall I find you a time?"));
    await runAgentTurn([{ role: "user", content: "book me in" }], {
      anthropic: { messages: { create } } as never,
      dispatch: vi.fn(),
      systemPrompt: buildSystemPrompt(KNOWN_PATIENT),
      tools: AGENT_TOOLS,
    });
    expect(create).toHaveBeenCalledTimes(2);
    const [a, b] = create.mock.calls.map((c) => JSON.stringify(c[0].system));
    expect(a).toBe(b);
  });
});

describe("prompt caching: the real prompts carry no per-request invalidator", () => {
  it("builds a byte-identical BOOKING AGENT prompt for the same patient", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000Z"));
    const first = buildSystemPrompt(KNOWN_PATIENT);
    vi.setSystemTime(new Date("2026-08-21T09:07:31.000Z"));
    const second = buildSystemPrompt(KNOWN_PATIENT);
    expect(second).toBe(first);
  });

  it("builds a byte-identical CO-PILOT prompt within the same day and scope", () => {
    vi.useFakeTimers();
    // Mid-morning, so the two reads below cannot straddle midnight and make this
    // test flaky the way a real-clock version would.
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000Z"));
    const scope = { label: "Vitality Dental N15", isAllSites: false };
    const first = buildCopilotSystemPrompt(scope);
    vi.setSystemTime(new Date("2026-08-21T09:04:59.000Z"));
    const second = buildCopilotSystemPrompt(scope);
    expect(second).toBe(first);
    // The date IS in there on purpose (the owner asks "what's on today"), which is
    // fine: a per-DAY prefix still caches, a per-REQUEST one never would.
    expect(first).toContain("Today is Friday, 21 August 2026.");
  });
});

describe("prompt caching: the prefix is long enough for the cache to engage", () => {
  it("BOOKING AGENT tools+system clear Sonnet 5's 1,024-token minimum", () => {
    const prefix = JSON.stringify(AGENT_TOOLS) + buildSystemPrompt(KNOWN_PATIENT);
    expect(floorTokens(prefix)).toBeGreaterThan(MIN_CACHEABLE_TOKENS);
  });

  it("CO-PILOT tools+system clear it by a wide margin", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T09:00:00.000Z"));
    const prefix =
      JSON.stringify(COPILOT_TOOLS) +
      buildCopilotSystemPrompt({ label: "Vitality Dental N15", isAllSites: false });
    // ~10,000 tokens re-sent on every one of up to 6 rounds. This is the number
    // the whole change exists for; if it ever collapses below the minimum the
    // caching silently stops paying and this test says so.
    expect(floorTokens(prefix)).toBeGreaterThan(4 * MIN_CACHEABLE_TOKENS);
  });
});
