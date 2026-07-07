import "server-only";

// Server-side voice-note transcription. Audio is uploaded to OUR backend and
// forwarded to a configured transcription provider, so it never routes through the
// browser to a third party (the reason "server-side" was chosen). The provider is
// OpenAI-Whisper-API-compatible and set entirely by env, so the practice can point
// it at OpenAI, Groq, or any compatible endpoint without a code change:
//   TRANSCRIPTION_API_KEY   required to enable voice (typing works without it)
//   TRANSCRIPTION_BASE_URL  default https://api.openai.com/v1
//   TRANSCRIPTION_MODEL     default whisper-1

export class TranscriptionNotConfiguredError extends Error {
  constructor() {
    super("Voice transcription is not configured");
    this.name = "TranscriptionNotConfiguredError";
  }
}

/** True when a transcription provider key is configured. */
export function transcriptionEnabled(): boolean {
  return Boolean(process.env.TRANSCRIPTION_API_KEY);
}

/** Transcribe a short audio clip to text. Throws TranscriptionNotConfiguredError
 *  when no provider key is set, or a generic Error on a provider failure. */
export async function transcribeAudio(audio: Blob, filename: string): Promise<string> {
  const key = process.env.TRANSCRIPTION_API_KEY;
  if (!key) throw new TranscriptionNotConfiguredError();
  const baseUrl = (process.env.TRANSCRIPTION_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.TRANSCRIPTION_MODEL ?? "whisper-1";

  const form = new FormData();
  form.append("file", audio, filename);
  form.append("model", model);
  form.append("language", "en");
  form.append("response_format", "json");

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`transcription failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
