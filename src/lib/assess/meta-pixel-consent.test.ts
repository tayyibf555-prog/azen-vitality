// THE FOUR THINGS THIS FEATURE DOES IN A BROWSER, tested as behaviour rather
// than as source text.
//
// vitest runs in a node environment, so there is no window, no localStorage and no
// document. That is not an obstacle here, it is the first test: every entry point
// guards on `typeof window` and must be inert on the server, because these
// functions are imported by components that render there. The rest of the file
// installs a minimal fake window/document -- deliberately minimal, so that a
// function reaching for something it should not have reaches for undefined and
// fails loudly rather than silently working under jsdom.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  injectMetaPixel,
  metaConsentServerSnapshot,
  metaConsentSnapshot,
  subscribeMetaConsent,
  metaConsentGranted,
  metaSubmitFields,
  newMetaEventId,
  readMetaConsent,
  recordMetaConsent,
  trackMetaLead,
} from "./meta-pixel-consent";
import { META_CONSENT_STORAGE_KEY } from "./meta-pixel";

const REAL_ID = "123456789012345";

/* ---------------------------------------------------------------------------
 * A fake browser, small enough to see all of.
 * ------------------------------------------------------------------------- */

interface FakeScript {
  attrs: Record<string, string>;
  type: string;
  text: string;
}

interface FakeWorld {
  store: Map<string, string>;
  setItemCalls: number;
  getItemCalls: number;
  scripts: FakeScript[];
  fbqCalls: unknown[][];
}

const globals = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
};

function installBrowser(options: { storageThrows?: boolean; withFbq?: boolean } = {}): FakeWorld {
  const world: FakeWorld = {
    store: new Map(),
    setItemCalls: 0,
    getItemCalls: 0,
    scripts: [],
    fbqCalls: [],
  };

  const localStorage = {
    getItem(key: string): string | null {
      world.getItemCalls += 1;
      if (options.storageThrows) throw new Error("storage is not available");
      return world.store.has(key) ? (world.store.get(key) as string) : null;
    },
    setItem(key: string, value: string): void {
      world.setItemCalls += 1;
      if (options.storageThrows) throw new Error("storage is not available");
      world.store.set(key, value);
    },
  };

  const win: Record<string, unknown> = { localStorage };
  if (options.withFbq) {
    win.fbq = (...args: unknown[]) => {
      world.fbqCalls.push(args);
    };
  }

  const head = {
    appendChild(node: FakeScript) {
      world.scripts.push(node);
    },
  };

  globals.window = win;
  globals.document = {
    querySelector(selector: string): FakeScript | null {
      const match = /^script\[([^\]]+)\]$/.exec(selector);
      if (!match) return null;
      return world.scripts.find((s) => match[1] in s.attrs) ?? null;
    },
    createElement(): FakeScript {
      const node: FakeScript = { attrs: {}, type: "", text: "" };
      return Object.assign(node, {
        setAttribute(name: string, value: string) {
          node.attrs[name] = value;
        },
      });
    },
    head,
  };
  return world;
}

function uninstallBrowser(): void {
  delete globals.window;
  delete globals.document;
}

afterEach(() => {
  uninstallBrowser();
  vi.restoreAllMocks();
});

/* ---------------------------------------------------------------------------
 * 1. The server.
 * ------------------------------------------------------------------------- */

