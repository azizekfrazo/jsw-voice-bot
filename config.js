require('dotenv').config();

// ── CENTRALIZED CONFIG — STT + LLM + TTS PIPELINE ──────────
// Replaces the OpenAI Realtime API (speech-to-speech) with three
// independently swappable services: Deepgram (STT) + GPT-4o-mini (LLM)
// + OpenAI TTS (REST). See VOICE_PIPELINE_ARCHITECTURE.md for the
// state-machine/barge-in design this config supports.

module.exports = {
  deepgram: {
    apiKey:   process.env.DEEPGRAM_API_KEY,
    model:    process.env.DEEPGRAM_MODEL || 'nova-2',
    language: process.env.DEEPGRAM_LANGUAGE || 'hi-en',
    // Deepgram's live VAD/endpointing — tuned for conversational turns.
    utteranceEndMs: 1000,
    minSpeechMs: 200, // discard shorter bursts as noise, matches old RMS-gate intent
  },

  openai: {
    apiKey:   process.env.OPENAI_API_KEY,
    llmModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    llmMaxTokens: 150,
    ttsModel: process.env.OPENAI_TTS_MODEL || 'tts-1',
    ttsVoice: process.env.OPENAI_TTS_VOICE || 'onyx',
    ttsSampleRate: 24000, // matches existing client playback (public/app.js, jsw-demo.html)
  },

  // Client-side echo/barge-in gating (public/app.js + jsw-demo.html already
  // implement this exact threshold/cooldown — kept here for reference/parity,
  // server-side barge-in itself is driven by Deepgram SpeechStarted).
  bargeIn: {
    rmsThreshold: 0.015,
    cooldownMs: 3500,
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};
