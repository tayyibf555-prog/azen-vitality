// Is a client's Meta (Facebook / Instagram) ad account connected to the platform?
//
// There is NO Meta business connection built yet: connecting a client's Meta account
// (the OAuth / Meta business login) is blocked on the client completing that login,
// and the publish adapter that would push a campaign live to Meta is not built. So
// today this is ALWAYS not-connected, and the co-pilot must never claim a Meta
// campaign went live.
//
// This is the single SEAM to flip once a real connection exists. It reads an env
// allow-list of connected client ids (META_ADS_CONNECTED_CLIENTS, comma-separated),
// defaulting to not-connected when the var is unset or empty. Replace the body with
// the real connection lookup (e.g. a stored Meta business token per client) when the
// Meta integration lands.

/** True only when this client's Meta account is on the connected allow-list. Defaults
 *  to false. This is the gate; the credentials that make publishing actually work are
 *  read separately by metaConnection (both must be present to be usable). */
export function isMetaConnected(clientId: string): boolean {
  if (!clientId) return false;
  const raw = process.env.META_ADS_CONNECTED_CLIENTS;
  if (!raw) return false;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(clientId);
}

/**
 * The full connection config for a client. `connected` is true ONLY when the client
 * is on the allow-list AND all three Meta credentials are present, because publishing
 * (and reading insights) needs every one of them:
 *   - accessToken  (META_ACCESS_TOKEN)      : the long-lived system-user / page token
 *   - adAccountId  (META_AD_ACCOUNT_ID)      : the ad account campaigns are created in
 *   - pageId       (META_PAGE_ID)            : the Facebook Page the ad creative posts as
 *
 * Today none of these env vars are set, so `connected` is false for every client and
 * nothing publishes. The ad account id is normalised to Meta's `act_<id>` form. This is
 * the single seam to satisfy the day the client's Meta business account connects; no
 * publish/metrics code changes when it flips.
 */
export interface MetaConnection {
  connected: boolean;
  accessToken?: string;
  adAccountId?: string;
  pageId?: string;
}

function envOrUndefined(name: string): string | undefined {
  const v = process.env[name];
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** Normalise an ad account id to Meta's `act_<id>` form (idempotent). */
function normaliseAdAccountId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

/** Read the connection config for a client. See MetaConnection. */
export function metaConnection(clientId: string): MetaConnection {
  const accessToken = envOrUndefined("META_ACCESS_TOKEN");
  const adAccountId = normaliseAdAccountId(envOrUndefined("META_AD_ACCOUNT_ID"));
  const pageId = envOrUndefined("META_PAGE_ID");
  const connected = isMetaConnected(clientId) && Boolean(accessToken && adAccountId && pageId);
  if (!connected) return { connected: false };
  return { connected, accessToken, adAccountId, pageId };
}

