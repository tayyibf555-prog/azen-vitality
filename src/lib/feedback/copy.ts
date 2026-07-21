// User-facing copy for the in-app "Request a change" widget. Kept in one plain,
// client-safe module (no server-only, no React) so the wording has a single
// source of truth: the widget renders exactly these strings, and a node-env test
// (copy.test.ts) can assert them without rendering the component. This is a
// general "send us a request" box, not a bug tracker, so the copy stays warm and
// never claims an email/notification was sent (the FEEDBACK_WEBHOOK_URL notifier
// is optional and dormant until configured; requests are captured regardless).

export const FEEDBACK_WIDGET_COPY = {
  trigger: "Request a change",
  heading: "Request a change or update",
  helper:
    "Spotted something you would like changed, or want a new tweak or feature? Type it below and it comes straight to our team. We will pick it up and get back to you.",
  placeholder: "Describe the change or update you would like...",
  success: "Thanks, your request has reached our team.",
} as const;
