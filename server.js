// RolanPRO CRM Backend
// - Receives leads from: website contact form, Facebook Lead Ads
// - Stores them in a simple JSON "inbox" the CRM can poll and convert into real clients/orders
// - Optionally stores the full CRM state (same shape as the old localStorage blob) so the
//   CRM can sync across devices instead of being stuck in one browser's localStorage
//
// Deploy target: Railway (or Render/Fly/any Node host). See DEPLOY.md.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ---------- CONFIG (all via environment variables — set these in Railway) ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-in-railway-env';           // CRM <-> backend auth
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'change-me-fb-verify'; // set in Meta dashboard
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';          // Graph API token
const WEBSITE_FORM_SECRET = process.env.WEBSITE_FORM_SECRET || '';            // optional, empty = open endpoint

const DATA_DIR = path.join(__dirname, 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');
if (!fs.existsSync(STATE_FILE)) fs.writeFileSync(STATE_FILE, 'null');

// ---------- tiny file-backed store with a write queue (avoids concurrent write corruption) ----------
let writeQueue = Promise.resolve();
function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeJSON(file, data) {
  writeQueue = writeQueue.then(() => fs.promises.writeFile(file, JSON.stringify(data, null, 2)));
  return writeQueue;
}

function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

// ---------- auth middleware for CRM-facing endpoints ----------
function requireApiKey(req, res, next) {
  const key = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// =====================================================================
// LEAD INBOX — website form + Facebook Lead Ads land here.
// The CRM polls GET /api/leads, shows them as a "New Leads" queue, and
// the user (or an auto-rule) converts each into a real client + order
// using the CRM's own logic. Leads are marked processed via DELETE.
// =====================================================================

function addLead(lead) {
  const leads = readJSON(LEADS_FILE);
  const entry = {
    id: newId('lead'),
    receivedAt: new Date().toISOString(),
    processed: false,
    ...lead,
  };
  leads.push(entry);
  return writeJSON(LEADS_FILE, leads).then(() => entry);
}

// CRM fetches unprocessed leads
app.get('/api/leads', requireApiKey, (req, res) => {
  const leads = readJSON(LEADS_FILE);
  const onlyNew = req.query.all === '1' ? leads : leads.filter(l => !l.processed);
  res.json(onlyNew);
});

// CRM marks a lead as processed (converted into a client/order) or deletes it
app.post('/api/leads/:id/processed', requireApiKey, (req, res) => {
  const leads = readJSON(LEADS_FILE);
  const lead = leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  lead.processed = true;
  lead.processedAt = new Date().toISOString();
  writeJSON(LEADS_FILE, leads).then(() => res.json(lead));
});

app.delete('/api/leads/:id', requireApiKey, (req, res) => {
  const leads = readJSON(LEADS_FILE);
  const next = leads.filter(l => l.id !== req.params.id);
  writeJSON(LEADS_FILE, next).then(() => res.json({ ok: true }));
});

// ---------------------------------------------------------------------
// Website contact form → POST here from your site's form JS.
// Example fetch from the website:
//   fetch('https://YOUR-BACKEND.up.railway.app/api/webhooks/website', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ name, phone, email, message, secret: 'WEBSITE_FORM_SECRET_VALUE' })
//   })
// ---------------------------------------------------------------------
app.post('/api/webhooks/website', async (req, res) => {
  if (WEBSITE_FORM_SECRET && req.body.secret !== WEBSITE_FORM_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }
  const { name, phone, email, message, address } = req.body || {};
  if (!name && !phone && !email) {
    return res.status(400).json({ error: 'Need at least name, phone or email' });
  }
  const lead = await addLead({
    source: 'website',
    name: name || '',
    phone: phone || '',
    email: email || '',
    message: message || '',
    address: address || '',
    raw: req.body,
  });
  res.json({ ok: true, id: lead.id });
});

// ---------------------------------------------------------------------
// Facebook Lead Ads webhook.
// 1) GET is Meta's verification handshake when you register the webhook URL.
// 2) POST is the actual "new lead" notification (contains only IDs — we then
//    call the Graph API with FB_PAGE_ACCESS_TOKEN to fetch the real field data).
// Setup steps are in DEPLOY.md.
// ---------------------------------------------------------------------
app.get('/api/webhooks/facebook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === FB_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/api/webhooks/facebook', async (req, res) => {
  // Acknowledge immediately — Meta requires a fast 200, we process async.
  res.sendStatus(200);

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;
        const leadgenId = change.value.leadgen_id;
        const formId = change.value.form_id;
        const pageId = change.value.page_id;

        if (!FB_PAGE_ACCESS_TOKEN) {
          await addLead({
            source: 'facebook',
            name: '', phone: '', email: '',
            message: `Lead ID ${leadgenId} (FB_PAGE_ACCESS_TOKEN не задан — не смог получить данные лида)`,
            leadgenId, formId, pageId,
          });
          continue;
        }

        // Fetch the actual field data from Graph API
        const url = `https://graph.facebook.com/v19.0/${leadgenId}?access_token=${FB_PAGE_ACCESS_TOKEN}`;
        const resp = await fetch(url);
        const data = await resp.json();
        const fields = {};
        (data.field_data || []).forEach(f => { fields[f.name] = (f.values || [])[0] || ''; });

        await addLead({
          source: 'facebook',
          name: fields.full_name || fields.name || '',
          phone: fields.phone_number || fields.phone || '',
          email: fields.email || '',
          message: '',
          leadgenId, formId, pageId,
          raw: data,
        });
      }
    }
  } catch (err) {
    console.error('Facebook webhook processing error:', err);
  }
});

