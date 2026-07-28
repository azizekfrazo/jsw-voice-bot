/**
 * db.js — Simple JSON file store
 * Replaces better-sqlite3 (no native compilation needed on Windows)
 */
const fs   = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'leads.json');

function load() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (_) {}
  return [];
}

function save(leads) {
  fs.writeFileSync(DB_FILE, JSON.stringify(leads, null, 2));
}

// ── INSERT ──────────────────────────────────────────────
function insertLead(id, sessionId) {
  const leads = load();
  leads.push({
    id,
    session_id:       sessionId,
    name:             null,
    company:          null,
    phone:            null,
    email:            null,
    product_interest: null,
    project_type:     null,
    quantity_mt:      null,
    timeline:         null,
    intent_level:     'low',
    intent_reason:    null,
    transcript:       '[]',
    language:         'english',
    duration_secs:    0,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString()
  });
  save(leads);
}

// ── UPDATE (merge – never overwrites with null) ─────────
function updateLead(id, updates) {
  const leads = load();
  const idx   = leads.findIndex(l => l.id === id);
  if (idx === -1) return;

  for (const [k, v] of Object.entries(updates)) {
    if (v !== null && v !== undefined && v !== '') leads[idx][k] = v;
  }
  leads[idx].updated_at = new Date().toISOString();
  save(leads);
}

// ── TRANSCRIPT ──────────────────────────────────────────
function setTranscript(id, transcript) {
  const leads = load();
  const idx   = leads.findIndex(l => l.id === id);
  if (idx === -1) return;
  leads[idx].transcript  = JSON.stringify(transcript);
  leads[idx].updated_at  = new Date().toISOString();
  save(leads);
}

// ── DURATION ────────────────────────────────────────────
function setDuration(id, secs) {
  const leads = load();
  const idx   = leads.findIndex(l => l.id === id);
  if (idx === -1) return;
  leads[idx].duration_secs = secs;
  save(leads);
}

// ── QUERIES ─────────────────────────────────────────────
function getLeads(intent) {
  const rows = load().sort((a, b) =>
    new Date(b.updated_at) - new Date(a.updated_at)
  );
  if (intent && intent !== 'all') return rows.filter(r => r.intent_level === intent);
  return rows;
}

function getLead(id) {
  return load().find(l => l.id === id) || null;
}

function getStats() {
  const rows = load();
  return {
    total:     rows.length,
    high:      rows.filter(r => r.intent_level === 'high').length,
    medium:    rows.filter(r => r.intent_level === 'medium').length,
    low:       rows.filter(r => r.intent_level === 'low').length,
    qualified: rows.filter(r => r.name && r.intent_level).length
  };
}

module.exports = { insertLead, updateLead, setTranscript, setDuration, getLeads, getLead, getStats };
