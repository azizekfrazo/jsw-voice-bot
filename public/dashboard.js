/* ─────────────────────────────────────────────────────────
   JSW Steel Sales Dashboard — Frontend Logic
   ───────────────────────────────────────────────────────── */

let currentFilter = 'all';
let allLeads = [];

// ─────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadAll();
  // Auto-refresh every 30 seconds
  setInterval(loadAll, 30000);
});

async function loadAll() {
  await Promise.all([loadStats(), loadLeads(currentFilter)]);
}

// ─────────────────────────────────────────────
//  STATS
// ─────────────────────────────────────────────
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const s   = await res.json();
    document.getElementById('stat-total').textContent  = s.total  ?? 0;
    document.getElementById('stat-high').textContent   = s.high   ?? 0;
    document.getElementById('stat-medium').textContent = s.medium ?? 0;
    document.getElementById('stat-low').textContent    = s.low    ?? 0;
  } catch (e) {
    console.error('Stats error:', e);
  }
}

// ─────────────────────────────────────────────
//  LEADS TABLE
// ─────────────────────────────────────────────
async function loadLeads(intent = 'all') {
  const url  = intent === 'all' ? '/api/leads' : `/api/leads?intent=${intent}`;
  const tbody = document.getElementById('leads-body');

  try {
    const res  = await fetch(url);
    allLeads   = await res.json();
    renderTable(allLeads);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">Error loading leads</td></tr>`;
  }
}

function renderTable(leads) {
  const tbody = document.getElementById('leads-body');

  if (!leads.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="no-data">No leads yet — start a conversation!</td></tr>`;
    return;
  }

  tbody.innerHTML = leads.map(lead => {
    const badge   = intentBadge(lead.intent_level);
    const name    = lead.name    ? esc(lead.name)    : '<span style="color:#9CA3AF">Unknown</span>';
    const company = lead.company ? ` · ${esc(lead.company)}` : '';
    const product = lead.product_interest ? esc(lead.product_interest) : '—';
    const qty     = lead.quantity_mt ? `${lead.quantity_mt} MT` : '—';
    const time    = lead.timeline ? esc(lead.timeline) : '—';
    const lang    = (lead.language || 'english').toUpperCase().slice(0, 2);
    const ago     = timeAgo(lead.updated_at);

    return `
      <tr onclick="openModal('${lead.id}')">
        <td>
          <div class="td-name">${name}</div>
          <div class="td-muted">${company.slice(3)}</div>
        </td>
        <td>${badge}</td>
        <td class="td-product">${product}</td>
        <td class="td-muted">${qty}</td>
        <td class="td-muted">${time}</td>
        <td class="td-lang">${lang}</td>
        <td>${lead.contact_form_submitted ? '<span style="color:#16A34A;font-weight:700;font-size:12px">✓ Submitted</span>' : '<span style="color:#9CA3AF;font-size:12px">—</span>'}</td>
        <td class="td-muted">${formatDuration(lead.duration_secs)}</td>
        <td class="td-time">${ago}</td>
      </tr>`;
  }).join('');
}

function intentBadge(level) {
  const lvl = level || 'low';
  const labels = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
  return `<span class="badge badge-${lvl}">${labels[lvl] || 'LOW'}</span>`;
}

// ─────────────────────────────────────────────
//  FILTER
// ─────────────────────────────────────────────
function filterLeads(intent, btn) {
  currentFilter = intent;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadLeads(intent);
}

// ─────────────────────────────────────────────
//  MODAL
// ─────────────────────────────────────────────
async function openModal(id) {
  const res  = await fetch(`/api/leads/${id}`);
  const lead = await res.json();

  document.getElementById('modal-name').textContent =
    lead.name ? `${lead.name}${lead.company ? ' · ' + lead.company : ''}` : 'Unknown Lead';

  const intent = lead.intent_level || 'low';
  const intentLabel = { high: '🔥 High Intent — Ready to Buy', medium: '🔔 Medium Intent — Evaluating', low: '📋 Low Intent — Exploring' };

  const fields = [
    ['Product Interest', lead.product_interest],
    ['Project Type',     lead.project_type],
    ['Quantity',         lead.quantity_mt ? `${lead.quantity_mt} MT` : null],
    ['Timeline',         lead.timeline],
    ['Phone',            lead.phone],
    ['Email',            lead.email],
    ['Language',         lead.language ? lead.language.charAt(0).toUpperCase() + lead.language.slice(1) : null],
    ['Duration',         lead.duration_secs ? formatDuration(lead.duration_secs) : null],
    ['Query / Requirement', lead.contact_form_query],
    ['Form Submitted', lead.contact_form_submitted ? 'Yes' : 'No'],
  ].filter(([, v]) => v);

  const detailHtml = fields.map(([label, value]) => `
    <div class="detail-item">
      <div class="detail-label">${label}</div>
      <div class="detail-value">${esc(String(value))}</div>
    </div>
  `).join('');

  // Intent reason box
  const reasonHtml = lead.intent_reason ? `
    <div style="background:#F8FAFC;border-radius:8px;padding:12px 16px;font-size:13px;color:#374151;border-left:4px solid ${intent==='high'?'#16A34A':intent==='medium'?'#D97706':'#6B7280'}">
      <strong>Intent reason:</strong> ${esc(lead.intent_reason)}
    </div>
  ` : '';

  // Transcript
  const msgs = (lead.transcript || []);
  const transcriptHtml = msgs.length ? `
    <div class="transcript-section">
      <h4>Conversation Transcript (${msgs.length} messages)</h4>
      <div class="transcript-msgs">
        ${msgs.map(m => `
          <div class="t-msg ${m.role}">
            <div class="t-msg-role">${m.role === 'user' ? 'CUSTOMER' : 'JSW ASSIST'}</div>
            ${esc(m.text)}
          </div>
        `).join('')}
      </div>
    </div>
  ` : '<p style="color:#9CA3AF;font-size:13px">No transcript available yet.</p>';

  document.getElementById('modal-body').innerHTML = `
    <div class="intent-banner ${intent}">${intentLabel[intent] || 'Unknown Intent'}</div>
    <div class="detail-grid">${detailHtml || '<p style="color:#9CA3AF;font-size:13px;grid-column:span 2">No details captured yet.</p>'}</div>
    ${reasonHtml}
    ${transcriptHtml}
  `;

  document.getElementById('modal-overlay').classList.add('open');
}

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById('modal-overlay').classList.remove('open');
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDuration(secs) {
  if (!secs) return '—';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function timeAgo(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr + (isoStr.endsWith('Z') ? '' : 'Z'));
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs/24)}d ago`;
}
