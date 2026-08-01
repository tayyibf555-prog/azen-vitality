/**
 * A one-line broadcast so the two places a patient's notes are rendered stay in step.
 *
 * The pinned band lives in the record's LAYOUT and the Notes tab lives in a PAGE, so
 * they are siblings with no common client component to hold state in, and stage 1's
 * layout is deliberately not being reopened to add a provider. Pinning a note in the
 * tab must still make it appear in the band above, immediately, or a nurse will pin
 * twice and then wonder which one took.
 *
 * Browser only, and it degrades to nothing on the server: if `window` is absent the
 * publish is a no-op and the subscribe returns an unsubscribe that does nothing.
 * Scoped by site and patient so an open quick view for another patient is not
 * refetched by somebody else's edit.
 */

const EVENT = "patient-notes:changed";

export function notesKey(siteId: string, patientId: string): string {
  return `${siteId}:${patientId}`;
}

export function publishNotesChanged(key: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
}

export function subscribeNotesChanged(key: string, handler: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => {
    if ((e as CustomEvent<string>).detail === key) handler();
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
