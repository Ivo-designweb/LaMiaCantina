// api/cron-reminder.js
// Vercel Cron Job — gira ogni giorno alle 08:00 UTC (10:00 ora italiana)
// Accetta anche GET con x-cron-secret per trigger manuale dal browser.

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret   = process.env.CRON_SECRET;
  const manualSecret = req.headers['x-cron-secret'];

  if (!isVercelCron && manualSecret !== cronSecret) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  // SITE_URL ha priorità, poi VERCEL_URL, poi fallback hardcoded
  const baseUrl = process.env.SITE_URL
    || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://lamiacantina.vercel.app');

  const headers = {
    'Content-Type':  'application/json',
    'x-cron-secret': cronSecret || ''
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
