// Shared auth gate for the mock Dentally handlers.
//
// Mirrors real Dentally: every request must carry a non-empty
// `Authorization: Bearer <token>` header. Any non-empty bearer is accepted
// (this is a mock). Missing/empty tokens return the real 401 error envelope.

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization") ?? request.headers.get("Authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/**
 * Returns a 401 Response mirroring Dentally's error envelope when the request
 * lacks a valid bearer token, or `null` when the request is authorised.
 */
export function unauthorizedIfMissingBearer(request: Request): Response | null {
  if (bearerToken(request)) return null;
  return Response.json(
    {
      error: {
        type: "invalid_request_error",
        message: "A valid Authorization: Bearer <token> header is required.",
      },
    },
    { status: 401 },
  );
}
