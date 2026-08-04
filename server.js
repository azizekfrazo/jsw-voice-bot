require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const cors      = require('cors');

const { SessionManager } = require('./session-manager');
const {
  db, loadDB, saveDB, chatDb,
  CHAT_SYSTEM_PROMPT, runChatTurn,
} = require('./bot-core');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
const server = http.createServer(app);

// ── CHAT (TEXT) SESSION STORE ────────────────────────────
// leadId -> { chatId, language, lead, history: [{role, content, tool_calls?, tool_call_id?}] }
const chatMemory = new Map();

// ── WEBSOCKET SERVER (VOICE) ─────────────────────────────
// Each connection is handled by a SessionManager, which drives the
// Deepgram STT || GPT-4o-mini LLM || OpenAI TTS pipeline (replacing the
// old direct proxy to OpenAI's Realtime API) while emitting the exact
// same message vocabulary the existing client already understands —
// see session-manager.js and VOICE_PIPELINE_ARCHITECTURE.md.
const wss = new WebSocket.Server({ server, path: '/realtime' });

wss.on('connection', (clientWs) => {
  let session;
  try {
    session = new SessionManager(clientWs);
  } catch (err) {
    // A single connection failing to initialize must never take down
    // every other active session — this is a WS 'connection' handler with
    // no other safety net around it.
    console.error('[SessionManager] init error:', err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to start session' }));
      clientWs.close();
    }
    return;
  }

  clientWs.on('message', (data) => {
    let parsed = null;
    try { parsed = JSON.parse(data.toString()); } catch (_) { return; }
    if (!parsed || !parsed.type) return;

    if (parsed.type === 'language_selected') {
      session.handleLanguageSelected(parsed.language);
    } else if (parsed.type === 'input_audio_buffer.append' && parsed.audio) {
      session.pushAudio(parsed.audio);
    }
    // Other Realtime-specific control messages (response.cancel, etc.) are
    // no longer meaningful against this pipeline and are intentionally ignored.
  });

  clientWs.on('close', () => session.destroy());
});

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

app.post('/api/chat', async (req, res) => {
  try {
    let { leadId, message, language } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

    const lang = language === 'hi' ? 'hi' : 'en';
    let entry = leadId ? chatMemory.get(leadId) : null;

    if (!entry) {
      leadId = leadId || uuidv4();
      const langLabel = lang === 'hi' ? 'Hindi/Hinglish' : 'English';
      const systemPrompt = `CRITICAL: Respond ONLY in ${langLabel}. Never switch languages.\n\n${CHAT_SYSTEM_PROMPT}`;

      db.insertLead(leadId, null, 'chat');
      const chatId = chatDb.createChat(leadId, lang === 'hi' ? 'hindi' : 'english');

      entry = {
        chatId, leadId,
        language: lang === 'hi' ? 'hindi' : 'english',
        systemPrompt, lead: {}, history: []
      };
      chatMemory.set(leadId, entry);
    }

    chatDb.addMessage(entry.chatId, 'user', message);
    const result = await runChatTurn(entry, message);
    chatDb.addMessage(entry.chatId, 'assistant', result.reply);

    res.json({
      reply: result.reply,
      type: result.functions.length ? 'function_call' : 'text',
      functionName: result.functions[0] || null,
      leadUpdates: result.leadUpdates,
      leadId,
      chatId: entry.chatId,
      showForm: result.showForm,
      ended: result.ended
    });
  } catch (e) {
    console.error('[Chat] error:', e.message);
    res.status(500).json({ error: 'Chat error', message: e.message });
  }
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
