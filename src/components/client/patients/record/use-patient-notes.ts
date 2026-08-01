"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { notesKey, publishNotesChanged, subscribeNotesChanged } from "@/lib/patient-notes/notes-bus";
import type { NoteColour, PatientNote, PatientNoteSource } from "@/lib/patient-notes/types";

/**
 * One patient's practice notes, and the four things that can be done to them.
 *
 * Both surfaces that render notes use THIS: the pinned band in the record layout and
 * the practice-notes stream in the Notes tab. That is what stops them disagreeing
 * about what is pinned, in what order, or whether a pin took: they read the same
 * endpoint, they order by the same server-side rule, and every mutation publishes on
 * the shared bus so the other surface refetches.
 *
 * Nothing here decides anything. The order comes from the server, `canEdit` comes
 * from the server, and the volume rules come from lib/patient-notes/pin-layout.ts.
 * This is transport and busy state only.
 *
 * The client slug comes from the route, exactly as the old notes panel read it: the
 * notes API is client-scoped, and both trees (/c/[client] and /owner/[client]) name
 * that segment `client`.
 */

export interface PatientNotesApi {
  notes: PatientNote[];
  loading: boolean;
  /** The list read failed. Distinct from "this patient has none": the caller must say
   *  so in different words, on a clinical record above all. */
  failed: boolean;
  /** The last write's message, in the words the server used. */
  error: string | null;
  clearError: () => void;
  /** The note currently being written to, so one card can show a busy state. */
  busyId: string | null;
  saving: boolean;
  add: (body: string, source: PatientNoteSource) => Promise<boolean>;
  setPinned: (noteId: string, pinned: boolean) => Promise<boolean>;
  setColour: (noteId: string, colour: NoteColour | null) => Promise<boolean>;
  setBody: (noteId: string, body: string) => Promise<boolean>;
}

export function usePatientNotes(
  siteId: string,
  patientId: string,
  /**
   * The server's own read of the same list, so the first paint is already right.
   * Without it the pinned band rendered nothing until the fetch landed and then
   * pushed the tab strip and every panel down under the reader's cursor. Undefined
   * means no server read was made (the quick view), which keeps the old behaviour.
   */
  seed?: { ok: boolean; notes: PatientNote[] },
): PatientNotesApi {
  const params = useParams<{ client: string }>();
  const client = params?.client ?? "";

  const [notes, setNotes] = useState<PatientNote[]>(seed?.notes ?? []);
  const [loading, setLoading] = useState(seed === undefined);
  const [failed, setFailed] = useState(seed !== undefined && !seed.ok);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const key = notesKey(siteId, patientId);

  /**
   * A sequence number rather than a per-call "alive" flag, because load() is fired
   * from three places (mount, the bus, and after every write) and two reads can be in
   * flight at once. Only the newest response is applied, so a slow read that started
   * before a pin can never land after it and paint the note as unpinned again.
   * Bumping it on unmount also drops any response that arrives after this record is
   * gone from the screen.
   */
  const seq = useRef(0);

  const load = useCallback(() => {
    const ticket = ++seq.current;
    fetch(
      `/api/patient-notes?client=${encodeURIComponent(client)}&siteId=${encodeURIComponent(siteId)}&patientId=${encodeURIComponent(patientId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: { ok?: boolean; notes?: PatientNote[] }) => {
        if (ticket !== seq.current) return;
        if (d.ok) {
          setNotes(d.notes ?? []);
          setFailed(false);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (ticket === seq.current) setFailed(true);
      })
      .finally(() => {
        if (ticket === seq.current) setLoading(false);
      });
  }, [client, siteId, patientId]);

  // A SUCCESSFUL seed is already correct on the first paint, so it is not refetched on
  // mount: a second identical read would only reintroduce the flash the seed exists to
  // remove. A FAILED seed is retried, because a transient server-side failure should
  // not leave the band stuck on its caveat for the life of the page. Every mutation and
  // every bus message below refetches either way.
  const seeded = useRef(seed?.ok === true);
  useEffect(() => {
    if (seeded.current) {
      seeded.current = false;
      return;
    }
    load();
    return () => {
      seq.current += 1;
    };
  }, [load]);

  // Somebody else's surface changed this patient's notes: refetch rather than guess.
  useEffect(() => subscribeNotesChanged(key, () => load()), [key, load]);

  const patch = useCallback(
    async (noteId: string, change: Record<string, unknown>): Promise<boolean> => {
      setBusyId(noteId);
      setError(null);
      try {
        const res = await fetch("/api/patient-notes", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client, siteId, patientId, noteId, ...change }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !d.ok) throw new Error(d.error ?? "That change could not be saved.");
        publishNotesChanged(key);
        load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "That change could not be saved.");
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [client, siteId, patientId, key, load],
  );

  const add = useCallback(
    async (body: string, source: PatientNoteSource): Promise<boolean> => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch("/api/patient-notes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ client, siteId, patientId, body, source }),
        });
        const d = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !d.ok) throw new Error(d.error ?? "could not save the note");
        publishNotesChanged(key);
        load();
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : "could not save the note");
        return false;
      } finally {
        setSaving(false);
      }
    },
    [client, siteId, patientId, key, load],
  );

  return {
    notes,
    loading,
    failed,
    error,
    clearError: () => setError(null),
    busyId,
    saving,
    add,
    setPinned: (noteId, pinned) => patch(noteId, { pinned }),
    setColour: (noteId, colour) => patch(noteId, { colour }),
    setBody: (noteId, body) => patch(noteId, { body }),
  };
}
