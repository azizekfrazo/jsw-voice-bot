# Real-Time Speech-to-Speech Voice Bot — Pipeline Architecture

Provider-agnostic architecture and code scaffolding for a low-latency,
full-duplex conversational voice pipeline: audio in → VAD/endpointing →
streaming ASR → streaming LLM → streaming TTS → audio out, with barge-in
(interruption) handling.

Scaffolding is in **Node.js** (`async`/`await`, `EventEmitter`, async
generators) since it maps directly onto WebSocket-based voice servers, but
every component is described as a swappable interface — plug in Deepgram,
Whisper, ElevenLabs, Claude, GPT-4o, etc. behind the same shape.

---

## 1. State Machine

The bot session is always in exactly one state. Every transition is driven
by an event from one of the pipeline stages, never by a timer alone (timers
are only used as *fallback/timeout* guards).

```
                    ┌─────────────────────────────────────────────┐
                    │                                               │
                    ▼                                               │
              ┌───────────┐   speech_started    ┌───────────┐        │
   start ───▶ │ LISTENING │ ───────────────────▶│ CAPTURING │        │
              └───────────┘                     └─────┬─────┘        │
                    ▲                                  │             │
                    │                          speech_stopped        │
                    │ response.done /                   ▼             │
                    │ tts_playback_done          ┌───────────┐        │
                    │                            │ THINKING  │        │
                    │                            │ (ASR final│        │
                    │                            │ → LLM)    │        │
                    │                            └─────┬─────┘        │
                    │                                  │ first token   │
                    │                                  ▼               │
                    │                            ┌───────────┐        │
                    └────────────────────────────│ SPEAKING  │        │
                                                  │ (TTS →    │        │
                            barge-in detected     │  audio)   │        │
                            (speech_started       └─────┬─────┘        │
                             while SPEAKING)             │             │
                                  │                       │             │
                                  ▼                       │             │
                            ┌─────────────┐               │             │
                            │ INTERRUPTED │───────────────┘             │
                            │ (flush all, │  → back to CAPTURING ───────┘
                            │  reset ctx) │     immediately
                            └─────────────┘
```

| State         | Mic → server audio flowing? | LLM active? | TTS/audio playing? | Exit condition |
|---------------|:---:|:---:|:---:|---|
| `LISTENING`   | ✅ (buffered, pre-roll)        | ❌ | ❌ | VAD fires `speech_started` |
| `CAPTURING`   | ✅ (streamed to ASR)           | ❌ | ❌ | VAD fires `speech_stopped` (endpoint) |
| `THINKING`    | ✅ (still open, for barge-in)  | ✅ | ❌ | LLM emits first token |
| `SPEAKING`    | ✅ (open, monitored for barge-in) | ✅ (streaming) | ✅ | TTS+playback fully drained |
| `INTERRUPTED` | ✅ | 🛑 cancelled | 🛑 flushed | immediately → `CAPTURING` |

Key invariant: **the mic is never closed** while the bot is speaking — that's
what makes barge-in possible. What changes between states is *what the
server does* with the incoming audio (ignore / VAD-monitor-only / full ASR).

---

## 2. High-Level Architecture

```
┌────────────┐   audio chunks (binary WS frames / WebRTC track)
│  Client    │ ───────────────────────────────────────────────┐
│ (mic + spk)│                                                 │
└─────┬──────┘                                                 ▼
      │ ▲                                          ┌──────────────────────┐
      │ │ TTS audio chunks                          │   Session Manager     │
      │ │ (binary WS frames)                        │  (per-connection      │
      │ └────────────────────────────────────────────  state machine +     │
      │                                              │   turn controller)   │
      │                                              └───┬────────┬────────┘
      │                                                   │        │
      │                                     ┌─────────────┘        └─────────────┐
      │                                     ▼                                    ▼
      │                          ┌─────────────────────┐               ┌──────────────────┐
      │                          │  VAD / Endpointing   │               │   Barge-in Guard  │
      │                          │  (frame energy or    │               │  (always listening│
      │                          │   ML VAD e.g. Silero) │               │   even in SPEAKING)│
      │                          └──────────┬────────────┘               └─────────┬────────┘
      │                                     │ speech_started / speech_stopped       │ speech_started while SPEAKING
      │                                     ▼                                       ▼
      │                          ┌─────────────────────┐                 cancel LLM + flush TTS
      │                          │   Streaming ASR       │                 + clear audio queue
      │                          │ (Deepgram/Whisper/... )│
      │                          └──────────┬────────────┘
      │                                     │ partial + final transcript
      │                                     ▼
      │                          ┌─────────────────────┐
      │                          │   LLM (streaming)     │
      │                          │ (GPT-4o / Claude 3.5)  │
      │                          └──────────┬────────────┘
      │                                     │ token stream → sentence chunker
      │                                     ▼
      │                          ┌─────────────────────┐
      └──────────────────────────│  Streaming TTS         │
        audio chunks             │ (ElevenLabs/PlayHT/...) │
                                 └─────────────────────┘
```

