// api/cron-reminder.js
// Vercel Cron Job — gira ogni giorno alle 08:00 UTC (10:00 ora italiana)
// Autenticazione:
//   - Vercel cron automatico: User-Agent vercel-cron/1.0
//   - Trigger manuale dal browser: query param ?syncKey=xxx (verificato su Upstash)

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userAgent = req.headers['user-agent'] || '';
  const isVercelCron = userAgent.includes('vercel-cron');
  const syncKey = req.query.syncKey;

  // Accetta: cron automatico Vercel OPPURE chiamata manuale con syncKey
  if (!isVercelCron && !syncKey) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  // Verifica syncKey su Upstash se chiamata manuale
  if (!isVercelCron && syncKey) {
    const UPSTASH_URL   = process.env.UPSTASH_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
    if (UPSTASH_URL && UPSTASH_TOKEN) {
      try {
        const r = await fetch(UPSTASH_URL, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + UPSTASH_TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify(['EXISTS', `cantina:${syncKey}:wines`])
        });
        const data = await r.json();
        if (!data.result) return res.status(401).json({ error: 'Chiave sync non valida' });
      } catch (e) {
        return res.status(500).json({ error: 'Verifica chiave: ' + e.message });
      }
    }
  }

  // SITE_URL ha priorità, poi fallback hardcoded
  const baseUrl = process.env.SITE_URL || 'https://lamiacantina.vercel.app';

  // Le chiamate interne non richiedono autenticazione aggiuntiva
  const headers = {
    'Content-Type': 'application/json'
  };

  try {
    const [emailRes, pushRes] = await Promise.allSettled([
      fetch(`${baseUrl}/api/email-reminder`, { method: 'POST', headers, body: '{}' }),
      fetch(`${baseUrl}/api/push-reminder`,  { method: 'POST', headers, body: '{}' })
    ]);

    const emailData = emailRes.status === 'fulfilled'
      ? await emailRes.value.json()
      : { error: emailRes.reason?.message };
    const pushData = pushRes.status === 'fulfilled'
      ? await pushRes.value.json()
      : { error: pushRes.reason?.message };

    console.log('[cron-reminder] email:', JSON.stringify(emailData));
    console.log('[cron-reminder] push:',  JSON.stringify(pushData));

    return res.status(200).json({ ok: true, baseUrl, email: emailData, push: pushData });

  } catch (err) {
    console.error('[cron-reminder] errore:', err);
    return res.status(500).json({ error: err.message });
  }
};
