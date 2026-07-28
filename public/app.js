/* ─────────────────────────────────────────────────────────
   JSW Steel Voice Bot — Frontend
   Connects to Node.js WS relay → OpenAI Realtime API
   ───────────────────────────────────────────────────────── */

const seenMessages = new Set();

let ws          = null;
let audioCtx    = null;
let micStream   = null;
let processor   = null;
let isActive    = false;
let isSpeaking  = false;
let currentLead = {};

// Audio playback queue
let audioQueue    = [];
let playbackActive = false;
let nextPlayAt    = 0;
let currentSource = null;
let echoCooldownActive = false;
let userMsgPending = false;

// ─────────────────────────────────────────────
//  TOGGLE
// ─────────────────────────────────────────────
async function toggleConversation() {
  if (isActive) {
    endConversation();
  } else {
    await startConversation();
  }
}

async function startConversation() {
  setStatus('Connecting…', false);
  try {
    await initAudio();
    initWebSocket();
  } catch (err) {
    setStatus('Error: ' + err.message, false);
    console.error(err);
  }
}

function endConversation() {
  seenMessages.clear();
  stopAudio();
  if (ws) { ws.close(); ws = null; }
  isActive = false;
  isSpeaking = false;
  audioQueue = [];
  playbackActive = false;
  setUIIdle();
  setStatus('Ended', false);
}

