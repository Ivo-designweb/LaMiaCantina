// api/cron-reminder.js
// Vercel Cron Job — gira ogni giorno alle 08:00 UTC (10:00 ora italiana)
// Chiama email-reminder e push-reminder per processare tutte le chiavi attive.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret   = process.env.CRON_SECRET;
  const manualSecret = req.headers['x-cron-secret'];

  if (!isVercelCron && manualSecret !== cronSecret) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  const headers = {
    'Content-Type':  'application/json',
    'x-cron-secret': cronSecret || ''
  };

  try {
    // Esegue email e push in parallelo
    const [emailRes, pushRes] = await Promise.allSettled([
      fetch(`${baseUrl}/api/email-reminder`, { method: 'POST', headers, body: '{}' }),
      fetch(`${baseUrl}/api/push-reminder`,  { method: 'POST', headers, body: '{}' })
    ]);

    const emailData = emailRes.status === 'fulfilled' ? await emailRes.value.json() : { error: emailRes.reason?.message };
    const pushData  = pushRes.status  === 'fulfilled' ? await pushRes.value.json()  : { error: pushRes.reason?.message };

    console.log('[cron-reminder] email:', JSON.stringify(emailData));
    console.log('[cron-reminder] push:', JSON.stringify(pushData));

    return res.status(200).json({ ok: true, email: emailData, push: pushData });

  } catch (err) {
    console.error('[cron-reminder]', err);
    return res.status(500).json({ error: err.message });
  }
};
