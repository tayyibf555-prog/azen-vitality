"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, Square, Loader2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PatientNoteSource } from "@/lib/patient-notes/types";

/**
 * Write a practice note: type it, or dictate it.
 *
 * MOVED, NOT CHANGED. This is the composer from patient-notes-panel.tsx, lifted out
 * so the record's Notes tab owns it and the saving itself belongs to the shared hook
 * (which is what keeps the pinned band above in step with the list below). The voice
 * path is preserved exactly:
 *   - capture happens in the BROWSER via MediaRecorder,
 *   - the audio goes only to our own /api/patient-notes/transcribe and is never
 *     stored anywhere,
 *   - the microphone is released when the panel unmounts mid-recording AND when
 *     recorder setup fails after getUserMedia succeeded,
 *   - with no transcription key configured the endpoint answers an honest 503 and
 *     typing still works, so dictation is never a prerequisite for writing a note.
 */
export function NoteComposer({
  onSave,
  saving,
  disabled,
}: {
  onSave: (body: string, source: PatientNoteSource) => Promise<boolean>;
  saving: boolean;
  disabled?: boolean;
}) {
  const [body, setBody] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<PatientNoteSource>("typed");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Release the mic if the panel closes mid-recording.
  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function save() {
    const text = body.trim();
    if (!text || saving) return;
    setError(null);
    const ok = await onSave(text, sourceRef.current);
    if (ok) {
      setBody("");
      sourceRef.current = "typed";
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
    <div className="rounded-xl border border-line bg-card-muted p-3">
      <textarea
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          if (sourceRef.current === "voice" && !e.target.value.trim()) sourceRef.current = "typed";
        }}
        placeholder="Add a note for this patient. Type, or tap the mic to dictate."
        rows={3}
        aria-label="New note"
        className="w-full resize-y rounded-lg border border-line bg-card px-3 py-2 text-sm text-navy placeholder:text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-dark"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={recording ? stopRecording : startRecording}
          disabled={transcribing || saving || disabled}
          aria-label={recording ? "Stop recording" : "Dictate a note"}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:opacity-50",
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
          disabled={!body.trim() || saving || recording || transcribing || disabled}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-dark px-3.5 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-blue-dark/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/30 disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
          Save note
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
    </div>
  );
}
