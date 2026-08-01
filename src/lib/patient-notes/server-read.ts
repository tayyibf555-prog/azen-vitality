import "server-only";
import { authEnforced } from "@/lib/auth/guard";
import { getSessionUser } from "@/lib/auth/session";
import { listNotes } from "./repository";
import type { PatientNote } from "./types";

/**
 * This patient's practice notes, read on the SERVER for the record's first paint.
 *
 * WHY IT EXISTS. The pinned band renders nothing until its client fetch lands, and it
 * sits above the tab strip in normal flow, so the strip and every tab panel painted at
 * their no-band position and were then pushed down by roughly 90px per row a network
 * round trip later. A click aimed at "Appointments" inside that window landed on a
 * note card. Everything else on the record is server-rendered; this makes the band
 * agree with it. The client hook still owns every mutation and refetches after each
 * one, so this is a seed, not a second source of truth.
 *
 * FAILURE IS REPORTED, NOT SWALLOWED. `ok: false` makes the band print the sentence it
 * already has for a failed read rather than the zero-note case, which on a record
 * where a pinned note may read "allergic to latex" are not the same screen.
 *
 * The site/patient scope is checked by the caller (the record shell resolves the
 * patient in scope before rendering anything), exactly as the API route checks it.
 */
export async function readNotesForRecord(
  siteId: string,
  patientId: string,
): Promise<{ ok: boolean; notes: PatientNote[] }> {
  try {
    const user = authEnforced() ? await getSessionUser() : null;
    const notes = await listNotes({
      siteId,
      patientId,
      viewer: { viewerId: user?.id ?? null, now: new Date() },
    });
    return { ok: true, notes };
  } catch {
    return { ok: false, notes: [] };
  }
}
