// Canonical phone handling. Public forms accept any format a person types
// (`07700 900123`, `+44 7700 900123`, `(07700) 900123`); Twilio always delivers
// the inbound `From` in E.164 (`+447700900123`). We normalise to one canonical
// E.164 string at every trust boundary so:
//   - the rate-limit key is per-handset (not per-format),
//   - the `lead:<phone>` conversation key matches on both the outbound first
//     contact and the inbound reply, so threading actually works,
//   - only well-formed numbers ever reach Twilio.

/**
 * Normalise a raw phone string to E.164, defaulting to UK (+44). Returns null
 * for anything that isn't a plausible phone number (so callers can reject it).
 */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.replace(/[^\d+]/g, ""); // strip spaces, dashes, parens, etc.
  if (s === "" || s === "+") return null;
  if (s.startsWith("+")) {
    return /^\+\d{8,15}$/.test(s) ? s : null;
  }
  if (s.startsWith("00")) s = "+" + s.slice(2); // 00 international prefix
  else if (s.startsWith("0")) s = "+44" + s.slice(1); // UK national 07... -> +447...
  else if (s.startsWith("44")) s = "+" + s;
  else s = "+44" + s; // bare national number
  return /^\+\d{8,15}$/.test(s) ? s : null;
}

/** Basic email shape check + lowercase/trim, or null if not a plausible email. */
export function normaliseEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e) ? e : null;
}
