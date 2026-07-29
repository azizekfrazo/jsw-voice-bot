require('dotenv').config();
const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const cors     = require('cors');
const { JSW_KNOWLEDGE_BASE } = require('./knowledge');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
const server = http.createServer(app);

// ── ZERO-DEPENDENCY JSON FILE DATABASE ──────────────────
// No native compilation needed — works on Windows, Mac, Linux
// Data is stored in leads.json next to server.js
const DB_FILE = path.join(__dirname, 'leads.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
  return { leads: [] };
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

const db = {
  insertLead(id, sessionId) {
    const data = loadDB();
    data.leads.push({
      id, session_id: sessionId,
      name: null, company: null, phone: null, email: null,
      product_interest: null, project_type: null,
      quantity_mt: null, timeline: null,
      intent_level: 'low', intent_reason: null,
      transcript: '[]', language: 'english',
      duration_secs: 0,
      contact_form_submitted: false,
      contact_form_query: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    saveDB(data);
  },

  updateLead(id, fields) {
    const data = loadDB();
    const lead = data.leads.find(l => l.id === id);
    if (!lead) return;
    for (const [k, v] of Object.entries(fields)) {
      if (v !== null && v !== undefined && v !== '') lead[k] = v;
    }
    lead.updated_at = new Date().toISOString();
    saveDB(data);
  },

  setTranscript(id, json) {
    const data = loadDB();
    const lead = data.leads.find(l => l.id === id);
    if (lead) { lead.transcript = json; lead.updated_at = new Date().toISOString(); saveDB(data); }
  },

  setDuration(id, secs) {
    const data = loadDB();
    const lead = data.leads.find(l => l.id === id);
    if (lead) { lead.duration_secs = secs; lead.updated_at = new Date().toISOString(); saveDB(data); }
  },

  getLeads(intentFilter) {
    let leads = [...loadDB().leads].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    if (intentFilter && intentFilter !== 'all') leads = leads.filter(l => l.intent_level === intentFilter);
    return leads.map(l => ({ ...l, transcript: JSON.parse(l.transcript || '[]') }));
  },

  getLead(id) {
    const lead = loadDB().leads.find(l => l.id === id);
    if (!lead) return null;
    return { ...lead, transcript: JSON.parse(lead.transcript || '[]') };
  },

  getStats() {
    const leads = loadDB().leads;
    return {
      total: leads.length,
      high: leads.filter(l => l.intent_level === 'high').length,
      medium: leads.filter(l => l.intent_level === 'medium').length,
      low: leads.filter(l => l.intent_level === 'low').length,
      qualified: leads.filter(l => l.name !== null).length
    };
  }
};

// ── SYSTEM PROMPT ────────────────────────────────────────
const SYSTEM_PROMPT = `IMPORTANT: Never repeat the welcome greeting. It was already said at the start. Jump straight to where the conversation left off.

You are a JSW Steel customer support agent.
Your ONLY job is helping people buy or learn about JSW Steel products.

== RESPONSE LENGTH — MOST IMPORTANT RULE ==
Maximum 2 short sentences. Never more. Count your sentences before replying.
If you are about to say a third sentence, STOP and delete it.
This is a voice call. Long answers are rude.

== YOU ARE A JSW STEEL EMPLOYEE ==
- You only know about JSW Steel. You have no knowledge of any other company or topic.
- When someone says "sales team" or "sales rep" they mean JSW Steel's team. Always.
- Never ask "which company". Never say you cannot connect. Just call show_contact_form.

== LANGUAGE ==
The user's language preference has already been selected via a button before
this conversation started. The session is already configured for the correct
language. Simply respond in whatever language the instructions at the top specify.
Never ask about language. Never switch languages.

== HARD REFUSAL — say this exact line ==
"I only help with JSW Steel products. What steel requirement can I assist with?"
Use for: general knowledge, competitors, off-topic questions, anything not about buying steel.

== CALL show_contact_form IMMEDIATELY — no follow-up questions first ==
Triggers: pricing question, quote request, bulk order, "sales team", "human", "connect me",
          complex requirement, anything you are not 100% sure about.
After calling it say only:
- If English locked: "A form appeared — fill it and our team calls you back."
- If Hindi locked: "Form aa gaya — fill karein, hamari team call karegi."

== QUALIFICATION — ask ONE per turn in the user's chosen language ==

If English was chosen, use ONLY these:
- "Which JSW product are you looking for?"
- "What quantity do you need — rough is fine?"
- "When do you need delivery?"
- "Is this for a specific project like a building or factory?"
- "Are you the decision maker for this purchase?"

If Hindi was chosen, use ONLY these:
- "Aapko JSW ka kaun sa product chahiye?"
- "Kitni matra chahiye — rough bhi chalega?"
- "Delivery kab chahiye?"
- "Kisi specific project ke liye hai — jaise building ya factory?"
- "Aap hi purchase ka decision lete hain?"

IMPORTANT: Never mix languages in a single response.
If English was chosen — every word you say must be English.
If Hindi was chosen — every word you say must be Hindi or Hinglish.

== INTENT — call capture_lead_info whenever you learn something new ==
high = quantity >5MT AND delivery <3 months AND specific project AND decision maker
medium = any 2 of above
low = general inquiry or just researching

== ENDING THE CONVERSATION ==
Call end_conversation IMMEDIATELY (in the SAME turn as your reply) when the user:
- Says goodbye, bye, thanks/thank you with no further question, "that's all", "that's it",
  "I'm done", "nothing else", "ok bye", "gotta go", or the Hindi/Hinglish equivalents
  (dhanyawad, theek hai bye, bas itna hi, nahi chahiye, ok thanks)
- Has clearly gotten what they needed and is not asking anything further
- Goes silent/says nothing more after you've already offered further help once
Before/while calling it, say ONE short warm closing line (e.g. "Thank you for contacting
JSW Steel, have a great day!" or "JSW Steel se sampark karne ke liye dhanyawad, have a great day!")
then stop talking. Do not ask "anything else?" after already asking it once and getting a
negative/closing answer — just end the conversation.

== KNOWLEDGE BASE ==
${JSW_KNOWLEDGE_BASE}`;

// ── TOOLS ────────────────────────────────────────────────
const REALTIME_TOOLS = [{
  type: 'function',
  name: 'capture_lead_info',
  description: 'Capture and update customer/lead information as it is revealed during conversation. Call this whenever you learn anything new.',
  parameters: {
    type: 'object',
    properties: {
      name:             { type: 'string' },
      company:          { type: 'string' },
      phone:            { type: 'string' },
      email:            { type: 'string' },
      product_interest: { type: 'string' },
      project_type:     { type: 'string' },
      quantity_mt:      { type: 'number' },
      timeline:         { type: 'string' },
      intent_level:     { type: 'string', enum: ['high', 'medium', 'low'] },
      intent_reason:    { type: 'string' }
    }
  }
}, {
  type: 'function',
  name: 'show_contact_form',
  description: 'Show callback/contact form when user wants to speak to sales, get a quote, or has a complex requirement. Call immediately when user asks for human, quote, or callback.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Reason: sales_rep_request | quote_request | complex_query' }
    }
  }
}, {
  type: 'function',
  name: 'end_conversation',
  description: 'End the call once the user has said goodbye, thanks with no further question, or has clearly finished the conversation. Call this immediately after saying a short closing line.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Reason: user_said_goodbye | query_resolved | no_response_expected' }
    }
  }
}];

