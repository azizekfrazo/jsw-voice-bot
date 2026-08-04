const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');
const { EventEmitter } = require('events');
const config = require('./config');

// ── DEEPGRAM STREAMING ASR CLIENT ───────────────────────────
// Kept open for the ENTIRE session (never torn down between turns) so
// barge-in has zero reconnect latency — this is the single most important
// property of this class. See VOICE_PIPELINE_ARCHITECTURE.md §9.
//
// Events emitted:
//   'open'            — connection ready, safe to start pushing audio
//   'speechStarted'   — Deepgram VAD detected the user starting to talk
//                        (fires in ANY state, including while bot is SPEAKING —
//                        this is what drives barge-in)
//   'interim', text    — low-latency partial transcript (may still change)
//   'final', text      — stable transcript for a completed utterance
//                        (fires on UtteranceEnd / is_final Results)
//   'error', err
//   'close'
class DeepgramSTT extends EventEmitter {
  constructor({ apiKey = config.deepgram.apiKey, model = config.deepgram.model, language = config.deepgram.language } = {}) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.connection = null;
    this._speechStartedAt = null;
    this._finalBuffer = ''; // accumulates is_final Results transcripts until UtteranceEnd
  }

  connect() {
    if (!this.apiKey) {
      // Never throw synchronously here — this runs inside a WebSocket
      // 'connection' handler with no surrounding try/catch, so an
      // uncaught throw would crash the ENTIRE process (all sessions),
      // not just this one. Emit 'error' instead; SessionManager already
      // has its listener attached before connect() is called.
      process.nextTick(() => this.emit('error', new Error('DEEPGRAM_API_KEY is not set')));
      return;
    }

    let client;
    try {
      client = createClient(this.apiKey);
    } catch (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }

    try {
      this.connection = client.listen.live({
        model: this.model,
        language: this.language,
        encoding: 'linear16',
        sample_rate: 24000,
        channels: 1,
        interim_results: true,
        vad_events: true,
        utterance_end_ms: config.deepgram.utteranceEndMs,
        smart_format: true,
        punctuate: true,
        keywords: ['JSW:2', 'TMT:2', 'coil:1', 'galvanized:1'],
      });
    } catch (err) {
      process.nextTick(() => this.emit('error', err));
      return;
    }

    this.connection.on(LiveTranscriptionEvents.Open, () => this.emit('open'));

    this.connection.on(LiveTranscriptionEvents.SpeechStarted, () => {
      this._speechStartedAt = Date.now();
      this.emit('speechStarted');
    });

    this.connection.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data.channel?.alternatives?.[0];
      const text = alt?.transcript;
      if (!text) return;

      if (data.is_final) {
        this._finalBuffer = (this._finalBuffer + ' ' + text).trim();
      } else {
        this.emit('interim', text);
      }
    });

    this.connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      const duration = this._speechStartedAt ? Date.now() - this._speechStartedAt : null;
      this._speechStartedAt = null;

      const finalText = this._finalBuffer.trim();
      this._finalBuffer = '';

      if (!finalText) return; // pure noise burst — nothing transcribed, discard
      if (duration !== null && duration < config.deepgram.minSpeechMs) return; // too short, likely noise

      this.emit('final', finalText);
    });

    this.connection.on(LiveTranscriptionEvents.Error, (err) => this.emit('error', err));
    this.connection.on(LiveTranscriptionEvents.Close, () => this.emit('close'));
  }

  // Feed a raw PCM16 audio chunk (Buffer). Safe to call even before 'open'
  // fires — the SDK queues sends internally until the socket is ready.
  pushAudio(chunk) {
    if (this.connection) this.connection.send(chunk);
  }

  // Force any transcript sitting in Deepgram's buffer to flush immediately
  // (e.g. right before we're about to tear down the connection).
  finalize() {
    if (this.connection) this.connection.finalize();
  }

  close() {
    if (this.connection) {
      this.connection.requestClose();
      this.connection = null;
    }
  }
}

module.exports = { DeepgramSTT };