// =====================================================================
// OPTIONAL: full CRM state sync (replaces localStorage as source of truth
// so the CRM can be opened from any device/browser and stay in sync).
// Only wire this up once you're ready — the CRM keeps working from
// localStorage until you switch it over.
// =====================================================================
app.get('/api/state', requireApiKey, (req, res) => {
  res.json(readJSON(STATE_FILE));
});

app.put('/api/state', requireApiKey, (req, res) => {
  writeJSON(STATE_FILE, req.body).then(() => res.json({ ok: true }));
});

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`RolanPRO backend listening on port ${PORT}`));


// =====================================================================
// AI SALES BOT — обученный на продукте RolanPRO чат-бот для сайта.
// - CRM загружает базу знаний:  PUT /api/ai/knowledge  (защищено API_KEY)
// - Виджет на сайте общается:   POST /api/ai/chat      (публичный)
// - Ключ Anthropic живёт здесь, в env (ANTHROPIC_API_KEY) — на сайте не светится.
// =====================================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const KNOWLEDGE_FILE = path.join(DATA_DIR, 'knowledge.json');
if (!fs.existsSync(KNOWLEDGE_FILE)) fs.writeFileSync(KNOWLEDGE_FILE, JSON.stringify({ text: '' }));

app.put('/api/ai/knowledge', requireApiKey, (req, res) => {
  const text = (req.body && req.body.text) || '';
  writeJSON(KNOWLEDGE_FILE, { text, updatedAt: new Date().toISOString() })
    .then(() => res.json({ ok: true, chars: text.length }));
});
app.get('/api/ai/knowledge', requireApiKey, (req, res) => {
  res.json(readJSON(KNOWLEDGE_FILE));
});

// Простейшая защита от злоупотреблений: лимит запросов с одного IP
const chatHits = new Map();
function chatRateLimited(ip) {
  const now = Date.now();
  const rec = chatHits.get(ip) || [];
  const fresh = rec.filter(t => now - t < 60 * 60 * 1000); // за час
  fresh.push(now);
  chatHits.set(ip, fresh);
  return fresh.length > 60; // максимум 60 сообщений в час с IP
}

app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: 'AI не настроен (нет ANTHROPIC_API_KEY)' });
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '?';
    if (chatRateLimited(ip)) return res.status(429).json({ error: 'Слишком много сообщений, попробуйте позже' });

    const history = Array.isArray(req.body.messages) ? req.body.messages.slice(-20) : [];
    const messages = history
      .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
    if (!messages.length || messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: 'messages должен заканчиваться сообщением user' });
    }

    const knowledge = readJSON(KNOWLEDGE_FILE).text || '';
    const system = `Ты — дружелюбный консультант компании RolanPRO (установка оконных плёнок в Лос-Анджелесе: солнцезащитные, защитные/security, smart, декоративные, приватные).
Твоя задача: помочь посетителю, ответить на вопросы о плёнках, мягко подвести к бесплатной консультации/замеру и получить имя и телефон.
Правила: отвечай кратко (2-4 предложения), на языке клиента (обычно английский или русский), не выдумывай цены точнее, чем указано в базе знаний, не обещай сроков без данных. Если клиент готов — попроси имя и телефон и скажи, что менеджер свяжется в течение 15 минут в рабочее время.
Если вопрос совсем не по теме окон/плёнок/компании — вежливо вернись к теме.

БАЗА ЗНАНИЙ О ПРОДУКТЕ:
${knowledge || '(база знаний пока не загружена — отвечай общими сведениями об оконных плёнках и предлагай консультацию)'}`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: AI_MODEL, max_tokens: 500, system, messages }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: data.error?.message || 'AI error' });
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

    const allUserText = messages.filter(m => m.role === 'user').map(m => m.content).join(' ');
    const phoneMatch = allUserText.match(/(\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
    let leadCreated = false;
    if (phoneMatch && !req.body.leadAlreadyCreated) {
      const nameGuess = (req.body.visitorName || '').slice(0, 80);
      await addLead({
        source: 'ai-chat',
        name: nameGuess,
        phone: phoneMatch[1],
        email: '',
        message: 'Из ИИ-чата: ' + allUserText.slice(-300),
      });
      leadCreated = true;
    }

    res.json({ reply: text, leadCreated });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: 'internal' });
  }
});


// =====================================================================
// SMS PROXY — браузер не может звать textbelt.com напрямую (CORS),
// поэтому CRM шлёт SMS через этот эндпоинт, а сервер — в TextBelt.
// Ключ TextBelt передаётся из CRM (или задаётся в env TEXTBELT_KEY).
// =====================================================================
app.post('/api/sms/send', requireApiKey, async (req, res) => {
  try {
    const { to, message, textbeltKey } = req.body || {};
    if (!to || !message) return res.status(400).json({ error: 'Нужны to и message' });
    const key = textbeltKey || process.env.TEXTBELT_KEY || '';
    if (!key) return res.status(400).json({ error: 'Нет TextBelt ключа' });
    const r = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ phone: to, message, key }).toString(),
    });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error('SMS proxy error:', err);
    res.status(502).json({ error: 'proxy: ' + err.message });
  }
});