// ── SESSION STORE ────────────────────────────────────────
const sessions = new Map();

// ── WEBSOCKET SERVER ─────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/realtime' });

wss.on('connection', (clientWs) => {
  const sessionId = uuidv4();
  const leadId    = uuidv4();
  const startTime = Date.now();
  let greetingSent = false;
  console.log(`[${sessionId.slice(0,8)}] Browser connected`);

  sessions.set(sessionId, { leadId, lead: {}, transcript: [], language: 'english', openAiWs: null });
  db.insertLead(leadId, sessionId);

  const openAiWs = new WebSocket(
    'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
  );

  sessions.get(sessionId).openAiWs = openAiWs;

  openAiWs.on('open', () => {
    console.log(`[${sessionId.slice(0,8)}] OpenAI connected`);
    openAiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: SYSTEM_PROMPT,
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            turn_detection: { type: 'semantic_vad' },
            transcription: {
              model: 'whisper-1',
              prompt: 'JSW Steel, TMT bars, HR coils, CR sheets, galvanized, Fe-500D, grades, quantity, pricing, delivery. जेएसडब्ल्यू स्टील, टीएमटी बार, एचआर कॉइल, मात्रा, कीमत, डिलीवरी, ग्रेड, गैल्वेनाइज्ड'
            }
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'ash'
          }
        },
        tools: REALTIME_TOOLS,
        tool_choice: 'auto'
      }
    }));
  });

  openAiWs.on('message', (raw) => {
    const ev      = JSON.parse(raw.toString());
    const session = sessions.get(sessionId);
    if (!session) return;

    // Suppress responses to very short noise bursts (<600ms)
    if (ev.type === 'input_audio_buffer.speech_stopped') {
      const session = sessions.get(sessionId);
      if (session && session.speechStartedAt) {
        const dur = Date.now() - session.speechStartedAt;
        if (dur < 600) {
          // Too short — likely background noise, cancel the response
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          }
          session.speechStartedAt = null;
        }
      }
    }

    if (ev.type === 'input_audio_buffer.speech_started') {
      session.speechStartedAt = Date.now();
    }

    if (ev.type === 'session.updated') {
      if (!greetingSent) {
        greetingSent = true;
        setTimeout(() => {
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                instructions: 'Say exactly this and nothing else: "Welcome to JSW Steel — India\'s largest and most trusted steel manufacturer. I\'m JSW Assist. Please select your preferred language using the buttons below."'
              }
            }));
          }
        }, 1500);
      }
    }

    if (ev.type === 'response.function_call_arguments.done' && ev.name === 'capture_lead_info') {
      try { handleLeadCapture(sessionId, ev.call_id, JSON.parse(ev.arguments)); } catch (e) { console.error(e.message); }
    }

    if (ev.type === 'response.function_call_arguments.done' && ev.name === 'show_contact_form') {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'show_contact_form', leadId: session.leadId }));
      }
      const oaWs = session.openAiWs;
      if (oaWs?.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"success":true}' }}));
        oaWs.send(JSON.stringify({ type: 'response.create' }));
      }
    }

    if (ev.type === 'response.function_call_arguments.done' && ev.name === 'end_conversation') {
      // Let the client know a closing line is coming so it can auto-hang-up
      // once that farewell audio finishes playing.
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'end_conversation', leadId: session.leadId }));
      }
      const oaWs = session.openAiWs;
      if (oaWs?.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output: '{"success":true}' }}));
        // A function-call turn produces no audio by itself — a fresh
        // response.create is required to actually speak the goodbye.
        oaWs.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: 'Say ONE short warm goodbye sentence now, in the language already locked for this conversation, then stop completely. Do not call any function. Do not ask any further questions.'
          }
        }));
      }
    }

    if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript?.trim()) {
      session.transcript.push({ role: 'user', text: ev.transcript, ts: new Date().toISOString() });
      db.setTranscript(leadId, JSON.stringify(session.transcript));
      if (/[\u0900-\u097F]/.test(ev.transcript) ||
        /\b(kya|hai|mujhe|aap|hum|yeh|woh|main|nahi|haan|theek|accha|namaste|bataiye|chahiye)\b/i.test(ev.transcript))
        session.language = 'hindi';
    }

    if (ev.type === 'response.output_audio_transcript.done' && ev.transcript?.trim()) {
      session.transcript.push({ role: 'assistant', text: ev.transcript, ts: new Date().toISOString() });
      db.setTranscript(leadId, JSON.stringify(session.transcript));
    }

    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(raw.toString());
  });

  openAiWs.on('error', (e) => {
    console.error(`[${sessionId.slice(0,8)}] OpenAI error:`, e.message);
    if (clientWs.readyState === WebSocket.OPEN)
      clientWs.send(JSON.stringify({ type: 'error', message: e.message }));
  });

  openAiWs.on('close', () => console.log(`[${sessionId.slice(0,8)}] OpenAI closed`));

  clientWs.on('message', (data) => {
    let parsed = null;
    try { parsed = JSON.parse(data.toString()); } catch (_) { /* not JSON, relay raw */ }

    if (parsed && parsed.type === 'language_selected') {
      const lang = parsed.language === 'hi' ? 'hi' : 'en';
      const session = sessions.get(sessionId);
      if (session) session.language = lang === 'hi' ? 'hindi' : 'english';

      const instructions = lang === 'hi'
        ? 'CRITICAL: Respond ONLY in Hindi/Hinglish. Never use English sentences.\n' + SYSTEM_PROMPT
        : 'CRITICAL: Respond ONLY in English. Never use Hindi.\n' + SYSTEM_PROMPT;

      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: instructions,
            audio: {
              input: {
                transcription: {
                  model: 'whisper-1',
                  language: lang,
                  prompt: lang === 'hi'
                    ? 'JSW Steel, टीएमटी बार, एचआर कॉइल, मात्रा, कीमत, डिलीवरी'
                    : 'JSW Steel, TMT bars, HR coils, quantity, pricing, delivery'
                }
              }
            }
          }
        }));
      }
      return;
    }

    if (openAiWs.readyState === WebSocket.OPEN) openAiWs.send(data.toString());
  });

  clientWs.on('close', () => {
    const secs = Math.round((Date.now() - startTime) / 1000);
    console.log(`[${sessionId.slice(0,8)}] Browser disconnected (${secs}s)`);
    db.setDuration(leadId, secs);
    openAiWs.close();
    sessions.delete(sessionId);
  });

  clientWs.send(JSON.stringify({ type: 'session.init', sessionId, leadId }));
});