---

## 3. Audio Input & Streaming

Client sends fixed-size PCM16 frames (e.g. 20-40ms @ 16-24kHz mono) over a
WebSocket. Never buffer the whole utterance before processing — every stage
downstream must accept a chunk at a time.

```js
// audio-input.js
const WebSocket = require('ws');
const { SessionManager } = require('./session-manager');

const wss = new WebSocket.Server({ port: 8080 });

wss.on('connection', (clientWs) => {
  const session = new SessionManager({
    onOutboundAudio: (chunk) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(chunk); // binary frame out
    },
    onEvent: (evt) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(evt)); // JSON control frame
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (isBinary) {
      session.pushAudioFrame(data); // Buffer — raw PCM16 chunk
    } else {
      session.handleControlMessage(JSON.parse(data.toString()));
    }
  });

  clientWs.on('close', () => session.destroy());
});
```

Design notes:
- Binary frames = audio; text frames = control/events. Keeps the protocol
  simple without a second connection.
- `pushAudioFrame` must be **non-blocking** — it hands the chunk to the VAD
  and (conditionally) the ASR client, then returns immediately. Never
  `await` a full round trip inside the frame handler.

---

## 4. Voice Activity Detection (VAD) & Endpointing

Two jobs, often conflated but worth separating:

1. **Turn-taking VAD** — detects `speech_started` / `speech_stopped` to
   drive the state machine (when did the user start/stop talking).
2. **Endpointing** — decides *how long a pause* means "the user is actually
   done," vs. a mid-sentence breath. This is the hardest tuning knob in the
   whole system — too short = cuts users off, too long = bot feels slow.

```js
// vad.js
// Provider-agnostic: swap in Silero VAD (ONNX), WebRTC VAD, or the ASR
// vendor's built-in VAD (e.g. Deepgram's endpointing, OpenAI Realtime's
// `turn_detection: { type: 'semantic_vad' }`).
class VoiceActivityDetector {
  constructor({ onSpeechStart, onSpeechStop, silenceMs = 500, minSpeechMs = 200 }) {
    this.onSpeechStart = onSpeechStart;
    this.onSpeechStop  = onSpeechStop;
    this.silenceMs     = silenceMs;   // pause length that ends a turn
    this.minSpeechMs    = minSpeechMs; // ignore blips shorter than this
    this.speaking       = false;
    this.speechStartedAt = null;
    this.lastVoiceAt    = null;
    this.silenceTimer   = null;
  }

  // Call this for every incoming audio frame.
  processFrame(frame) {
    const isVoice = this._frameHasEnergy(frame); // or ML VAD score > threshold

    if (isVoice) {
      if (!this.speaking) {
        this.speaking = true;
        this.speechStartedAt = Date.now();
        this.onSpeechStart();
      }
      this.lastVoiceAt = Date.now();
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this._maybeEndTurn(), this.silenceMs);
    }
  }

  _maybeEndTurn() {
    if (!this.speaking) return;
    const duration = Date.now() - this.speechStartedAt;
    this.speaking = false;
    if (duration < this.minSpeechMs) return; // noise burst — discard, no turn end
    this.onSpeechStop();
  }

  _frameHasEnergy(frame) {
    // Cheap RMS-based fallback VAD (replace with Silero/WebRTC VAD for prod)
    const int16 = new Int16Array(frame.buffer, frame.byteOffset, frame.length / 2);
    let sum = 0;
    for (let i = 0; i < int16.length; i++) sum += int16[i] * int16[i];
    const rms = Math.sqrt(sum / int16.length) / 32768;
    return rms > 0.02;
  }
}

module.exports = { VoiceActivityDetector };
```

