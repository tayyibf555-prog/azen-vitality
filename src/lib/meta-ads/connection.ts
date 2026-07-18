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

/** True only when this client's Meta account is connected. Defaults to false. */
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
