import { describe, it, expect } from "vitest";
import { resolvePreferredChannel } from "./channel-pref";

// Pure channel-resolution rules. The key requirement: a WhatsApp preference is only
// honoured when WhatsApp is actually live, so with WhatsApp off nothing changes.

describe("resolvePreferredChannel", () => {
  it("honours a WhatsApp preference ONLY when WhatsApp is enabled", () => {
    // Off: the queued channel wins (nothing changes today).
    expect(resolvePreferredChannel("sms", "whatsapp", false)).toBe("sms");
    // On: the patient's WhatsApp preference is honoured.
    expect(resolvePreferredChannel("sms", "whatsapp", true)).toBe("whatsapp");
  });

  it("honours an SMS preference regardless (SMS is always deliverable to a mobile)", () => {
    expect(resolvePreferredChannel("whatsapp", "sms", true)).toBe("sms");
    expect(resolvePreferredChannel("whatsapp", "sms", false)).toBe("sms");
    expect(resolvePreferredChannel("sms", "sms", true)).toBe("sms");
  });

  it("leaves the channel unchanged when there is no preference", () => {
    expect(resolvePreferredChannel("sms", null, true)).toBe("sms");
    expect(resolvePreferredChannel("whatsapp", null, true)).toBe("whatsapp");
  });

  it("never re-routes an email message", () => {
    expect(resolvePreferredChannel("email", "whatsapp", true)).toBe("email");
    expect(resolvePreferredChannel("email", "sms", true)).toBe("email");
  });
});
