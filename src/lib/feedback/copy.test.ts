// The in-app widget renders exactly these strings (feedback-widget.tsx imports
// FEEDBACK_WIDGET_COPY and uses it for the trigger, heading, helper, placeholder
// and success toast). Asserting the single source of copy here is how we verify
// the widget's new "request a change" labels in a node-only test environment,
// where rendering the client component is not available.
import { describe, it, expect } from "vitest";
import { FEEDBACK_WIDGET_COPY } from "./copy";

describe("feedback widget copy (request-a-change reframing)", () => {
  it("uses request-framed labels, not bug-reporting language", () => {
    expect(FEEDBACK_WIDGET_COPY.trigger).toBe("Request a change");
    expect(FEEDBACK_WIDGET_COPY.heading).toBe("Request a change or update");
    expect(FEEDBACK_WIDGET_COPY.placeholder).toMatch(/change or update/i);
    expect(FEEDBACK_WIDGET_COPY.helper).toMatch(/get back to you/i);

    // None of the user-facing copy reads like a bug tracker any more.
    const allCopy = Object.values(FEEDBACK_WIDGET_COPY).join(" ").toLowerCase();
    expect(allCopy).not.toContain("report an issue");
    expect(allCopy).not.toContain("bug");
    expect(allCopy).not.toContain("issue");
  });

  it("keeps the success state generic (never claims an email or notification was sent)", () => {
    // The webhook is optional and dormant until configured, so the confirmation
    // must not promise a notification went out; it only says the team has it.
    expect(FEEDBACK_WIDGET_COPY.success).toMatch(/reached our team/i);
    const success = FEEDBACK_WIDGET_COPY.success.toLowerCase();
    expect(success).not.toContain("email");
    expect(success).not.toContain("notif");
    expect(success).not.toContain("sent");
  });
});
