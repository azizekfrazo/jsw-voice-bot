const OpenAI = require('openai');
const config = require('./config');

const client = new OpenAI({ apiKey: config.openai.apiKey });

// ── OPENAI TTS (REST) CLIENT ─────────────────────────────────
// Stateless HTTP POST per sentence — no connection to manage or pre-warm.
// response_format: 'pcm' returns raw 16-bit signed LE PCM at 24kHz mono,
// which is EXACTLY the format the existing client playback code already
// expects (public/app.js `enqueueAudio`, jsw-demo.html `enqueueWidgetAudio`)
// — so no MP3 decoding and no client-side changes are needed.
//
// `signal` lets session-manager.js abort an in-flight synthesis call the
// instant a barge-in happens, so a stale sentence's audio never gets sent
// to the client after the user has already interrupted.
async function synthesize(text, { signal } = {}) {
  const response = await client.audio.speech.create(
    {
      model: config.openai.ttsModel,
      voice: config.openai.ttsVoice,
      input: text,
      response_format: 'pcm',
    },
    { signal }
  );

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = { synthesize };