// ─────────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────────
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/realtime`);

  ws.onopen = () => {
    console.log('[WS] Connected to relay');
    setStatus('Connected – speak now', true);
    setUIListening();
    isActive = true;
  };

  ws.onmessage = (evt) => handleServerEvent(JSON.parse(evt.data));

  ws.onerror = (err) => {
    setStatus('Connection error', false);
    console.error('[WS] Error', err);
  };

  ws.onclose = () => {
    if (isActive) setStatus('Disconnected', false);
    setUIIdle();
    isActive = false;
  };
}

// ─────────────────────────────────────────────
//  HANDLE OPENAI REALTIME EVENTS
// ─────────────────────────────────────────────
function handleServerEvent(ev) {
  if (!['response.output_audio.delta'].includes(ev.type)) {
    console.log('[EVT]', ev.type, ev.transcript || ev.item?.role || ev.delta?.slice?.(0,20) || '');
  }
  switch (ev.type) {

    // Session initialised by our server
    case 'session.init':
      console.log('[Session]', ev.sessionId);
      break;

    // Bot starts producing audio response
    case 'response.output_audio.delta':
      if (ev.delta) {
        enqueueAudio(ev.delta);
        setUISpeaking();
      }
      break;

    // Bot finished this audio response
    case 'response.output_audio.done':
      // Audio queue will drain naturally; reset to listening after
      waitAndSetListening();
      break;

    // User speech → text
    case 'conversation.item.input_audio_transcription.completed':
      if (ev.transcript?.trim()) {
        const box = document.getElementById('transcript');
        const placeholders = box.querySelectorAll('.msg.user');
        const last = placeholders[placeholders.length - 1];
        if (last && last.textContent.includes('...')) {
          last.innerHTML = '<div class="msg-label">YOU</div>' + escHtml(ev.transcript);
          const key = 'user::...';
          seenMessages.delete(key);
          seenMessages.add('user::' + ev.transcript.trim().slice(0, 80));
        } else {
          appendMessage('user', ev.transcript);
        }
      }
      break;

    case 'conversation.item.done':
      if (ev.item?.role === 'user') {
        const content = ev.item?.content;
        console.log('[USER CONTENT FULL]', JSON.stringify(ev.item));
        if (Array.isArray(content)) {
          content.forEach(part => {
            if (part.transcript?.trim()) appendMessage('user', part.transcript);
          });
        }
      }
      break;

    // Bot speech → text
    case 'response.audio_transcript.delta':
      // We use .done for final transcript
      break;

    case 'response.output_audio_transcript.done':
      if (ev.transcript?.trim()) {
        appendMessage('assistant', ev.transcript);
      }
      break;

    // Lead capture function was called
    case 'response.function_call_arguments.done':
      if (ev.name === 'capture_lead_info') {
        try {
          const args = JSON.parse(ev.arguments);
          updateLeadPill(args);
        } catch (_) {}
      }
      break;

    // User started talking (server VAD)
    case 'input_audio_buffer.speech_started':
      // Interrupt bot playback
      audioQueue = [];
      playbackActive = false;
      nextPlayAt = 0;
      if (currentSource) {
        try { currentSource.stop(); } catch(_) {}
        currentSource = null;
      }
      setUIListening();
      userMsgPending = true;
      break;

    case 'input_audio_buffer.speech_stopped':
      console.log('[DEBUG] speech_stopped — user turn ended');
      break;

    case 'input_audio_buffer.committed':
      if (userMsgPending) {
        appendMessage('user', '...');
        userMsgPending = false;
      }
      break;

    case 'show_contact_form':
      console.log('[FORM] triggering contact form, leadId:', ev.leadId);
      showContactForm(ev.leadId);
      break;

    case 'error':
      setStatus('Error: ' + (ev.error?.message || ev.message || 'unknown'), false);
      break;
  }
}

// ─────────────────────────────────────────────
//  AUDIO — MIC CAPTURE
// ─────────────────────────────────────────────
async function initAudio() {
  // Ask mic permission
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 24000
    }
  });

  // Create AudioContext — request 24kHz (hint only; actual rate may differ)
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  const actualRate = audioCtx.sampleRate;
  const TARGET_RATE = 24000;

  const source = audioCtx.createMediaStreamSource(micStream);
  // ScriptProcessor for raw PCM access (reliable for demo; use AudioWorklet in production)
  processor = audioCtx.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (e) => {
    if (!isActive || !ws || ws.readyState !== WebSocket.OPEN) return;

    let float32 = e.inputBuffer.getChannelData(0);

    // Resample if browser did not honour 24kHz request
    if (actualRate !== TARGET_RATE) {
      float32 = resample(float32, actualRate, TARGET_RATE);
    }

    if (isSpeaking) {
      if (echoCooldownActive) return;
      let sum = 0;
      for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
      const rms = Math.sqrt(sum / float32.length);
      if (rms < 0.008) return;
    }

    // Float32 → Int16 PCM
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
    }

    const base64 = arrayBufferToBase64(int16.buffer);
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 }));
  };

  source.connect(processor);
  processor.connect(audioCtx.destination);
}

function stopAudio() {
  if (processor) { processor.disconnect(); processor = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioCtx)  { audioCtx.close(); audioCtx = null; }
}

// ─────────────────────────────────────────────
//  AUDIO — PLAYBACK QUEUE
// ─────────────────────────────────────────────
function enqueueAudio(base64) {
  if (!audioCtx) return;
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const int16  = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

  audioQueue.push(float32);
  if (!playbackActive) drainQueue();
}

function drainQueue() {
  if (!audioCtx || audioQueue.length === 0) { playbackActive = false; return; }
  playbackActive = true;

  // Drain in one merged buffer to avoid gaps
  const total = audioQueue.reduce((s, a) => s + a.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of audioQueue) { merged.set(chunk, offset); offset += chunk.length; }
  audioQueue = [];

  const buf = audioCtx.createBuffer(1, merged.length, 24000);
  buf.getChannelData(0).set(merged);

  currentSource = audioCtx.createBufferSource();
  currentSource.buffer = buf;
  currentSource.connect(audioCtx.destination);
  currentSource.onended = () => { currentSource = null; drainQueue(); };
  currentSource.start(Math.max(audioCtx.currentTime, nextPlayAt));
  nextPlayAt = Math.max(audioCtx.currentTime, nextPlayAt) + buf.duration;
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function resample(input, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const lo  = Math.floor(src);
    const hi  = Math.min(lo + 1, input.length - 1);
    out[i] = input[lo] + (src - lo) * (input[hi] - input[lo]);
  }
  return out;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─────────────────────────────────────────────
//  UI STATE
// ─────────────────────────────────────────────
function setUIIdle() {
  const btn  = document.getElementById('bot-btn');
  const wrap = document.getElementById('bot-btn-wrap');
  const mic  = document.getElementById('icon-mic');
  const stop = document.getElementById('icon-stop');
  const lbl  = document.getElementById('bot-label');
  const endB = document.getElementById('end-btn');
  const wf   = document.getElementById('waveform');

  btn.className  = '';
  wrap.className = 'bot-btn-wrap';
  mic.style.display  = '';
  stop.style.display = 'none';
  lbl.textContent = 'TAP TO TALK';
  endB.style.display = 'none';
  wf.classList.remove('active');
}

function setUIListening() {
  const btn  = document.getElementById('bot-btn');
  const wrap = document.getElementById('bot-btn-wrap');
  const mic  = document.getElementById('icon-mic');
  const stop = document.getElementById('icon-stop');
  const lbl  = document.getElementById('bot-label');
  const endB = document.getElementById('end-btn');
  const wf   = document.getElementById('waveform');

  btn.className  = 'listening';
  wrap.className = 'bot-btn-wrap listening';
  mic.style.display  = '';
  stop.style.display = 'none';
  lbl.textContent = 'LISTENING…';
  endB.style.display = 'block';
  wf.classList.remove('active');
  isSpeaking = false;
}

function setUISpeaking() {
  echoCooldownActive = true;
  setTimeout(() => { echoCooldownActive = false; }, 3500);
  if (isSpeaking) return;
  isSpeaking = true;
  const btn = document.getElementById('bot-btn');
  const wf  = document.getElementById('waveform');
  btn.className = 'speaking';
  wf.classList.add('active');
  document.getElementById('bot-label').textContent = 'SPEAKING…';
  document.getElementById('status-text').textContent = 'Bot is speaking';
}

function waitAndSetListening() {
  setTimeout(() => {
    if (isActive) {
      setUIListening();
      setStatus('Listening…', true);
    }
  }, 600);
}

function setStatus(text, active) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  if (active) dot.classList.add('active');
  else        dot.classList.remove('active');
}

// ─────────────────────────────────────────────
//  TRANSCRIPT
// ─────────────────────────────────────────────
function appendMessage(role, text) {
  const trimmed = text.trim();
  if (!trimmed) return;
  const key = role + '::' + trimmed.slice(0, 80);
  if (seenMessages.has(key)) return;
  seenMessages.add(key);
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.innerHTML = '<div class="msg-label">' + (role === 'user' ? 'YOU' : 'JSW ASSIST') + '</div>' + escHtml(trimmed);
  const box = document.getElementById('transcript');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─────────────────────────────────────────────
//  LEAD PILL
// ─────────────────────────────────────────────
function updateLeadPill(args) {
  Object.assign(currentLead, args);
  const pill = document.getElementById('lead-pill');
  pill.classList.add('visible');

  if (currentLead.name)             document.getElementById('lead-name').textContent    = currentLead.name;
  if (currentLead.product_interest) document.getElementById('lead-product').textContent = currentLead.product_interest;

  const intentEl = document.getElementById('lead-intent');
  if (currentLead.intent_level) {
    intentEl.textContent  = currentLead.intent_level.toUpperCase();
    intentEl.className    = `lead-chip intent-${currentLead.intent_level}`;
  }

  // Language badge
  if (currentLead.language === 'hindi' ||
      (args.intent_reason && /hindi/i.test(args.intent_reason))) {
    document.getElementById('lang-badge').textContent = 'HI';
  }
}

// ─────────────────────────────────────────────
//  CONTACT FORM
// ─────────────────────────────────────────────
function showContactForm(leadId) {
  const overlay = document.getElementById('cf-overlay');
  if (overlay) { overlay.dataset.leadId = leadId || ''; overlay.classList.add('open'); }
}

async function submitContactForm(e) {
  e.preventDefault();
  const overlay = document.getElementById('cf-overlay');
  const leadId  = overlay.dataset.leadId;
  const payload = {
    name:  document.getElementById('cf-name').value,
    phone: document.getElementById('cf-phone').value,
    email: document.getElementById('cf-email').value,
    query: document.getElementById('cf-query').value
  };
  try {
    if (leadId) {
      await fetch('/api/leads/' + leadId + '/form', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
    overlay.classList.remove('open');
    appendMessage('assistant', 'Thank you! Our sales team will call you back shortly.');
  } catch(err) { console.error('Form error:', err); }
}
