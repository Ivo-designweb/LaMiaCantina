/**
/**
 * La Mia Cantina — Cloud Sync API  v1.1
 * Vercel Serverless Function (Node.js 18+)
 * Database: Upstash Redis (via Vercel Marketplace o diretto)
 *
 * SETUP (una tantum):
 *   OPZIONE A — Vercel Marketplace:
 *     1. vercel.com → progetto → Integrations → cerca "Upstash Redis"
 *     2. Installa → crea database → collega al progetto
 *     3. Vercel inietta automaticamente le env vars
 *
 *   OPZIONE B — Upstash diretto:
 *     1. upstash.com → New Database → Redis → region EU-West
 *     2. Copia REST API URL e Token
 *     3. Vercel → Settings → Environment Variables:
 *          UPSTASH_REDIS_REST_URL   = https://xxx.upstash.io
 *          UPSTASH_REDIS_REST_TOKEN = AXxx...
 *
 * Endpoints:
 *   GET  /api/db?key=CHIAVE&store=wines|movements  → {data:[], ts:number}
 *   POST /api/db  body:{key, store, data:[], ts}   → {ok:true, ts:number}
 *
 * Struttura Redis:
 *   cantina:{key}:wines       → JSON string array vini (senza foto)
 *   cantina:{key}:movements   → JSON string array movimenti
 *   cantina:{key}:ts_wines    → timestamp ms
 *   cantina:{key}:ts_movements→ timestamp ms
 */

/* Supporta sia le env vars di Vercel Marketplace che quelle manuali */
const KV_URL   = process.env.UPSTASH_REDIS_REST_URL
               || process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
               || process.env.KV_REST_API_TOKEN;

const MAX_BYTES = 4 * 1024 * 1024; /* 4 MB — abbondante senza foto */

/* ──────────────────────────────────────────
   Upstash Redis REST — formato comando Redis
   POST / con body ["CMD", "arg1", "arg2"]
   ────────────────────────────────────────── */
async function redisCmd(...args) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => r.status);
    throw new Error(`Redis ${r.status}: ${txt}`);
  }
  const json = await r.json();
  return json.result;          /* null | string | number | "OK" */
}

/* Batch: esegue più comandi in una sola chiamata HTTP */
async function redisPipeline(commands) {
  const r = await fetch(`${KV_URL}/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KV_TOKEN}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify(commands)
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => r.status);
    throw new Error(`Redis pipeline ${r.status}: ${txt}`);
  }
  return await r.json();       /* array di {result} */
}

/* ── Sanitizza chiave utente (solo alfanumerici + _ -, max 64) ── */
function sanitizeKey(k) {
  return String(k || '').replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
}

function validStore(s) {
  return s === 'wines' || s === 'movements';
}

/* ══════════════════════════════════════════
   HANDLER PRINCIPALE
   ══════════════════════════════════════════ */
module.exports = async function handler(req, res) {
  /* CORS */
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  /* Controlla configurazione */
  if (!KV_URL || !KV_TOKEN) {
    return res.status(503).json({
      error: 'Upstash non configurato. Aggiungi UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN nelle env vars di Vercel.'
    });
  }

  try {

    /* ────────── GET ────────── */
    if (req.method === 'GET') {
      const { key, store } = req.query;
      if (!key || !validStore(store))
        return res.status(400).json({ error: 'Parametri mancanti: key, store' });

      const sKey = sanitizeKey(key);
      if (!sKey) return res.status(400).json({ error: 'Chiave non valida' });

      /* Legge dati e timestamp in parallelo */
      const [dataStr, tsStr] = await Promise.all([
        redisCmd('GET', `cantina:${sKey}:${store}`),
        redisCmd('GET', `cantina:${sKey}:ts_${store}`)
      ]);

      return res.status(200).json({
        data: dataStr ? JSON.parse(dataStr) : [],
        ts:   tsStr   ? parseInt(tsStr, 10) : 0
      });
    }

    /* ────────── POST ────────── */
    if (req.method === 'POST') {
      const rawBody = typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body);

      if (rawBody.length > MAX_BYTES)
        return res.status(413).json({ error: 'Payload troppo grande (max 4MB)' });

      const body = typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;

      const { key, store, data, ts } = body || {};

      if (!key || !validStore(store) || !Array.isArray(data))
        return res.status(400).json({ error: 'Parametri mancanti: key, store, data[]' });

      const sKey      = sanitizeKey(key);
      if (!sKey) return res.status(400).json({ error: 'Chiave non valida' });
      const timestamp = typeof ts === 'number' ? ts : Date.now();

      /* Scrive dati e timestamp in un unico batch */
      await redisPipeline([
        ['SET', `cantina:${sKey}:${store}`,       JSON.stringify(data)],
        ['SET', `cantina:${sKey}:ts_${store}`,    String(timestamp)]
      ]);

      return res.status(200).json({ ok: true, ts: timestamp });
    }

    return res.status(405).json({ error: 'Metodo non supportato' });

  } catch (e) {
    console.error('[Cantina API]', e.message);
    return res.status(500).json({ error: 'Errore server: ' + e.message });
  }
};
