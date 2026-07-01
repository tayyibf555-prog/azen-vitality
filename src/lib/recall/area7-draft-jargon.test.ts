import { describe, it, expect, vi } from "vitest";
import { buildRecallPrompt, draftRecall } from "./draft";
import { RECALL_CADENCE } from "./cadence";
import type { RecallTarget, RecallType } from "./types";
import type { TouchChannel } from "@/lib/reactivation/types";

// AREA 7: patient-facing recall copy must NEVER carry funding jargon (NHS/private)
// and must keep the GBP + no-em-dash rails, for every recall type, channel and
// cadence step. The guarantee is enforced in the SYSTEM PROMPT the model receives.

vi.mock("@/lib/mock/clients", () => ({ getSite: () => ({ clientId: "vitality" }) }));
vi.mock("@/lib/usp/repository", () => ({ listActiveUspTexts: async () => ["Award-winning care"] }));

function target(recallType: RecallType): RecallTarget {
  return {
    id: `site-cc:123:${recallType}`,
    siteId: "site-cc",
    dentallyPatientId: "123",
    patientName: "Sarah Lindqvist",
    recallType,
    dueAt: "2026-06-25T00:00:00Z",
    overdueDays: 3,
    lastVisitAt: "2026-01-10T00:00:00Z",
    priorAttempts: 0,
    status: "due",
    consent: { sms: true, email: true, marketing: true },
    updatedFromDentallyAt: "x",
  };
}

const TYPES: RecallType[] = ["dentist", "hygienist"];
const CHANNELS: TouchChannel[] = ["sms", "email", "whatsapp"];

describe("recall prompt — funding jargon forbidden across every type/channel/step", () => {
  for (const type of TYPES) {
    for (const channel of CHANNELS) {
      for (const step of RECALL_CADENCE) {
        it(`${type}/${channel}/step${step.step} forbids NHS/private and keeps GBP + no em-dash`, () => {
          const { system, user } = buildRecallPrompt(target(type), channel, step, ["Award-winning care"]);
          // Explicit instruction never to use NHS/private funding wording.
          expect(system.toLowerCase()).toContain("nhs or private");
          expect(system.toLowerCase()).toContain("never use internal funding");
          // Rails present.
          expect(system).toContain("£");
          expect(system.toLowerCase()).toContain("no em-dash");
          // The prompt itself contains no em-dash character.
          expect(system).not.toContain("—");
          expect(user).not.toContain("—");
        });
      }
    }
  }
});

describe("draftRecall — returns the model body verbatim and sends the jargon-guarded system prompt", () => {
  it("passes the no-NHS/private system prompt to the model and trims the returned copy", async () => {
    const create = vi.fn(async (args: { system: string }) => {
      // Assert the system prompt the model receives carries the funding-jargon rail.
      expect(args.system.toLowerCase()).toContain("nhs or private");
      return { content: [{ type: "text", text: "  Hi Sarah, your check-up is due. Reply to book.  " }] };
    });
    const fakeClient = { messages: { create } } as unknown as import("@anthropic-ai/sdk").default;

    const { body } = await draftRecall(target("dentist"), "sms", RECALL_CADENCE[0], fakeClient);
    expect(create).toHaveBeenCalledOnce();
    // Body passed through, trimmed, and free of funding jargon (model was instructed).
    expect(body).toBe("Hi Sarah, your check-up is due. Reply to book.");
    expect(body.toLowerCase()).not.toContain("nhs");
    expect(body.toLowerCase()).not.toContain("private");
    expect(body).not.toContain("—");
  });
});