Production notes:
- Prefer an ML VAD (Silero VAD via ONNX runtime, or WebRTC's VAD) over raw
  energy thresholds — energy VAD false-triggers on background noise/AC hum.
- If your ASR/Realtime vendor has built-in server-side VAD (Deepgram
  endpointing, OpenAI Realtime `semantic_vad`), prefer that over rolling
  your own — it's tuned on real conversational data and saves a full
  pipeline stage.
- Discard turns shorter than `minSpeechMs` — this is the #1 fix for
  "the bot responds to a cough."

---

## 5. Speech-to-Text (ASR) — Streaming

Feed frames continuously; consume **interim** transcripts for UI/echo
cancellation cues, and the **final** transcript per turn to hand off to the
LLM. Model every ASR vendor behind the same async-iterator interface so you
can swap Deepgram ↔ Whisper streaming ↔ Google STT without touching the rest
of the pipeline.

```js
// asr-client.js
// Interface every ASR adapter implements:
//   start()                          -> begins a streaming session
//   pushAudio(chunk)                 -> feed a PCM16 frame
//   on('partial', text => {})        -> low-latency, may change
//   on('final', text => {})          -> stable, turn-ending transcript
//   stop()                           -> end + flush

const { EventEmitter } = require('events');
const WebSocket = require('ws');

class DeepgramASR extends EventEmitter {
  constructor({ apiKey, sampleRate = 16000 }) {
    super();
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.ws = null;
  }

  start() {
    this.ws = new WebSocket(
      `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=${this.sampleRate}` +
      `&interim_results=true&endpointing=300&punctuate=true`,
      { headers: { Authorization: `Token ${this.apiKey}` } }
    );

    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const alt = msg.channel?.alternatives?.[0];
      if (!alt?.transcript) return;
      this.emit(msg.is_final ? 'final' : 'partial', alt.transcript);
    });

    this.ws.on('error', (e) => this.emit('error', e));
  }

  pushAudio(chunk) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk);
  }

  stop() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      this.ws.close();
    }
  }
}

module.exports = { DeepgramASR };
```

Latency technique: don't wait for VAD `speech_stopped` before starting ASR —
ASR should already be streaming from the moment `speech_started` fires, so
the *final* transcript is available almost instantly once the endpoint is
detected (no cold-start delay on the ASR connection itself).

---

## 6. LLM Processing — Streaming with Sentence Chunking

The critical latency move: **do not wait for the full LLM response** before
starting TTS. Stream LLM tokens, buffer only until you have a
TTS-synthesizable unit (a clause or sentence), then flush that unit to TTS
immediately and keep accumulating the next one in parallel.

```js
// llm-stream.js
async function* streamLLMResponse({ client, model, messages }) {
  const stream = await client.chat.completions.create({
    model, messages, stream: true
  });

  for await (const part of stream) {
    const delta = part.choices?.[0]?.delta?.content;
    if (delta) yield delta;
  }
}

// Groups raw token deltas into TTS-ready chunks at sentence/clause
// boundaries, so TTS can start on chunk 1 while the LLM is still
// generating chunk 4.
async function* chunkForTTS(tokenStream) {
  let buffer = '';
  const BOUNDARY = /([.!?।](?:\s|$))/; // include Hindi danda (।) for bilingual bots

  for await (const token of tokenStream) {
    buffer += token;
    const match = buffer.match(BOUNDARY);
    if (match) {
      const splitAt = match.index + match[0].length;
      yield buffer.slice(0, splitAt).trim();
      buffer = buffer.slice(splitAt);
    } else if (buffer.length > 120) {
      // Safety valve: don't let one giant run-on clause block TTS forever
      const lastSpace = buffer.lastIndexOf(' ', 100);
      const cut = lastSpace > 0 ? lastSpace : buffer.length;
      yield buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut);
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

module.exports = { streamLLMResponse, chunkForTTS };
```

Time-To-First-Byte (TTFB) techniques:
- Use the smallest model that meets quality bar for this domain (e.g.
  GPT-4o-mini/Haiku-class) — model size is often the single biggest lever
  on TTFB, bigger than network/infra tuning.
- Keep the system prompt + tool schema small and cached (prompt caching on
  Claude/GPT-4o) — a 3000-token static system prompt re-processed every
  turn is pure wasted latency.
- Start TTS on the *first* sentence chunk, don't wait for `stream.done`.
- Speculative execution: begin warming up the TTS websocket connection the
  moment `speech_stopped` fires (in parallel with the LLM call), so the TTS
  connection handshake isn't on the critical path.

---

## 7. Text-to-Speech (TTS) — Streaming

Each chunk from `chunkForTTS` is sent to the TTS engine as soon as it's
ready; the TTS engine streams back audio chunks which are forwarded to the
client immediately (don't buffer a whole sentence's audio before sending).

```js
// tts-client.js
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class ElevenLabsTTS extends EventEmitter {
  constructor({ apiKey, voiceId, sampleRate = 24000 }) {
    super();
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.sampleRate = sampleRate;
    this.ws = null;
  }

  connect() {
    this.ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}/stream-input?output_format=pcm_${this.sampleRate}`,
      { headers: { 'xi-api-key': this.apiKey } }
    );
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8 } }));
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.audio) this.emit('audio', Buffer.from(msg.audio, 'base64'));
      if (msg.isFinal) this.emit('utteranceEnd');
    });
  }

  // Call once per chunk yielded by chunkForTTS()
  sendText(textChunk) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: textChunk + ' ' }));
    }
  }

  flushAndClose() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ text: '' })); // signals end-of-input to some vendors
      this.ws.close();
    }
  }

  // BARGE-IN: hard-stop mid-utterance, no graceful flush
  abort() {
    if (this.ws) { try { this.ws.terminate(); } catch (_) {} this.ws = null; }
  }
}

