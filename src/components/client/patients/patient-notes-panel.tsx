"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { Mic, Square, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PatientNote } from "@/lib/patient-notes/types";

function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

// Practice notes for one patient: a typed/dictated composer plus the saved list.
// Notes are stored in our platform (Dentally stays read-only); voice dictation
// records in the browser and is transcribed server-side.
export function PatientNotesPanel({ siteId, patientId }: { siteId: string; patientId: string }) {
  const params = useParams<{ client: string }>();
  const client = params.client;

  const [notes, setNotes] = useState<PatientNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<"typed" | "voice">("typed");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(
      `/api/patient-notes?client=${encodeURIComponent(client)}&siteId=${encodeURIComponent(siteId)}&patientId=${encodeURIComponent(patientId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d: { ok?: boolean; notes?: PatientNote[] }) => setNotes(d.ok ? d.notes ?? [] : []))
      .catch(() => setNotes([]))
      .finally(() => setLoading(false));
  }, [client, siteId, patientId]);

  useEffect(() => {
    load();
  }, [load]);

  // Release the mic if the drawer closes mid-recording.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function save() {
    const text = body.trim();
    if (!text || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/patient-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, siteId, patientId, body: text, source: sourceRef.current }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "could not save the note");
      setBody("");
      sourceRef.current = "typed";
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not save the note");
    } finally {
      setSaving(false);
    }
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const fd = new FormData();
          fd.append("audio", blob, "note.webm");
          const res = await fetch("/api/patient-notes/transcribe", { method: "POST", body: fd });
          const d = (await res.json()) as { ok?: boolean; text?: string; error?: string };
          if (!res.ok || !d.ok) throw new Error(d.error ?? "could not transcribe the recording");
          const text = (d.text ?? "").trim();
          if (text) {
            setBody((prev) => (prev ? `${prev} ${text}` : text));
            sourceRef.current = "voice";
          }
        } catch (e) {
          setError(e instanceof Error ? e.message : "could not transcribe the recording");
        } finally {
          setTranscribing(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      // Release the mic if getUserMedia succeeded but recorder setup failed.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
      setError("Microphone access was blocked, or recording is not supported here. Type your note instead.");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-line bg-card-muted p-3">
        <textarea
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            if (sourceRef.current === "voice" && !e.target.value.trim()) sourceRef.current = "typed";
          }}
          placeholder="Add a note for this patient. Type, or tap the mic to dictate."
          rows={3}
          className="w-full resize-y rounded-lg border border-line bg-card px-3 py-2 text-sm text-navy placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            disabled={transcribing || saving}
            aria-label={recording ? "Stop recording" : "Dictate a note"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors disabled:opacity-50",
              recording
                ? "border-danger/30 bg-danger/10 text-danger"
                : "border-line-strong bg-card text-navy hover:bg-card-muted",
            )}
          >
            {transcribing ? (
              <Loader2 size={15} className="animate-spin" />
            ) : recording ? (
              <Square size={15} />
            ) : (
              <Mic size={15} />
            )}
            {transcribing ? "Transcribing" : recording ? "Stop" : "Dictate"}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!body.trim() || saving || recording || transcribing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-dark px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-dark/90 disabled:opacity-50"
          >
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
            Save note
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading notes...</p>
      ) : notes.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-3 text-sm text-muted">
          No practice notes yet. Add the first one above.
        </p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="rounded-xl border border-line bg-card px-3.5 py-2.5">
              <p className="whitespace-pre-wrap text-sm text-navy">{n.body}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                {n.source === "voice" ? <Mic size={11} className="shrink-0" aria-label="Dictated" /> : null}
                {n.authorName} · {whenLabel(n.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
