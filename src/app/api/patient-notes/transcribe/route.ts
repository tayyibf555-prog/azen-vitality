import { requireUser, requireModuleApiAccess } from "@/lib/auth/guard";
import { requireCapability } from "@/lib/auth/capability-guard";
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

  // THE SAME MODULE LOCK ITS PARENT CARRIES. This route dictates INTO the patient
  // record, so it belongs to the "patients" module exactly as /api/patient-notes
  // does — but it shipped with `requireUser` alone, which means every signed-in
  // role could reach it. That was a gap on two counts: it is a paid third-party
  // call any session could spend, and it is a patient-record surface. Closing it
  // is part of adding the fifth role rather than a change of its own.
  //
  // NO CLIENT OR SITE CHECK, deliberately and not by omission: the endpoint takes
  // no client, no site and no patient. It receives an audio blob, returns text, and
  // touches no practice data, so there is no tenancy to scope. If a future version
  // ever attaches the transcript to a patient, it gains the full
  // requireClientAccess -> requireSiteAccess -> patientBelongsToSite chain first.
  const moduleDenied = requireModuleApiAccess(auth, "patients");
  if (moduleDenied) return moduleDenied;
  // THE SAME KEY AS ITS PARENT. Dictation is note-writing with a microphone, and
  // it also spends money on a third-party transcription call, so it must not be
  // reachable by somebody whose note-writing has been switched off.
  const capabilityDenied = await requireCapability(auth, "patient.note.write");
  if (capabilityDenied) return capabilityDenied;

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
