// THE LANDING TRACKER, AFTER IT STOPPED OWNING ITS OWN DELIVERY.
//
// It used to post with a bare keepalive fetch — no sendBeacon in front of it — and
// carried a named exemption in beacon-transport.test.ts saying so. The exemption's
// reasoning was that folding it into the shared transport "would change what that
// public page does". It does, and this file is what pins that the change is the one
// the page wanted: `cta_clicked` fires on the click that NAVIGATES to the booking
// page, and sendBeacon is the delivery that survives a navigation. A keepalive fetch
// is the fallback for when sendBeacon is missing or refuses the payload, and the
// shared transport tries them in that order.
//
// beacon-transport.test.ts pins the STRUCTURE (this file imports postJsonBeacon and
// holds no transport of its own). This pins the BEHAVIOUR: the envelope the
// funnel-event endpoint is owed, that nothing is sent during SSR, and that nothing
// this module does can ever throw into a public page's render or click handler.

import { describe, it, expect, afterEach } from "vitest";
import { trackLandingEvent, newSessionId, type LandingEvent } from "./track";

const globals = globalThis as unknown as Record<string, unknown>;
const STUBBED = ["window", "navigator", "Blob", "fetch"] as const;
const ORIGINAL = new Map<string, PropertyDescriptor | undefined>();

/**
 * Node's `navigator` is a getter-only own property of globalThis, so a plain
 * assignment throws. defineProperty (and restoring the captured descriptors) is the
 * only way to stand a fake browser up around this module.
 */
function stub(name: string, value: unknown): void {
  if (!ORIGINAL.has(name)) ORIGINAL.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

/** A Blob that can be read synchronously, so a test can see what was queued. */
function stubBlob(): void {
  stub(
    "Blob",
    class {
      __text: string;
      constructor(parts: string[]) {
        this.__text = parts.join("");
      }
    },
  );
}

afterEach(() => {
  for (const name of STUBBED) {
    if (!ORIGINAL.has(name)) continue;
    const descriptor = ORIGINAL.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globals[name];
  }
  ORIGINAL.clear();
});

const EVENT: LandingEvent = {
  clientSlug: "vitality",
  landingSlug: "invisalign",
  variant: "b",
  step: "cta_clicked",
  sessionId: "s_abc123",
};

/** The body the funnel-event endpoint is owed, parsed back from whatever was sent. */
function envelopeOf(body: string): unknown {
  return JSON.parse(body);
}

describe("a landing event leaves the page", () => {
  // MUTATION: drop the sendBeacon-first transport and go back to a bare keepalive
  // fetch. This is the whole reason the exemption was removed: the CTA click is a
  // navigation, and a fetch started by a page that is leaving is the request the
  // browser is entitled to cancel.
  it("prefers sendBeacon, because the CTA click is a navigation", () => {
    const posted: Array<{ url: string; body: string }> = [];
    stub("window", {});
    stubBlob();
    stub("navigator", {
      sendBeacon: (url: string, blob: { __text: string }) => {
        posted.push({ url, body: blob.__text });
        return true;
      },
    });
    stub("fetch", () => {
      throw new Error("fetch must not be reached when sendBeacon accepted the payload");
    });

    trackLandingEvent(EVENT);

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/funnel-event");
  });

  // The endpoint contract this file is the single owner of: a BATCHED envelope with
  // clientSlug, surface and sessionId at the top level, and variant/landingSlug as
  // scalars inside meta so the endpoint's sanitizeMeta keeps them.
  it("sends the batched funnel-event envelope, with variant and slug as meta scalars", () => {
    const posted: string[] = [];
    stub("window", {});
    stubBlob();
    stub("navigator", {
      sendBeacon: (_url: string, blob: { __text: string }) => {
        posted.push(blob.__text);
        return true;
      },
    });

    trackLandingEvent(EVENT);

    expect(envelopeOf(posted[0])).toEqual({
      clientSlug: "vitality",
      surface: "landing",
      sessionId: "s_abc123",
      events: [
        { step: "cta_clicked", meta: { variant: "b", landingSlug: "invisalign" } },
      ],
    });
  });

  // MUTATION: treat sendBeacon's return value as "sent". It returns FALSE when the
  // browser refuses to queue the payload, and the keepalive fetch this module used
  // to hand-roll is still the answer to that — it is now the transport's fallback
  // rather than this file's only path.
  it("still falls back to a keepalive fetch when sendBeacon refuses", () => {
    const calls: Array<[string, RequestInit]> = [];
    stub("window", {});
    stubBlob();
    stub("navigator", { sendBeacon: () => false });
    stub("fetch", (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return Promise.resolve({});
    });

    trackLandingEvent(EVENT);

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("/api/funnel-event");
    expect(calls[0][1].keepalive).toBe(true);
    expect(envelopeOf(calls[0][1].body as string)).toMatchObject({ surface: "landing" });
  });
});

describe("and it can never hurt the public page", () => {
  // MUTATION: delete the `typeof window === "undefined"` guard. A landing page is
  // server-rendered and this runs during that render; "was this page viewed?" is a
  // question only a browser can answer, and a server answering it invents a visit.
  it("does nothing at all during SSR", () => {
    const touched: string[] = [];
    stubBlob();
    stub("navigator", {
      sendBeacon: () => {
        touched.push("sendBeacon");
        return true;
      },
    });
    stub("fetch", () => {
      touched.push("fetch");
      return Promise.resolve({});
    });
    // `window` is left undefined, exactly as it is on the server.
    expect(globals.window).toBeUndefined();

    trackLandingEvent(EVENT);

    expect(touched).toEqual([]);
  });

  // MUTATION: drop the try/catch. Telemetry that throws takes a render or a click
  // handler down with it, on a PUBLIC page, in front of a prospective patient.
  it("never throws, whatever the browser does", () => {
    stub("window", {});
    stubBlob();
    stub("navigator", {
      sendBeacon: () => {
        throw new Error("blocked by an extension");
      },
    });
    stub("fetch", () => {
      throw new Error("offline");
    });

    expect(() => trackLandingEvent(EVENT)).not.toThrow();
  });

  it("swallows a rejected fetch rather than leaving it unhandled", async () => {
    stub("window", {});
    stubBlob();
    stub("navigator", { sendBeacon: () => false });
    stub("fetch", () => Promise.reject(new Error("network gone")));

    expect(() => trackLandingEvent(EVENT)).not.toThrow();
    // A rejection escaping here would surface as an unhandled rejection a tick later.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("returns nothing, because no caller can know whether the event arrived", () => {
    stub("window", {});
    stubBlob();
    stub("navigator", { sendBeacon: () => true });
    expect(trackLandingEvent(EVENT)).toBeUndefined();
  });
});

describe("the session id it correlates events under", () => {
  it("is url-safe and carries nothing about the visitor", () => {
    const id = newSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(id.length).toBeGreaterThan(8);
    expect(newSessionId()).not.toBe(id);
  });
});
