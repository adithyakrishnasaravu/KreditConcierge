const baseUrl = process.env.HATHORA_BASE_URL || "https://api.hathora.dev/v1";
const chainUrl = process.env.HATHORA_CHAIN_URL || "";

function requireApiKey() {
  const key = process.env.HATHORA_API_KEY;
  if (!key) throw new Error("Missing HATHORA_API_KEY");
  return key;
}

function maybeAuthHeaders() {
  const key = process.env.HATHORA_API_KEY;
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

export async function transcribeAudio({ audioBase64, mimeType = "audio/wav" }) {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) throw new Error("Missing OPENAI_API_KEY");

  console.log("[STT] Starting transcription via OpenAI Whisper...");
  console.log("[STT]   MIME type:", mimeType);
  console.log("[STT]   Audio size:", audioBase64 ? `${(audioBase64.length * 0.75 / 1024).toFixed(1)} KB` : "MISSING");

  if (!audioBase64) {
    throw new Error("audioBase64 is empty — no audio data received");
  }

  // Convert base64 to a Blob for multipart upload
  const audioBuffer = Buffer.from(audioBase64, "base64");
  const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("mp4") ? "mp4" : "wav";
  const audioBlob = new Blob([audioBuffer], { type: mimeType });

  const form = new FormData();
  form.append("file", audioBlob, `recording.${ext}`);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openaiKey}`
    },
    body: form
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`[STT] FAILED (${res.status}):`, text);
    throw new Error(`OpenAI Whisper failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  console.log("[STT] Success. Transcript:", json.text?.slice(0, 200));
  return json;
}

export async function synthesizeSpeech({ text, voice = "alloy" }) {
  const apiKey = requireApiKey();
  const model = process.env.HATHORA_TTS_MODEL || "elevenlabs:multilingual-v2";

  const res = await fetch(`${baseUrl}/text-to-speech`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: text,
      voice
    })
  });

  if (!res.ok) {
    const textBody = await res.text();
    throw new Error(`Hathora TTS failed (${res.status}): ${textBody}`);
  }

  return res.json();
}

export async function processVoiceChain({
  audioBase64,
  mimeType = "audio/wav",
  sessionId,
  enableConversationHistory = true
}) {
  if (!chainUrl) {
    throw new Error("Missing HATHORA_CHAIN_URL");
  }

  if (!audioBase64) {
    throw new Error("Missing audioBase64");
  }

  const sttModel = process.env.HATHORA_STT_MODEL || "parakeet";
  const llmModel = process.env.HATHORA_LLM_MODEL || "qwen3";
  const ttsModel = process.env.HATHORA_TTS_MODEL || "kokoro";
  const resolvedSessionId = sessionId || `session-${Date.now()}`;

  const audioBuffer = Buffer.from(audioBase64, "base64");
  const audioBlob = new Blob([audioBuffer], { type: mimeType });

  const config = {
    enableConversationHistory,
    sessionId: resolvedSessionId,
    stt: { model: sttModel },
    llm: { model: llmModel, stream: true },
    tts: { model: ttsModel }
  };

  const form = new FormData();
  form.append("file", audioBlob, "input.wav");
  form.append("config", JSON.stringify(config));

  const res = await fetch(chainUrl, {
    method: "POST",
    headers: {
      ...maybeAuthHeaders()
    },
    body: form
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Hathora chain failed (${res.status}): ${errorText}`);
  }

  const contentType = res.headers.get("content-type") || "audio/wav";
  const outputBuffer = Buffer.from(await res.arrayBuffer());

  return {
    sessionId: resolvedSessionId,
    mimeType: contentType,
    audioBase64: outputBuffer.toString("base64")
  };
}
