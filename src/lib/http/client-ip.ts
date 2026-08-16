// WHICH ADDRESS A PER-IP LIMIT IS SPENT AGAINST. One function, because the answer
// is a security property and three copies of a security property is three chances
// to get it wrong — and the tree already had exactly that: two routes reading it
// one way and the public submit route reading it the other.
//
// THE ORDER IS THE WHOLE GUARD.
//
//   x-real-ip        set by the platform, not forwardable by the caller. Trusted
//                    first whenever it is present.
//   x-forwarded-for  a LIST the caller can seed. The browser sends whatever it
//                    likes and the platform APPENDS the real connecting address,
//                    so the LEFTMOST entry is attacker-chosen and the RIGHTMOST is
//                    the only hop nobody upstream of us wrote.
//
// Keying a budget on the leftmost entry is a per-IP cap that caps nothing: one
// flooder mints a fresh allowance per request by changing a header. The two
// properties that make this a real limit are stated as tests rather than as
// comments — two spoofed prefixes from one real client land on the SAME key, and
// two real clients behind one spoofed prefix stay APART.
//
// "unknown" IS A SHARED BUCKET, ON PURPOSE. With no address header at all there is
// no way to tell two callers apart, so they share one allowance. That is the safe
// direction: the alternative (a fresh key per request) would hand an unlimited
// budget to precisely the caller we know least about.
//
// PURE AND HEADER-ONLY. It reads a Request's headers and nothing else — no env, no
// I/O, no platform SDK — so it is testable with a plain `new Request(...)` and
// cannot behave differently in a test than it does in production.

/** Anything with a Headers-shaped `headers`, so a Request or a plain object works. */
export interface HasHeaders {
  headers: { get(name: string): string | null };
}

/** The single shared bucket for a caller with no usable address. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * The caller's address, as the platform reports it: `x-real-ip` when present, else
 * the LAST `x-forwarded-for` entry, else `UNKNOWN_CLIENT_IP`.
 *
 * This is a RATE-LIMIT KEY, not an audit record. It is never stored against a
 * person, never returned to a caller, and never used to decide who someone is.
 */
export function clientIp(request: HasHeaders): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    // The last hop: everything to the left of it is caller-supplied.
    return hops[hops.length - 1] || UNKNOWN_CLIENT_IP;
  }

  return UNKNOWN_CLIENT_IP;
}