describe("everything is inert without a browser", () => {
  // MUTATION: drop a `typeof window` guard and every server render of a public
  // assessment page throws -- on the one page ad spend points at.
  it("reads nothing, writes nothing, injects nothing, tracks nothing", () => {
    expect(globals.window).toBeUndefined();
    expect(readMetaConsent()).toBe(null);
    expect(metaConsentGranted()).toBe(false);
    expect(injectMetaPixel(REAL_ID)).toBe(false);
    expect(() => recordMetaConsent("granted")).not.toThrow();
    expect(() => trackMetaLead("abcdefgh")).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * 2. Reading is not writing.
 * ------------------------------------------------------------------------- */

describe("the decision", () => {
  let world: FakeWorld;
  beforeEach(() => {
    world = installBrowser();
  });

  it("is 'not decided' on a device that has never answered", () => {
    expect(readMetaConsent()).toBe(null);
    expect(metaConsentGranted()).toBe(false);
  });

  // MUTATION: seed the key with a default on first read ("so we know we asked").
  // THE PROMPT MUST SET NOTHING BEFORE CONSENT, and reading is the only thing it
  // does before a click. This is the assertion that holds that line.
  it("reading creates nothing at all", () => {
    readMetaConsent();
    readMetaConsent();
    metaConsentGranted();
    expect(world.getItemCalls).toBeGreaterThan(0);
    expect(world.setItemCalls).toBe(0);
    expect(world.store.size).toBe(0);
  });

  it("records a grant, and honours it", () => {
    recordMetaConsent("granted");
    expect(world.store.get(META_CONSENT_STORAGE_KEY)).toBe("granted");
    expect(readMetaConsent()).toBe("granted");
    expect(metaConsentGranted()).toBe(true);
  });

  // MUTATION: store only grants ("a refusal is the default anyway"). A refusal
  // that is forgotten on the next page view is not a refusal, it is a nag -- and
  // the visitor is asked again on every single page they open.
  it("records a refusal too, so it survives the next page view", () => {
    recordMetaConsent("denied");
    expect(world.store.get(META_CONSENT_STORAGE_KEY)).toBe("denied");
    expect(readMetaConsent()).toBe("denied");
    expect(metaConsentGranted()).toBe(false);
  });

  it("ignores a value it did not write", () => {
    world.store.set(META_CONSENT_STORAGE_KEY, "true");
    expect(readMetaConsent()).toBe(null);
    expect(metaConsentGranted()).toBe(false);
  });
});

describe("storage that refuses to work is not an error a patient sees", () => {
  // Safari's private browsing and some enterprise policies throw outright.
  beforeEach(() => {
    installBrowser({ storageThrows: true });
  });

  it("degrades to 'not decided' rather than throwing", () => {
    expect(() => readMetaConsent()).not.toThrow();
    expect(readMetaConsent()).toBe(null);
    // ...which means the pixel does not load, the fail-closed direction.
    expect(metaConsentGranted()).toBe(false);
  });

  it("swallows a failed write, because a warning helps nobody mid-questionnaire", () => {
    expect(() => recordMetaConsent("granted")).not.toThrow();
  });
});

/* ---------------------------------------------------------------------------
 * 3. Injection.
 * ------------------------------------------------------------------------- */

describe("the pixel is inserted, not rendered", () => {
  let world: FakeWorld;
  beforeEach(() => {
    world = installBrowser();
  });

  it("appends one script carrying the configured id", () => {
    expect(injectMetaPixel(REAL_ID)).toBe(true);
    expect(world.scripts).toHaveLength(1);
    expect(world.scripts[0].text).toContain(`fbq('init','${REAL_ID}')`);
    expect(world.scripts[0].text).toContain("connect.facebook.net");
    // The marker is what makes a second call a no-op.
    expect(world.scripts[0].attrs).toHaveProperty("data-meta-pixel");
  });

  // MUTATION: drop the marker check. React effects re-run, so the page would end
  // up with two copies of fbq -- and every event counted twice, which is worse
  // than no measurement because it looks like measurement.
  it("is idempotent across re-renders", () => {
    expect(injectMetaPixel(REAL_ID)).toBe(true);
    expect(injectMetaPixel(REAL_ID)).toBe(false);
    expect(injectMetaPixel(REAL_ID)).toBe(false);
    expect(world.scripts).toHaveLength(1);
  });

  // MUTATION: skip the grammar re-check here. This is the function that turns a
  // stored string into executable code on a public page.
  it.each(["", "not-an-id", "1');alert(1);('"])("inserts nothing for %s", (value) => {
    expect(injectMetaPixel(value)).toBe(false);
    expect(world.scripts).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 * 4. The conversion.
 * ------------------------------------------------------------------------- */

describe("the Lead event", () => {
  it("does not fire without consent, even when fbq is sitting right there", () => {
    // MUTATION: drop the consent re-check in trackMetaLead. fbq may exist because
    // another script defined it, or because the visitor declined AFTER the page
    // loaded -- and the submit handler runs a long time after the mount effect.
    const world = installBrowser({ withFbq: true });
    recordMetaConsent("denied");
    trackMetaLead("abcdefgh");
    expect(world.fbqCalls).toHaveLength(0);
  });

  it("fires once, with the shared event id and no custom data", () => {
    const world = installBrowser({ withFbq: true });
    recordMetaConsent("granted");
    trackMetaLead("abcdefgh");
    expect(world.fbqCalls).toHaveLength(1);
    const [command, event, custom, options] = world.fbqCalls[0];
    expect(command).toBe("track");
    expect(event).toBe("Lead");
    // EMPTY custom data, deliberately: no value, no currency, no treatment, no
    // score. The browser event says a conversion happened and nothing more.
    expect(custom).toEqual({});
    expect(options).toEqual({ eventID: "abcdefgh" });
  });

  it("is silent when fbq never loaded (an ad blocker, a blocked network)", () => {
    installBrowser({ withFbq: false });
    recordMetaConsent("granted");
    expect(() => trackMetaLead("abcdefgh")).not.toThrow();
  });

  it("never throws into a submit handler, whatever fbq does", () => {
    installBrowser();
    recordMetaConsent("granted");
    (globals.window as Record<string, unknown>).fbq = () => {
      throw new Error("an extension replaced fbq");
    };
    expect(() => trackMetaLead("abcdefgh")).not.toThrow();
  });
});

describe("the fields a quiz posts", () => {
  it("carry this device's own answer and a fresh event id", () => {
    installBrowser();
    expect(metaSubmitFields().metaConsent).toBe(false);
    recordMetaConsent("granted");
    const fields = metaSubmitFields();
    expect(fields.metaConsent).toBe(true);
    // Long enough and plain enough to survive the server's own id parser.
    expect(fields.metaEventId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

  it("mints a different id every time, so two submissions are two conversions", () => {
    installBrowser();
    const ids = new Set(Array.from({ length: 50 }, () => newMetaEventId()));
    expect(ids.size).toBe(50);
  });

  it("mints an acceptable id even where crypto.randomUUID is missing", () => {
    installBrowser();
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("not available");
    });
    expect(newMetaEventId()).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

/* ---------------------------------------------------------------------------
 * 5. The decision as an external store (what React renders from).
 * ------------------------------------------------------------------------- */

describe("the store React reads", () => {
  // MUTATION: return null from the server snapshot instead of "unknown". The
  // banner would then be in the server's HTML for every visitor -- including the
  // one who declined last week and now watches it flash past on every page.
  it("answers 'unknown' on the server, always", () => {
    expect(metaConsentServerSnapshot()).toBe("unknown");
    uninstallBrowser();
    expect(metaConsentServerSnapshot()).toBe("unknown");
  });

  it("distinguishes 'we looked and found nothing' from 'we have not looked'", () => {
    installBrowser();
    expect(metaConsentSnapshot()).toBe("undecided");
    recordMetaConsent("denied");
    expect(metaConsentSnapshot()).toBe("denied");
    recordMetaConsent("granted");
    expect(metaConsentSnapshot()).toBe("granted");
  });

  // MUTATION: cache the snapshot. React calls getSnapshot on every render and only
  // needs the result to be STABLE WHEN NOTHING CHANGED -- which a string is, by
  // value, for free. A cache would go stale the moment a visitor clears their site
  // data or decides in another tab.
  it("is stable by value across calls, without a cache to go stale", () => {
    const world = installBrowser();
    expect(metaConsentSnapshot()).toBe(metaConsentSnapshot());
    world.store.set("assess:meta-consent", "granted");
    expect(metaConsentSnapshot()).toBe("granted"); // re-read, not remembered
    world.store.clear();
    expect(metaConsentSnapshot()).toBe("undecided");
  });

  it("tells every subscriber when a decision is made, and stops when unsubscribed", () => {
    installBrowser();
    let calls = 0;
    const unsubscribe = subscribeMetaConsent(() => {
      calls += 1;
    });
    recordMetaConsent("granted");
    expect(calls).toBe(1);
    recordMetaConsent("denied");
    expect(calls).toBe(2);
    unsubscribe();
    recordMetaConsent("granted");
    expect(calls).toBe(2);
  });

  // MUTATION: notify inside the try that wraps setItem. On a browser that cannot
  // persist the choice, the banner would then stay on screen and the buttons would
  // appear to do nothing at all.
  it("still notifies when the write itself failed", () => {
    installBrowser({ storageThrows: true });
    let told = false;
    const unsubscribe = subscribeMetaConsent(() => {
      told = true;
    });
    recordMetaConsent("denied");
    expect(told).toBe(true);
    unsubscribe();
  });

  it("one broken subscriber cannot stop the others being told", () => {
    installBrowser();
    let second = false;
    const a = subscribeMetaConsent(() => {
      throw new Error("a subscriber blew up");
    });
    const b = subscribeMetaConsent(() => {
      second = true;
    });
    expect(() => recordMetaConsent("granted")).not.toThrow();
    expect(second).toBe(true);
    a();
    b();
  });
});
