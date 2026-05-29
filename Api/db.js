/**
 * La Mia Cantina — Cloud Sync API
 * Vercel Serverless Function (Node.js 18+)
 * Database: Vercel KV (Upstash Redis)
 *
 * SETUP (una tantum):
 *   OPZIONE A — Vercel Marketplace (consigliata):
 *     1. vercel.com → il tuo progetto → Integrations (o Marketplace) → cerca "Upstash"
 *     2. Installa Upstash Redis → crea un database → collegalo al progetto
 *     3. Vercel inietta automaticamente: UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN
 *
 *   OPZIONE B — Upstash diretto (senza Marketplace):
 *     1. Crea account su upstash.com → New Database → tipo Redis → region Europe
 *     2. Copia "REST API" URL e Token dalla pagina del database
 *     3. Aggiungi su Vercel: Settings → Environment Variables:
 *          UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
 *          UPSTASH_REDIS_REST_TOKEN = AXxx...
 *     4. Rideploya il progetto
 *
 * Endpoints:
 *   GET  /api/db?key=CHIAVE&store=wines|movements  → {data:[], ts:number}
 *   POST /api/db  body:{key, store, data:[], ts}   → {ok:true, ts:number}
 *
 * Struttura KV:
 *   cantina:{key}:wines          → JSON array vini (senza foto)
 *   cantina:{key}:movements      → JSON array movimenti
 *   cantina:{key}:ts_wines       → timestamp (ms) ultimo aggiornamento vini
 *   cantina:{key}:ts_movements   → timestamp (ms) ultimo aggiornamento movimenti
 */

const KV_URL   = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

/* Payload max consentito: 4MB (abbondante per metadati vini senza foto) */
const MAX_BYTES = 4 * 1024 * 1024;

/* ── Upstash Redis REST helpers ── */
async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) throw new Error(`KV GET ${r.status}`);
  const json = await r.json();
  return json.result !== null && json.result !== undefined ? json.result : null;
}

async function kvSet(key, value) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([value])
  });
  if (!r.ok) throw new Error(`KV SET ${r.status}`);
  return true;
}

/* ── Sanitizza la chiave utente (alfanumerica, max 64 car.) ── */
function sanitizeKey(k) {
  return String(k || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
}

/* ── Valida il nome dello store ── */
function validStore(s) {
  return s === 'wines' || s === 'movements';
}

/* ══════════════════ HANDLER PRINCIPALE ══════════════════ */
module.exports = async function handler(req, res) {
  /* CORS — permette richieste dal browser (stessa origin o CDN) */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Controlla configurazione KV */
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({
      error: 'KV non configurato. Crea un Vercel KV store e collegalo a questo progetto.'
    });
  }

  try {
    /* ────────────── GET ────────────── */
    if (req.method === 'GET') {
      const { key, store } = req.query;
      if (!key || !validStore(store)) {
        return res.status(400).json({ error: 'Parametri mancanti: key e store (wines|movements)' });
      }
      const sKey = sanitizeKey(key);
      if (!sKey) return res.status(400).json({ error: 'Chiave non valida' });

      const dataStr = await kvGet(`cantina:${sKey}:${store}`);
      const tsStr   = await kvGet(`cantina:${sKey}:ts_${store}`);

      return res.status(200).json({
        data: dataStr ? JSON.parse(dataStr) : [],
        ts:   tsStr   ? parseInt(tsStr, 10) : 0
      });
    }

    /* ────────────── POST ────────────── */
    if (req.method === 'POST') {
      /* Controlla dimensione payload */
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (rawBody.length > MAX_BYTES) {
        return res.status(413).json({ error: 'Payload troppo grande (max 4MB)' });
      }

      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { key, store, data, ts } = body || {};

      if (!key || !validStore(store) || !Array.isArray(data)) {
        return res.status(400).json({ error: 'Parametri mancanti: key, store, data[]' });
      }

      const sKey     = sanitizeKey(key);
      if (!sKey) return res.status(400).json({ error: 'Chiave non valida' });
      const timestamp = typeof ts === 'number' ? ts : Date.now();

      await kvSet(`cantina:${sKey}:${store}`,        JSON.stringify(data));
      await kvSet(`cantina:${sKey}:ts_${store}`,     String(timestamp));

      return res.status(200).json({ ok: true, ts: timestamp });
    }

    return res.status(405).json({ error: 'Metodo non supportato' });

  } catch (e) {
    console.error('[Cantina API]', e.message);
    return res.status(500).json({ error: 'Errore server: ' + e.message });
  }
};
