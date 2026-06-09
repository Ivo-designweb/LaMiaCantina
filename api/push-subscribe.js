// api/push-subscribe.js
// Salva o rimuove la subscription Web Push per una syncKey su Upstash.
// Chiamata dal browser quando l'utente attiva/disattiva le notifiche push.

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const UPSTASH_URL   = process.env.UPSTASH_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'Credenziali Upstash non configurate' });
  }

  const { syncKey, subscription, action } = req.body || {};
  // action: 'subscribe' | 'unsubscribe'

  if (!syncKey) return res.status(400).json({ error: 'syncKey mancante' });

  // Verifica che la syncKey esista su Upstash
  try {
    const exists = await redisCmd(UPSTASH_URL, UPSTASH_TOKEN, 'EXISTS', `cantina:${syncKey}:wines`);
    if (!exists) return res.status(401).json({ error: 'Chiave non valida' });
  } catch (e) {
    return res.status(500).json({ error: 'Verifica chiave: ' + e.message });
  }

  try {
    if (action === 'unsubscribe') {
      await redisCmd(UPSTASH_URL, UPSTASH_TOKEN, 'DEL', `cantina:${syncKey}:push_subscription`);
      return res.status(200).json({ ok: true, action: 'unsubscribed' });
    }

    if (!subscription) return res.status(400).json({ error: 'subscription mancante' });
    await redisCmd(UPSTASH_URL, UPSTASH_TOKEN, 'SET',
      `cantina:${syncKey}:push_subscription`,
      JSON.stringify(subscription)
    );
    return res.status(200).json({ ok: true, action: 'subscribed' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

async function redisCmd(url, token, ...args) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + await r.text());
  return (await r.json()).result;
}