module.exports = { ElevenLabsTTS };
```

Note `abort()` vs `flushAndClose()` — this distinction is what makes clean
barge-in possible (see §9).

---

## 8. Audio Output

Audio chunks arriving from TTS are forwarded to the client as binary frames
the moment they arrive — no server-side buffering/re-assembly. The
*client* is responsible for jitter-buffering and gapless playback
(Web Audio API `AudioBufferSourceNode` scheduling, see below).

```js
// In SessionManager, wired to TTS 'audio' events:
tts.on('audio', (pcmChunk) => {
  if (this.state !== 'SPEAKING') return; // dropped: we've moved on (e.g. barge-in raced this chunk)
  this.onOutboundAudio(pcmChunk);
});
```

Client-side gapless scheduling (Web Audio API):

```js
// client-playback.js
let nextPlayAt = 0;
function enqueueAndPlay(audioCtx, pcmFloat32) {
  const buf = audioCtx.createBuffer(1, pcmFloat32.length, 24000);
  buf.getChannelData(0).set(pcmFloat32);
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(audioCtx.destination);
  const startAt = Math.max(audioCtx.currentTime, nextPlayAt);
  src.start(startAt);
  nextPlayAt = startAt + buf.duration;
  return src; // keep a handle — needed to hard-stop on barge-in
}
```

---

## 9. Barge-in / Interruption Handling (CRITICAL)

This is the part that makes or breaks how "natural" the bot feels. The
mechanism has to work regardless of *where* in the pipeline the bot
currently is (still generating LLM tokens, mid-TTS, or mid-playback).

### The rule

> The moment VAD detects `speech_started` **while state === SPEAKING (or
> THINKING)**, everything downstream of that instant is void: cancel the
> LLM stream, kill the TTS connection, wipe the client's audio queue, and
> transition straight to `CAPTURING` — the interrupting speech IS the start
> of the next turn, don't discard it.

### Server-side scaffolding

```js
// session-manager.js
class SessionManager {
  constructor({ onOutboundAudio, onEvent }) {
    this.onOutboundAudio = onOutboundAudio;
    this.onEvent = onEvent;
    this.state = 'LISTENING';

    this.vad = new VoiceActivityDetector({
      onSpeechStart: () => this._handleSpeechStart(),
      onSpeechStop:  () => this._handleSpeechStop(),
    });

    this.asr = new DeepgramASR({ apiKey: process.env.DEEPGRAM_API_KEY });
    this.asr.start();
    this.asr.on('final', (text) => this._handleFinalTranscript(text));

    this.currentLLMController = null; // AbortController for the in-flight LLM stream
    this.currentTTS = null;           // active TTS client, if any
    this.turnId = 0;                  // monotonic — used to fence stale async work
  }

  pushAudioFrame(frame) {
    this.vad.processFrame(frame);       // ALWAYS runs, in every state
    if (this.state === 'CAPTURING' || this.state === 'THINKING' || this.state === 'SPEAKING') {
      this.asr.pushAudio(frame);        // ASR stays open even while bot talks, for barge-in transcript
    }
  }

  _handleSpeechStart() {
    if (this.state === 'SPEAKING' || this.state === 'THINKING') {
      this._interrupt(); // barge-in path
    }
    this.state = 'CAPTURING';
    this.onEvent({ type: 'state', state: this.state });
  }

  _handleSpeechStop() {
    if (this.state !== 'CAPTURING') return;
    this.state = 'THINKING';
    this.onEvent({ type: 'state', state: this.state });
    // ASR 'final' event (already streaming) will fire shortly and drive the LLM call.
  }

