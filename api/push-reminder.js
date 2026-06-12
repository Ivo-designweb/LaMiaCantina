// api/push-reminder.js
// Invia notifiche push Web Push a tutti i dispositivi iscritti
// con vini in scadenza. Chiamato dal cron job.

const webpush = require('web-push');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { syncKey: bodySyncKey } = req.body || {};
  const isInternalCall = !bodySyncKey; // chiamata dal cron senza syncKey
  const isAppCall      = !!bodySyncKey;

  const UPSTASH_URL    = process.env.UPSTASH_URL;
  const UPSTASH_TOKEN  = process.env.UPSTASH_TOKEN;
  const VAPID_PUBLIC   = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE  = process.env.VAPID_PRIVATE_KEY;
  const VAPID_EMAIL    = process.env.VAPID_EMAIL || 'mailto:noreply@lamiacantina.app';

  if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: 'Upstash non configurato' });
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return res.status(500).json({ error: 'VAPID keys non configurate' });

  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);

  // Verifica syncKey se chiamata dall'app
  if (isAppCall) {
    try {
      const check = await redisCmd(UPSTASH_URL, UPSTASH_TOKEN, 'EXISTS', `cantina:${bodySyncKey}:wines`);
      if (!check) return res.status(401).json({ error: 'Chiave non valida' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    let keys = [];
    if (bodySyncKey) {
      keys = [bodySyncKey];
    } else {
      keys = await scanAllPushSubscriptions(UPSTASH_URL, UPSTASH_TOKEN);
    }

    const results = [];
    for (const key of keys) {
      const r = await processPushKey(key, UPSTASH_URL, UPSTASH_TOKEN);
      results.push({ syncKey: key, ...r });
    }

    return res.status(200).json({ ok: true, processed: results.length, results });

  } catch (err) {
    console.error('[push-reminder]', err);
    return res.status(500).json({ error: err.message });
  }

  async function processPushKey(syncKey, upstashUrl, upstashToken) {
    // Legge subscription, email_config e wines in parallelo
    const pipe = await redisPipe(upstashUrl, upstashToken, [
      ['GET', `cantina:${syncKey}:push_subscription`],
      ['GET', `cantina:${syncKey}:email_config`],
      ['GET', `cantina:${syncKey}:wines`]
    ]);

    const subStr    = pipe[0]?.result;
    const cfgStr    = pipe[1]?.result;
    const winesStr  = pipe[2]?.result;

    if (!subStr)  return { skipped: true, reason: 'nessuna subscription push' };
    if (!cfgStr)  return { skipped: true, reason: 'email_config non trovata' };

    let sub, cfg;
    try { sub = JSON.parse(subStr); } catch { return { skipped: true, reason: 'subscription non valida' }; }
    try { cfg = JSON.parse(cfgStr); } catch { return { skipped: true, reason: 'config non valida' }; }

    if (!cfg.pushEnabled) return { skipped: true, reason: 'push disabilitato' };

    // Controlla frequenza
    const checkEveryDays = parseInt(cfg.checkEveryDays) || 7;
    if (cfg.lastPushSentAt) {
      const diffDays = (Date.now() - new Date(cfg.lastPushSentAt).getTime()) / 86400000;
      if (diffDays < checkEveryDays) {
        return { skipped: true, reason: `troppo presto (${Math.round(diffDays)}/${checkEveryDays} gg)` };
      }
    }

    // Filtra vini in scadenza
    let wines = [];
    try { wines = JSON.parse(winesStr || '[]'); } catch {}

    const thresh  = parseInt(cfg.scadenzaGiorni) || 60;
    const oggi    = new Date(); oggi.setHours(0, 0, 0, 0);
    const scaduti = wines.filter(w => w.datalimite && w.assaggiato !== true && new Date(w.datalimite) < oggi);
    const scadenti = wines.filter(w => {
      if (!w.datalimite || w.assaggiato === true) return false;
      const diff = (new Date(w.datalimite) - oggi) / 86400000;
      return diff >= 0 && diff <= thresh;
    });

    if (scaduti.length === 0 && scadenti.length === 0) {
      return { skipped: true, reason: 'nessun vino in scadenza' };
    }

    // Compone il payload push
    const total = scaduti.length + scadenti.length;
    let body = '';
    if (scaduti.length > 0)  body += `⚠️ ${scaduti.length} vino/i oltre la data limite. `;
    if (scadenti.length > 0) body += `🕐 ${scadenti.length} vino/i in scadenza entro ${thresh} giorni.`;

    const payload = JSON.stringify({
      title: `🍷 La Mia Cantina — ${total} vino/i da controllare`,
      body:  body.trim(),
      icon:  '/icon192.png',
      badge: '/icon192.png',
      data:  { url: '/', scaduti: scaduti.length, scadenti: scadenti.length }
    });

    try {
      await webpush.sendNotification(sub, payload);

      // Aggiorna lastPushSentAt
      cfg.lastPushSentAt = new Date().toISOString();
      await redisCmd(upstashUrl, upstashToken, 'SET', `cantina:${syncKey}:email_config`, JSON.stringify(cfg));

      return { sent: true, scaduti: scaduti.length, scadenti: scadenti.length };

    } catch (e) {
      // Se la subscription è scaduta (410), la elimina e segna che serve rinnovo
      if (e.statusCode === 410) {
        await redisCmd(upstashUrl, upstashToken, 'DEL', `cantina:${syncKey}:push_subscription`);
        await redisCmd(upstashUrl, upstashToken, 'SET', `cantina:${syncKey}:push_needs_refresh`, '1');
        return { skipped: true, reason: 'subscription scaduta, rimossa' };
      }
      return { sent: false, error: e.message };
    }
  }
};

async function scanAllPushSubscriptions(upstashUrl, upstashToken) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await redisCmd(upstashUrl, upstashToken, 'SCAN', cursor, 'MATCH', 'cantina:*:push_subscription', 'COUNT', '100');
    cursor = result[0];
    for (const k of (result[1] || [])) {
      const m = k.match(/^cantina:(.+):push_subscription$/);
      if (m) keys.push(m[1]);
    }
  } while (cursor !== '0');
  return keys;
}

async function redisCmd(url, token, ...args) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + await r.text());
  return (await r.json()).result;
}

async function redisPipe(url, token, cmds) {
  const r = await fetch(url + '/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('Pipeline ' + r.status + ': ' + await r.text());
  return await r.json();
}
