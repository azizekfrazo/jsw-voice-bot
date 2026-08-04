# Migration: OpenAI Realtime API → Deepgram + GPT-4o-mini + OpenAI TTS

Branch `STTToTTS` replaces the OpenAI Realtime API (speech-to-speech) voice
pipeline with three separate streaming services, per the migration spec.
The `SpeechToSpeech` branch is the pre-migration snapshot (Realtime API,
unchanged) if you need to roll back or compare.

## What changed

| File | Status | Purpose |
|---|---|---|
| `config.js` | new | Centralized API keys/model names/timeouts |
| `bot-core.js` | new | Extracted from server.js: `leads.json`/`chats.json` stores, `SYSTEM_PROMPT`/`CHAT_SYSTEM_PROMPT`, tool schemas, non-streaming chat-turn runner (used by `/api/chat`) — shared by both server.js and session-manager.js without a circular require |
| `deepgram-stt.js` | new | Streaming ASR client — connection opened once per session and **never torn down**, including while the bot is speaking (required for barge-in) |
| `gpt4o-llm.js` | new | Streaming `gpt-4o-mini` client; yields `content` tokens and assembled `tool_call` events from a single async generator |
| `sentence-chunker.js` | new | Batches LLM tokens into sentence-boundary chunks for TTS |
| `openai-tts.js` | new | REST client to OpenAI TTS, `response_format: 'pcm'` — returns raw 16-bit PCM at 24kHz, **the exact format the existing client already expects**, so no client-side audio decoding changes were needed |
| `session-manager.js` | new | Per-connection state machine (`LISTENING → CAPTURING → THINKING → SPEAKING`), turnId-fenced barge-in, translates the new pipeline's internal events into the **same WebSocket message vocabulary** the Realtime-API-based client already speaks |
| `server.js` | refactored | `wss.on('connection')` now constructs a `SessionManager` instead of proxying to OpenAI Realtime; REST endpoints (`/api/leads*`, `/api/stats`, `/api/chat`) unchanged, now sourced from `bot-core.js` |

**Frontend: zero changes.** `public/app.js` and `public/jsw-demo.html` still
speak `session.init` / `input_audio_buffer.append` / `language_selected` /
`response.output_audio.delta` / `response.output_audio.done` /
`conversation.item.input_audio_transcription.completed` /
`response.output_audio_transcript.done` / `input_audio_buffer.speech_started`
/ `input_audio_buffer.committed` / `show_contact_form` / `end_conversation` —
`session-manager.js` emits exactly this vocabulary, so the client-side
barge-in handling (stop playback, clear queue, on `speech_started`) works
unmodified against the new backend.

## Setup required before this actually works

1. Add a real `DEEPGRAM_API_KEY` to `.env` (not committed — `.env` is
   gitignored). Without it, `deepgram-stt.js` now fails **gracefully**
   (emits an `error` event to the client, logs it server-side) instead of
   crashing the process — this was a real bug found during testing (see
   below), not a hypothetical.
2. `npm install` — `@deepgram/sdk` and `openai` were added to
   `package.json`/`package-lock.json`.

## What was actually verified (not just written)

- `node -c` syntax-checked on every new/changed file.
- Server starts cleanly, REST endpoints (`/`, `/api/stats`, `/api/leads`,
  `/api/chat`) all confirmed still working after the refactor.
- WebSocket connection: `session.init` fires correctly, a missing/invalid
  Deepgram key now degrades gracefully (relayed as an `error` message)
  instead of taking down the entire server for every other active session
  — **this crash was reproduced and fixed during this migration**, not a
  theoretical risk.
- The LLM → sentence-chunker → TTS chain was exercised end-to-end directly
  (bypassing Deepgram, since no real key is available in this environment):
  confirmed `gpt-4o-mini` streams tokens, `chunkForTTS` correctly yields
  complete sentences, and `openai-tts.js` returns valid raw PCM (byte count
  matches sample-rate × duration exactly, confirming it isn't silently MP3).

## What was NOT verified — needs your validation

- **No real Deepgram key was available in this environment**, so the ASR
  leg (audio in → transcript) and the full barge-in path (Deepgram
  `SpeechStarted` while the bot is mid-sentence) were never exercised
  against live audio. The interrupt logic (`turnId` fencing, TTS/LLM abort)
  is implemented per the architecture doc but only unit-verifiable with a
  live mic + real Deepgram connection.
- **`DEEPGRAM_LANGUAGE=hi-en` is unverified against Deepgram's actual
  supported language/model codes.** Deepgram's code-switching support is
  model- and region-specific (`multi` is the more common value for
  bilingual code-switching, not a hyphenated pair like `hi-en`) — check
  Deepgram's current docs for your account/region before relying on this.
- **TTS latency measured 2.5-4s per sentence in this environment**,
  not the spec's ~200-300ms target. This was tested directly (see above) —
  it's a real measurement, not a guess. This could be network path latency
  specific to this dev environment vs. your production host (DigitalOcean),
  `tts-1` model performance, or missing connection reuse/keep-alive on the
  OpenAI SDK's fetch client. **Re-measure from your actual deployment
  target before trusting the cost/latency tradeoff numbers in the spec
  docs** — if production latency matches what was measured here, E2E
  latency will be several seconds, not the targeted 450-600ms.
- Load testing (10 concurrent users), Hindi/English accuracy, and 5-minute
  connection-stability testing from the spec's test plan were not run —
  they require a live mic and real Deepgram traffic.

## Rollback

`git checkout SpeechToSpeech` gets you back to the unmodified OpenAI
Realtime API version if the new pipeline doesn't meet your latency bar in
production testing.