  async _handleFinalTranscript(text) {
    const myTurn = ++this.turnId;
    this.currentLLMController = new AbortController();

    try {
      const tokenStream = streamLLMResponse({
        client: llmClient, model: 'gpt-4o-mini',
        messages: this._buildMessages(text),
        signal: this.currentLLMController.signal,
      });

      this.currentTTS = new ElevenLabsTTS({ apiKey: process.env.ELEVENLABS_API_KEY, voiceId: 'xyz' });
      this.currentTTS.connect();
      this.currentTTS.on('audio', (chunk) => {
        if (myTurn !== this.turnId) return; // stale — a barge-in already happened
        if (this.state !== 'SPEAKING') this.state = 'SPEAKING';
        this.onOutboundAudio(chunk);
      });

      for await (const sentenceChunk of chunkForTTS(tokenStream)) {
        if (myTurn !== this.turnId) break; // interrupted mid-generation — stop pulling tokens
        this.currentTTS.sendText(sentenceChunk);
      }
      if (myTurn === this.turnId) this.currentTTS.flushAndClose();
    } catch (err) {
      if (err.name !== 'AbortError') this.onEvent({ type: 'error', message: err.message });
    }
  }

  // ── BARGE-IN ─────────────────────────────────────────────
  _interrupt() {
    this.turnId++; // fences off any in-flight LLM/TTS callbacks from this point on

    // 1. Cancel LLM generation immediately (stop paying for/streaming tokens nobody will hear)
    this.currentLLMController?.abort();
    this.currentLLMController = null;

    // 2. Hard-kill TTS — do NOT gracefully flush, that would keep speaking
    this.currentTTS?.abort();
    this.currentTTS = null;

    // 3. Tell the client to flush its audio playback queue + stop any scheduled buffers
    this.onEvent({ type: 'barge_in' }); // client stops AudioBufferSourceNodes, clears queue

    this.onEvent({ type: 'state', state: 'INTERRUPTED' });
    // State machine then immediately moves to CAPTURING in _handleSpeechStart's caller
  }

  destroy() {
    this.asr.stop();
    this.currentLLMController?.abort();
    this.currentTTS?.abort();
  }
}

module.exports = { SessionManager };
```

### Client-side flush on `barge_in`

```js
// On receiving { type: 'barge_in' } control message:
function handleBargeIn() {
  audioQueue = [];
  if (currentSource) {
    try { currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  nextPlayAt = 0; // reset scheduling clock — next chunk plays immediately, not queued after stale audio
}
```

### Why the `turnId` fence matters

Async LLM/TTS work in flight when an interrupt happens doesn't stop
instantaneously — `abort()` calls are best-effort and a few in-flight
promises/callbacks can still resolve afterward. Every callback checks
`myTurn !== this.turnId` before doing anything user-visible (sending audio,
appending transcript) so **stale work from a cancelled turn can never leak
into the new turn** — this is the guard that prevents "the bot talks over
itself" bugs where a race condition lets old audio through after barge-in.

---

## 10. Latency Reduction Checklist

| Technique | Saves | Where |
|---|---|---|
| Stream ASR from `speech_started`, not after `speech_stopped` | ASR cold-start latency | §5 |
| Chunk LLM output at sentence/clause boundaries for TTS | Full-response wait → first-sentence wait | §6 |
| Pre-warm TTS websocket during LLM call | TTS connection handshake (~100-300ms) | §6/§7 |
| Use smallest model that meets quality bar | Model inference time (often the biggest single factor) | §6 |
| Cache/pin static system prompt + tool schema | Prompt re-tokenization cost per turn | §6 |
| PCM16 raw audio over WS (no re-encoding to MP3/Opus mid-pipeline) | Encode/decode CPU + latency | §1/§8 |
| Client-side jitter buffer + gapless scheduling (`AudioBufferSourceNode` chaining) | Playback stutter, not RTT, but perceived quality | §8 |
| `turnId` fencing instead of `await`-blocking cancellation | Correctness under interruption, not raw speed | §9 |
| Keep mic ASR open during `SPEAKING` (never a full teardown/rebuild per turn) | ASR reconnect latency on every turn | §9 |
| Discard sub-`minSpeechMs` VAD blips before they reach ASR/LLM | Wasted round-trips on noise | §4 |

---

## 11. Summary

- **State machine**: `LISTENING → CAPTURING → THINKING → SPEAKING`, with a
  `speech_started`-while-`SPEAKING`/`THINKING` edge that always routes
  through `INTERRUPTED → CAPTURING`.
- **Everything streams**: audio in, ASR transcript, LLM tokens, TTS audio,
  audio out — no stage waits for a complete upstream artifact before
  starting its own work.
- **Barge-in is a first-class state transition**, not an edge-case patch:
  the mic/ASR are never closed while the bot talks, and a monotonic
  `turnId` fences every async callback so cancelled work can never emit
  audio or mutate state after the fact.
