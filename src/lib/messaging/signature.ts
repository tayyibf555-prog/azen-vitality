import { createHmac, timingSafeEqual } from "node:crypto";

export function computeTwilioSignature(
  url: string,
  params: Record<string, string>,
  authToken: string,
): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

export function verifyTwilioSignature(
  url: string,
  params: Record<string, string>,
  header: string,
  authToken: string,
): boolean {
  const expected = computeTwilioSignature(url, params, authToken);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
