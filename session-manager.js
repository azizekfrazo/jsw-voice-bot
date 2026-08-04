const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const { DeepgramSTT } = require('./deepgram-stt');
const { streamLLM } = require('./gpt4o-llm');
const { chunkForTTS } = require('./sentence-chunker');
const { synthesize } = require('./openai-tts');
const { db, SYSTEM_PROMPT, CHAT_TOOLS } = require('./bot-core');

const GREETING_TEXT =
  "Welcome to JSW Steel — India's largest and most trusted steel manufacturer. " +
  "I'm JSW Assist. Please select your preferred language using the buttons below.";

// ── SESSION MANAGER ──────────────────────────────────────────
// One instance per client WebSocket connection. Orchestrates the three
// parallel streams (Deepgram STT || GPT-4o-mini LLM || OpenAI TTS) behind
// the SAME WebSocket message vocabulary the OpenAI-Realtime-based client
// (public/app.js, public/jsw-demo.html) already speaks — so the frontend
// needs ZERO changes for this migration.
//
// State machine: LISTENING -> CAPTURING -> THINKING -> SPEAKING -> LISTENING
// with a `speech_started`-while-THINKING/SPEAKING edge that always routes
// through an immediate interrupt back to CAPTURING (barge-in).
// See VOICE_PIPELINE_ARCHITECTURE.md for the full design this implements.
class SessionManager {
  constructor(clientWs) {
    this.clientWs = clientWs;
    this.sessionId = uuidv4();
    this.leadId = uuidv4();
    this.startTime = Date.now();

    this.state = 'LISTENING'; // LISTENING | CAPTURING | THINKING | SPEAKING
    this.turnId = 0;          // monotonic fence — see _interrupt()
    this.lead = {};
    this.language = 'english';
    this.languageChosen = false;
    this.systemPrompt = SYSTEM_PROMPT;
    this.transcript = [];
    this.history = [];

    this.llmController = null;
    this.ttsControllers = new Set(); // in-flight TTS AbortControllers (for barge-in)

    db.insertLead(this.leadId, this.sessionId, 'voice');

    this.stt = new DeepgramSTT();
    this._wireSTT();
    this.stt.connect();

    this._log('Browser connected');
    this._sendJSON({ type: 'session.init', sessionId: this.sessionId, leadId: this.leadId });
  }

  _log(...args) {
    console.log(`[${this.sessionId.slice(0, 8)}]`, ...args);
  }

  _sendJSON(obj) {
    if (this.clientWs.readyState === WebSocket.OPEN) this.clientWs.send(JSON.stringify(obj));
  }

  _sendAudioDelta(pcmBuffer) {
    this._sendJSON({ type: 'response.output_audio.delta', delta: pcmBuffer.toString('base64') });
  }

  // ── DEEPGRAM WIRING ────────────────────────────────────────
  _wireSTT() {
    this.stt.on('open', () => {
      this._log('Deepgram connected');
      setTimeout(() => this._speakGreeting(), 400);
    });

    this.stt.on('speechStarted', () => {
      const wasBusy = this.state === 'SPEAKING' || this.state === 'THINKING';
      // Client already stops playback + flushes its audio queue on this
      // exact event (public/app.js / jsw-demo.html 'input_audio_buffer.speech_started'
      // handlers), so send it BEFORE tearing down server-side state.
      this._sendJSON({ type: 'input_audio_buffer.speech_started' });
      if (wasBusy) this._interrupt();
      this.state = 'CAPTURING';
    });

    this.stt.on('final', (text) => {
      if (!text || this.state === 'INTERRUPTED_PENDING') return;

      // Mirrors the old UX exactly: "..." placeholder first, then the real
      // transcript replaces it (client-side logic unchanged).
      this._sendJSON({ type: 'input_audio_buffer.committed' });
      this._sendJSON({ type: 'conversation.item.input_audio_transcription.completed', transcript: text });

      this.transcript.push({ role: 'user', text, ts: new Date().toISOString() });
      db.setTranscript(this.leadId, JSON.stringify(this.transcript));

      this._runTurn(text);
    });

    this.stt.on('error', (e) => {
      this._log('Deepgram error:', e?.message || e);
      this._sendJSON({ type: 'error', message: e?.message || 'ASR error' });
    });

    this.stt.on('close', () => this._log('Deepgram closed'));
  }

  // ── CLIENT -> SERVER MESSAGES ──────────────────────────────
  handleLanguageSelected(lang) {
    const code = lang === 'hi' ? 'hi' : 'en';
    this.language = code === 'hi' ? 'hindi' : 'english';
    this.languageChosen = true;
    const langName = code === 'hi' ? 'Hindi/Hinglish' : 'English';
    this.systemPrompt = `CRITICAL: Respond ONLY in ${langName}. Never switch languages.\n\n${SYSTEM_PROMPT}`;
  }

  pushAudio(base64Chunk) {
    // Deepgram receives audio in EVERY state, including SPEAKING — that's
    // what makes barge-in detection possible without a reconnect.
    this.stt.pushAudio(Buffer.from(base64Chunk, 'base64'));
  }

