// ── SHARED BOT CORE ──────────────────────────────────────────
// Prompts, tool schemas, and the leads.json / chats.json data stores.
// Extracted so both server.js (REST + text chat) and session-manager.js
// (voice pipeline) can share the exact same prompt/tool/lead-capture logic
// without server.js and session-manager.js needing to require each other.
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { JSW_KNOWLEDGE_BASE } = require('./knowledge');
const config = require('./config');

// ── LEADS DATABASE (leads.json) ─────────────────────────────
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
  insertLead(id, sessionId, mode = 'voice') {
    const data = loadDB();
    data.leads.push({
      id, session_id: sessionId, mode,
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

// ── CHAT DATABASE (chats.json) ──────────────────────────────
const CHATS_DB_FILE = path.join(__dirname, 'chats.json');

function loadChatsDB() {
  try {
    if (fs.existsSync(CHATS_DB_FILE)) return JSON.parse(fs.readFileSync(CHATS_DB_FILE, 'utf8'));
  } catch (_) {}
  return { chats: [] };
}

function saveChatsDB(data) {
  fs.writeFileSync(CHATS_DB_FILE, JSON.stringify(data, null, 2));
}

const chatDb = {
  createChat(leadId, language) {
    const data = loadChatsDB();
    const chatId = uuidv4();
    data.chats.push({
      id: chatId, leadId, sessionId: null, messages: [],
      language, created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
    saveChatsDB(data);
    return chatId;
  },

  addMessage(chatId, role, text, language) {
    const data = loadChatsDB();
    const chat = data.chats.find(c => c.id === chatId);
    if (!chat) return;
    chat.messages.push({ role, text, ts: new Date().toISOString() });
    if (language) chat.language = language;
    chat.updated_at = new Date().toISOString();
    saveChatsDB(data);
  },

  getChat(chatId) {
    return loadChatsDB().chats.find(c => c.id === chatId) || null;
  }
};

// ── SYSTEM PROMPT (voice) ────────────────────────────────────
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

// Chat variant: same tone/knowledge/qualification — only the response-length
// rule differs (written chat can carry a bit more text than a voice call).
const CHAT_SYSTEM_PROMPT = SYSTEM_PROMPT.replace(
  `== RESPONSE LENGTH — MOST IMPORTANT RULE ==
Maximum 2 short sentences. Never more. Count your sentences before replying.
If you are about to say a third sentence, STOP and delete it.
This is a voice call. Long answers are rude.`,
  `== RESPONSE LENGTH — MOST IMPORTANT RULE ==
Keep responses concise (3-4 sentences max) — written chat is easier to read than voice.`
);

// ── TOOLS ─────────────────────────────────────────────────────
const TOOLS = [{
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

// Chat Completions expects tools wrapped as { type:'function', function: {...} }
const CHAT_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters }
}));

async function callOpenAIChat(messages) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.openai.apiKey}`
    },
    body: JSON.stringify({
      model: config.openai.llmModel,
      messages,
      tools: CHAT_TOOLS,
      tool_choice: 'auto'
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI chat error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

// Runs one user turn through the model (non-streaming — used by the REST
// text-chat endpoint). The voice pipeline uses gpt4o-llm.js's streaming
// variant instead, but both share TOOLS/CHAT_TOOLS and the same tool-call
// side effects (capture_lead_info/show_contact_form/end_conversation).
async function runChatTurn(entry, userMessage) {
  entry.history.push({ role: 'user', content: userMessage });

  let finalReply = '';
  let firedFunctions = [];
  let leadUpdates = null;
  let showForm = false;
  let ended = false;

  for (let iter = 0; iter < 3; iter++) {
    const messages = [{ role: 'system', content: entry.systemPrompt }, ...entry.history];
    const completion = await callOpenAIChat(messages);
    const msg = completion.choices[0].message;

    if (msg.tool_calls && msg.tool_calls.length) {
      entry.history.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });

      for (const call of msg.tool_calls) {
        const name = call.function.name;
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) {}
        firedFunctions.push(name);

        if (name === 'capture_lead_info') {
          const clean = Object.fromEntries(
            Object.entries(args).filter(([, v]) => v !== null && v !== undefined && v !== '')
          );
          Object.assign(entry.lead, clean);
          leadUpdates = { ...entry.lead };
          db.updateLead(entry.leadId, { ...entry.lead, language: entry.language });
        } else if (name === 'show_contact_form') {
          showForm = true;
        } else if (name === 'end_conversation') {
          ended = true;
        }

        entry.history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: true }) });
      }
      continue; // fetch the actual reply text now that tool results are available
    }

    finalReply = msg.content || '';
    break;
  }

  entry.history.push({ role: 'assistant', content: finalReply });
  return { reply: finalReply, functions: firedFunctions, leadUpdates, showForm, ended };
}

module.exports = {
  db, loadDB, saveDB,
  chatDb,
  SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT,
  TOOLS, CHAT_TOOLS,
  callOpenAIChat, runChatTurn,
};
