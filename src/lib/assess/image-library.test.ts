// The manifest is the whole of the "a funnel picture is safe" argument, so this
// suite checks the two things a manifest can be wrong about: it lists a file that
// is not there (a broken image on a live, paid-for page), or it lets something
// through that is not a curated asset (the URL field we deliberately did not
// build). Everything else here is a lookup that must fail closed.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  ASSESS_IMAGES,
  ASSESS_IMAGE_KEYS,
  ASSESS_IMAGE_KEY_FORMAT,
  ASSESS_IMAGE_ROOTS,
  assessImage,
  assessImageAlt,
  assessImageFitsSlot,
  assessImagePath,
  assessImagesForSlot,
  isAssessImageKey,
} from "./image-library";
import { scanBannedText } from "@/lib/landing/compliance";
import { FLOW_JARGON_PATTERNS } from "@/lib/smile-assessment/flow-copy";

const publicPath = (p: string): string => resolve(process.cwd(), "public", p.replace(/^\//, ""));

/**
 * Intrinsic size straight out of the file's own header, so the manifest cannot
 * quietly disagree with the asset. Two formats, because those are the two we ship:
 * lossy WebP (the answer tiles) and baseline JPEG (the screen pictures). Anything
 * else returns null and the test says so rather than passing silently.
 */
function intrinsicSize(file: Buffer): { width: number; height: number } | null {
  // RIFF....WEBP, then a chunk. "VP8 " (lossy) puts the 14-bit dimensions right
  // after the 3-byte frame tag and the 0x9d012a start code.
  if (file.length > 30 && file.toString("ascii", 0, 4) === "RIFF" && file.toString("ascii", 8, 12) === "WEBP") {
    if (file.toString("ascii", 12, 16) === "VP8 ") {
      return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
    }
    return null;
  }
  // JPEG: walk the segment chain to the first start-of-frame marker.
  if (file.length > 4 && file[0] === 0xff && file[1] === 0xd8) {
    let i = 2;
    while (i + 9 < file.length) {
      if (file[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = file[i + 1]!;
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { height: file.readUInt16BE(i + 5), width: file.readUInt16BE(i + 7) };
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      i += 2 + file.readUInt16BE(i + 2);
    }
  }
  return null;
}

describe("every entry points at an asset we actually ship", () => {
  it.each(ASSESS_IMAGES.map((i) => [i.key, i] as const))("%s exists on disk", (_key, image) => {
    expect(existsSync(publicPath(image.path)), image.path).toBe(true);
    expect(statSync(publicPath(image.path)).size).toBeGreaterThan(0);
  });

  it.each(ASSESS_IMAGES.map((i) => [i.key, i] as const))(
    "%s declares the size the file really is",
    (_key, image) => {
      const size = intrinsicSize(readFileSync(publicPath(image.path)));
      expect(size, `${image.path}: unreadable header, so the declared size cannot be trusted`).not.toBeNull();
      expect(size).toEqual({ width: image.width, height: image.height });
    },
  );

  it("keeps answer tiles small enough to draw eight of them on a phone", () => {
    for (const image of assessImagesForSlot("answer")) {
      expect(statSync(publicPath(image.path)).size, image.path).toBeLessThan(20_000);
    }
  });
});

describe("the allowlist is the only way in", () => {
  it("lists nothing outside /assess or /landing", () => {
    for (const image of ASSESS_IMAGES) {
      expect(ASSESS_IMAGE_ROOTS.some((root) => image.path.startsWith(root)), image.path).toBe(true);
    }
  });

  it("has no traversal, no protocol and no protocol-relative path", () => {
    for (const image of ASSESS_IMAGES) {
      expect(image.path, image.key).not.toMatch(/\.\.|:|\/\//);
    }
  });

  it("keys nothing in a shape a browser would fetch", () => {
    // The invariant behind "a funnel cannot reference a raw URL": it is not that
    // the manifest happens not to contain one, it is that a key CANNOT be one.
    // Adding an entry keyed "https://..." fails here, not in production.
    for (const image of ASSESS_IMAGES) {
      expect(image.key, image.key).toMatch(ASSESS_IMAGE_KEY_FORMAT);
      expect(isAssessImageKey(image.key), image.key).toBe(true);
    }
  });

  it("has unique keys and unique paths", () => {
    expect(new Set(ASSESS_IMAGE_KEYS).size).toBe(ASSESS_IMAGES.length);
    expect(new Set(ASSESS_IMAGES.map((i) => i.path)).size).toBe(ASSESS_IMAGES.length);
  });

  it("covers both slots, or half the feature has nothing to draw", () => {
    expect(assessImagesForSlot("answer").length).toBeGreaterThan(0);
    expect(assessImagesForSlot("hero").length).toBeGreaterThan(0);
  });
});

describe("a reference that is not a curated key resolves to nothing", () => {
  // The whole point of a key: these are the values that WOULD have been legal in
  // a URL field, and every one of them has to be a dead end.
  const notKeys = [
    "https://example.com/x.jpg",
    "//example.com/x.jpg",
    "/assess/conditions/crowded.webp", // the real path, which is still not a key
    "../../etc/passwd",
    "conditions/crowded.webp",
    "Conditions/Crowded",
    "conditions/does-not-exist",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "",
    " conditions/crowded",
  ];

  it.each(notKeys)("rejects %j", (value) => {
    expect(isAssessImageKey(value)).toBe(false);
    expect(assessImage(value)).toBeUndefined();
    expect(assessImagePath(value)).toBeNull();
    expect(assessImageAlt(value)).toBeNull();
  });

  it("rejects a non-string, including the shapes a jsonb column can hold", () => {
    for (const value of [null, undefined, 7, {}, [], true]) {
      expect(isAssessImageKey(value)).toBe(false);
    }
  });

  it("resolves a real key to its path, alt and slot", () => {
    expect(isAssessImageKey("conditions/crowded")).toBe(true);
    expect(assessImagePath("conditions/crowded")).toBe("/assess/conditions/crowded.webp");
    expect(assessImageAlt("conditions/crowded")).toBe("Crowded teeth 3D model");
    expect(assessImageFitsSlot("conditions/crowded", "answer")).toBe(true);
    expect(assessImageFitsSlot("conditions/crowded", "hero")).toBe(false);
    expect(assessImageFitsSlot("nope", "answer")).toBe(false);
  });
});

describe("the default alt text is patient-facing copy and is held to it", () => {
  it("carries no banned wording and no funding jargon", () => {
    for (const image of ASSESS_IMAGES) {
      expect(scanBannedText(image.alt), image.key).toEqual([]);
      for (const re of FLOW_JARGON_PATTERNS) {
        expect(re.test(image.alt), `${image.key}: "${image.alt}"`).toBe(false);
      }
    }
  });

  it("says something, because an empty alt is a picture a screen reader skips", () => {
    for (const image of ASSESS_IMAGES) {
      expect(image.alt.trim().length, image.key).toBeGreaterThan(3);
    }
  });
});
