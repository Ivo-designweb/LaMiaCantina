// api/cron-reminder.js
// Vercel Cron Job — gira ogni giorno alle 08:00 UTC (10:00 ora italiana)
// Chiama email-reminder per processare tutte le chiavi attive.
// Configurato in vercel.json nella sezione "crons".

module.exports = async function handler(req, res) {

  // Vercel chiama i cron job con GET — accettiamo solo GET
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verifica che la chiamata venga da Vercel Cron (header automatico)
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret   = process.env.CRON_SECRET;
  const manualSecret = req.headers['x-cron-secret'];

  if (!isVercelCron && manualSecret !== cronSecret) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  try {
    // Chiama la funzione email-reminder per processare tutte le chiavi
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'http://localhost:3000';

    const response = await fetch(`${baseUrl}/api/email-reminder`, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-cron-secret':   cronSecret || ''
      },
      body: JSON.stringify({}) // body vuoto = processa tutte le chiavi
    });

    const data = await response.json();
    console.log('[cron-reminder] risultato:', JSON.stringify(data));

    return res.status(200).json({ ok: true, ...data });

  } catch (err) {
    console.error('[cron-reminder] errore:', err);
    return res.status(500).json({ error: err.message });
  }
};