  // ── GREETING (fixed text, no LLM call needed) ──────────────
  async _speakGreeting() {
    const myTurn = ++this.turnId;
    const pcm = await this._synthesizeGated(GREETING_TEXT, myTurn);
    if (myTurn !== this.turnId) return; // interrupted before it even started
    if (pcm) {
      this.state = 'SPEAKING';
      this._sendAudioDelta(pcm);
    }
    this._sendJSON({ type: 'response.output_audio_transcript.done', transcript: GREETING_TEXT });
    this._sendJSON({ type: 'response.output_audio.done' });
    this.state = 'LISTENING';
  }

  // ── ONE LLM+TTS TURN (tool-calling loop, streamed) ─────────
  async _runTurn(userText) {
    const myTurn = ++this.turnId;
    this.state = 'THINKING';
    this.history.push({ role: 'user', content: userText });
    this.llmController = new AbortController();

    const self = this;
    let assistantText = '';
    let sawFirstAudio = false;

    try {
      for (let iter = 0; iter < 3; iter++) {
        if (myTurn !== this.turnId) return; // superseded by a barge-in

        const messages = [{ role: 'system', content: this.systemPrompt }, ...this.history];
        const toolCalls = [];
        let iterText = '';

        // Adapter: streamLLM() yields both content and tool_call events;
        // the sentence chunker only wants content strings. Tool calls are
        // buffered here and executed once the stream for this iteration ends.
        async function* contentOnly() {
          const raw = streamLLM({ messages, tools: CHAT_TOOLS, signal: self.llmController.signal });
          for await (const evt of raw) {
            if (myTurn !== self.turnId) return;
            if (evt.type === 'content') { iterText += evt.text; yield evt.text; }
            else if (evt.type === 'tool_call') toolCalls.push(evt);
          }
        }

        for await (const sentence of chunkForTTS(contentOnly())) {
          if (myTurn !== this.turnId) return; // interrupted mid-generation

          assistantText += (assistantText ? ' ' : '') + sentence;
          const pcm = await this._synthesizeGated(sentence, myTurn);
          if (myTurn !== this.turnId) return;
          if (pcm) {
            if (!sawFirstAudio) { sawFirstAudio = true; this.state = 'SPEAKING'; }
            this._sendAudioDelta(pcm);
          }
        }

        if (myTurn !== this.turnId) return;

        if (toolCalls.length) {
          this.history.push({
            role: 'assistant',
            content: iterText || null,
            tool_calls: toolCalls.map(tc => ({
              id: tc.id, type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
            }))
          });
          for (const tc of toolCalls) {
            this._handleToolCall(tc);
            this.history.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ success: true }) });
          }
          continue; // loop again — a function-call turn has no speech of its own
        }

        break; // plain text reply, nothing left to do
      }
    } catch (err) {
      if (err.name !== 'AbortError') this._log('Turn error:', err.message);
    }

    if (myTurn !== this.turnId) return; // interrupted — do not finalize stale turn

    this.history.push({ role: 'assistant', content: assistantText });
    if (assistantText.trim()) {
      this.transcript.push({ role: 'assistant', text: assistantText, ts: new Date().toISOString() });
      db.setTranscript(this.leadId, JSON.stringify(this.transcript));
      this._sendJSON({ type: 'response.output_audio_transcript.done', transcript: assistantText });
    }
    this._sendJSON({ type: 'response.output_audio.done' });
    this.state = 'LISTENING';
  }

  _handleToolCall(tc) {
    const { name, arguments: args } = tc;
    if (name === 'capture_lead_info') {
      const clean = Object.fromEntries(
        Object.entries(args || {}).filter(([, v]) => v !== null && v !== undefined && v !== '')
      );
      Object.assign(this.lead, clean);
      db.updateLead(this.leadId, { ...this.lead, language: this.language });
      this._log('Lead:', this.lead.name || '?', '|', this.lead.intent_level || 'low');
    } else if (name === 'show_contact_form') {
      this._sendJSON({ type: 'show_contact_form', leadId: this.leadId });
    } else if (name === 'end_conversation') {
      this._sendJSON({ type: 'end_conversation', leadId: this.leadId });
    }
  }

  // Synthesize one sentence, tracking the AbortController so a barge-in can
  // cancel it mid-flight. Returns null if aborted/errored/superseded.
  async _synthesizeGated(text, myTurn) {
    if (myTurn !== this.turnId) return null;
    const ctrl = new AbortController();
    this.ttsControllers.add(ctrl);
    try {
      const pcm = await synthesize(text, { signal: ctrl.signal });
      return myTurn === this.turnId ? pcm : null;
    } catch (e) {
      if (e.name !== 'AbortError') this._log('TTS error:', e.message);
      return null;
    } finally {
      this.ttsControllers.delete(ctrl);
    }
  }

  // ── BARGE-IN ────────────────────────────────────────────────
  _interrupt() {
    this.turnId++; // fences off every in-flight LLM/TTS callback from this point on
    if (this.llmController) { this.llmController.abort(); this.llmController = null; }
    for (const ctrl of this.ttsControllers) ctrl.abort();
    this.ttsControllers.clear();
  }

  destroy() {
    const secs = Math.round((Date.now() - this.startTime) / 1000);
    this._log(`Browser disconnected (${secs}s)`);
    db.setDuration(this.leadId, secs);
    this.turnId++; // fence off anything still in flight
    if (this.llmController) this.llmController.abort();
    for (const ctrl of this.ttsControllers) ctrl.abort();
    this.stt.close();
  }
}

module.exports = { SessionManager };
