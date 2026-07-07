import { requireUser } from "@/lib/auth/guard";
import {
  transcribeAudio,
  transcriptionEnabled,
  TranscriptionNotConfiguredError,
} from "@/lib/transcription/transcribe";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB, matches common provider limits

// POST /api/patient-notes/transcribe  (multipart form, field 'audio')
// Transcribes a dictated voice note server-side and returns the text for the
// composer. Auth-gated; returns 503 (not an error) when no provider is configured
// so the UI can tell the user voice is not switched on yet.
export async function POST(request: Request): Promise<Response> {
  const auth = await requireUser();
  if (auth instanceof Response) return auth;

  if (!transcriptionEnabled()) {
    return Response.json(
      { ok: false, error: "Voice transcription is not switched on yet. Ask your admin to add a transcription key." },
      { status: 503 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ ok: false, error: "expected an audio upload" }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof Blob) || audio.size === 0) {
    return Response.json({ ok: false, error: "no audio provided" }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ ok: false, error: "recording is too long" }, { status: 413 });
  }

  const filename = audio instanceof File && audio.name ? audio.name : "note.webm";
  try {
    const text = await transcribeAudio(audio, filename);
    return Response.json({ ok: true, text });
  } catch (e) {
    if (e instanceof TranscriptionNotConfiguredError) {
      return Response.json({ ok: false, error: "Voice transcription is not switched on yet." }, { status: 503 });
    }
    return Response.json({ ok: false, error: "could not transcribe the recording" }, { status: 502 });
  }
}
