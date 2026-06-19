import { createHmac, timingSafeEqual } from "crypto";

export interface PbSession {
  credentialId: string;
  maxTier: number;
  exp: number;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signSession(payload: PbSession, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, secret)}`;
}

export function verifySession(
  token: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): PbSession | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as PbSession;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (typeof payload.credentialId !== "string" || typeof payload.maxTier !== "number") return null;
    return payload;
  } catch {
    return null;
  }
}