function handleLeadCapture(sessionId, callId, args) {
  const session = sessions.get(sessionId);
  if (!session) return;
  Object.assign(session.lead, Object.fromEntries(
    Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== '')
  ));
  db.updateLead(session.leadId, { ...session.lead, language: session.language });
  console.log(`[${sessionId.slice(0,8)}] Lead: ${session.lead.name || '?'} | ${session.lead.intent_level || 'low'}`);
  const oaWs = session.openAiWs;
  if (oaWs?.readyState === WebSocket.OPEN) {
    oaWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: '{"success":true}' }}));
    oaWs.send(JSON.stringify({ type: 'response.create' }));
  }
}

// ── REST API ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/jsw-demo.html');
});

app.get('/bot', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/leads',     (req, res) => res.json(db.getLeads(req.query.intent)));
app.get('/api/leads/:id', (req, res) => { const l = db.getLead(req.params.id); l ? res.json(l) : res.status(404).json({error:'Not found'}); });
app.get('/api/stats',     (req, res) => res.json(db.getStats()));

app.post('/api/leads/:id/form', (req, res) => {
  const { name, phone, email, query } = req.body;
  const data = loadDB();
  const lead = data.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if (name)  lead.name  = name;
  if (phone) lead.phone = phone;
  if (email) lead.email = email;
  if (query) lead.contact_form_query = query;
  lead.contact_form_submitted = true;
  lead.updated_at = new Date().toISOString();
  saveDB(data);
  res.json({ success: true });
});

// ── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║      JSW Steel Voice Bot Server      ║');
  console.log(`  ║  http://localhost:${PORT}               ║`);
  console.log('  ║  Dashboard → /dashboard.html         ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
