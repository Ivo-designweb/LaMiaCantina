// api/email-reminder.js
// Vercel Serverless Function
// Controlla i vini in scadenza per una data chiave di sincronizzazione
// e invia una mail via Resend se necessario.
// Chiamata dal cron job (api/cron-reminder.js) o manualmente via POST.

module.exports = async function handler(req, res) {

  // Solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY non configurata' });
  }

  const UPSTASH_URL   = process.env.UPSTASH_URL;
  const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: 'Credenziali Upstash non configurate' });
  }

  // Autenticazione:
  // 1) Chiamata dal cron interno (nessuna syncKey nel body) → sempre accettata
  // 2) Chiamata dall'app (test) → body contiene syncKey valida verificata su Upstash
  const { syncKey: bodySyncKey } = req.body || {};
  const isInternalCall = !bodySyncKey; // chiamata dal cron senza syncKey
  const isAppCall      = !!bodySyncKey;

  if (!isInternalCall && !isAppCall) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }

  // Se chiamata dall'app, verifica che la syncKey esista su Upstash
  if (isAppCall) {
    try {
      const check = await redisCmd(UPSTASH_URL, UPSTASH_TOKEN, 'EXISTS', `cantina:${bodySyncKey}:wines`);
      if (!check) {
        return res.status(401).json({ error: 'Chiave di sincronizzazione non valida' });
      }
    } catch (e) {
      return res.status(500).json({ error: 'Verifica chiave fallita: ' + e.message });
    }
  }

  // Body: { syncKey } oppure vuoto per processare tutte le chiavi attive
  const { syncKey } = req.body || {};

  try {
    let results = [];

    if (syncKey) {
      // Processa solo una chiave specifica
      const r = await processKey(syncKey, UPSTASH_URL, UPSTASH_TOKEN, RESEND_API_KEY);
      results.push({ syncKey, ...r });
    } else {
      // Scansiona tutte le chiavi con email_config attiva
      const keys = await scanAllEmailConfigs(UPSTASH_URL, UPSTASH_TOKEN);
      for (const key of keys) {
        const r = await processKey(key, UPSTASH_URL, UPSTASH_TOKEN, RESEND_API_KEY);
        results.push({ syncKey: key, ...r });
      }
    }

    return res.status(200).json({ ok: true, processed: results.length, results });

  } catch (err) {
    console.error('[email-reminder]', err);
    return res.status(500).json({ error: 'Errore interno: ' + err.message });
  }
};

/* ── Upstash REST helper ── */
async function redisCmd(upstashUrl, upstashToken, ...args) {
  const r = await fetch(upstashUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + upstashToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error('Redis ' + r.status + ': ' + await r.text());
  return (await r.json()).result;
}

async function redisPipe(upstashUrl, upstashToken, cmds) {
  const r = await fetch(upstashUrl + '/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + upstashToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('Pipeline ' + r.status + ': ' + await r.text());
  return await r.json();
}

/* ── Trova tutte le chiavi con email_config ── */
async function scanAllEmailConfigs(upstashUrl, upstashToken) {
  const keys = [];
  let cursor = '0';
  do {
    const result = await redisCmd(upstashUrl, upstashToken, 'SCAN', cursor, 'MATCH', 'cantina:*:email_config', 'COUNT', '100');
    cursor = result[0];
    const found = result[1] || [];
    // Estrae la syncKey da "cantina:{key}:email_config"
    for (const k of found) {
      const m = k.match(/^cantina:(.+):email_config$/);
      if (m) keys.push(m[1]);
    }
  } while (cursor !== '0');
  return keys;
}

/* ── Processa una singola chiave ── */
async function processKey(syncKey, upstashUrl, upstashToken, resendApiKey) {

  // Legge email_config e lista vini in parallelo
  const pipe = await redisPipe(upstashUrl, upstashToken, [
    ['GET', `cantina:${syncKey}:email_config`],
    ['GET', `cantina:${syncKey}:wines`]
  ]);

  const configStr = pipe[0]?.result;
  const winesStr  = pipe[1]?.result;

  if (!configStr) return { skipped: true, reason: 'email_config non trovata' };

  let config;
  try { config = JSON.parse(configStr); } catch { return { skipped: true, reason: 'email_config non valida' }; }

  if (!config.enabled)  return { skipped: true, reason: 'reminder disabilitato' };
  if (!config.email)    return { skipped: true, reason: 'email non configurata' };

  // Controlla se è passato abbastanza tempo dall'ultimo invio
  const checkEveryDays = parseInt(config.checkEveryDays) || 7;
  if (config.lastSentAt) {
    const last = new Date(config.lastSentAt);
    const diffDays = (Date.now() - last.getTime()) / 86400000;
    if (diffDays < checkEveryDays) {
      return { skipped: true, reason: `troppo presto (${Math.round(diffDays)} / ${checkEveryDays} giorni)` };
    }
  }

  // Filtra vini in scadenza
  let wines = [];
  try { wines = JSON.parse(winesStr || '[]'); } catch { wines = []; }

  const thresh    = parseInt(config.scadenzaGiorni) || 60;
  const oggi      = new Date(); oggi.setHours(0, 0, 0, 0);

  const scaduti   = wines.filter(w => {
    if (!w.datalimite || w.assaggiato === true) return false;
    return new Date(w.datalimite) < oggi;
  }).sort((a, b) => new Date(a.datalimite) - new Date(b.datalimite));

  const scadenti  = wines.filter(w => {
    if (!w.datalimite || w.assaggiato === true) return false;
    const d    = new Date(w.datalimite);
    const diff = (d - oggi) / 86400000;
    return diff >= 0 && diff <= thresh;
  }).sort((a, b) => new Date(a.datalimite) - new Date(b.datalimite));

  if (scaduti.length === 0 && scadenti.length === 0) {
    return { skipped: true, reason: 'nessun vino in scadenza' };
  }

  // Compone la mail
  const html = buildEmailHtml(scaduti, scadenti, thresh);
  const text = buildEmailText(scaduti, scadenti, thresh);

  // Invia via Resend
  const mailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + resendApiKey,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      from:    'La Mia Cantina <onboarding@resend.dev>',
      to:      [config.email],
      subject: `🍷 La Mia Cantina — ${scaduti.length + scadenti.length} vino/i da controllare`,
      html,
      text
    })
  });

  if (!mailRes.ok) {
    const err = await mailRes.text();
    console.error('[email-reminder] Resend error:', err);
    return { sent: false, error: 'Resend: ' + err };
  }

  // Aggiorna lastSentAt su Upstash
  config.lastSentAt = new Date().toISOString();
  await redisCmd(upstashUrl, upstashToken, 'SET', `cantina:${syncKey}:email_config`, JSON.stringify(config));

  return { sent: true, to: config.email, scaduti: scaduti.length, scadenti: scadenti.length };
}

/* ── Formattazione data leggibile ── */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' });
}

/* ── Costruisce il corpo HTML della mail ── */
function buildEmailHtml(scaduti, scadenti, thresh) {
  let rows = '';

  if (scaduti.length > 0) {
    rows += `
      <tr><td colspan="3" style="background:#8B1A2E;color:#fff;padding:8px 12px;font-size:13px;font-weight:bold;border-radius:6px 6px 0 0">
        ⚠️ ${scaduti.length} vino/i oltre la data limite
      </td></tr>`;
    for (const w of scaduti) {
      const giorni = Math.abs(Math.ceil((new Date(w.datalimite) - new Date()) / 86400000));
      rows += `<tr style="border-bottom:1px solid #EDE4D6">
        <td style="padding:8px 12px;font-size:13px;color:#1E0E06">${w.cantina || '—'}</td>
        <td style="padding:8px 12px;font-size:13px;color:#1E0E06">${w.nome || '—'}</td>
        <td style="padding:8px 12px;font-size:12px;color:#8B1A2E;white-space:nowrap">Scaduto da ${giorni} gg</td>
      </tr>`;
    }
  }

  if (scadenti.length > 0) {
    rows += `
      <tr><td colspan="3" style="background:#8B5A1A;color:#fff;padding:8px 12px;font-size:13px;font-weight:bold">
        🕐 ${scadenti.length} vino/i in scadenza entro ${thresh} giorni
      </td></tr>`;
    for (const w of scadenti) {
      const diff = Math.ceil((new Date(w.datalimite) - new Date()) / 86400000);
      rows += `<tr style="border-bottom:1px solid #EDE4D6">
        <td style="padding:8px 12px;font-size:13px;color:#1E0E06">${w.cantina || '—'}</td>
        <td style="padding:8px 12px;font-size:13px;color:#1E0E06">${w.nome || '—'}</td>
        <td style="padding:8px 12px;font-size:12px;color:#8B5A1A;white-space:nowrap">${fmtDate(w.datalimite)} (${diff} gg)</td>
      </tr>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="it">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F4EDE2;font-family:Georgia,serif">
  <div style="max-width:520px;margin:32px auto;background:#FDFAF5;border-radius:14px;overflow:hidden;box-shadow:0 4px 20px rgba(100,60,20,.15)">
    <div style="background:linear-gradient(135deg,#8B1A2E,#6A1020);padding:28px 28px 20px;text-align:center">
      <div style="font-size:32px;margin-bottom:8px">🍷</div>
      <div style="font-family:Georgia,serif;font-size:22px;color:#F4EDE2;letter-spacing:2px;text-transform:uppercase">La Mia Cantina</div>
      <div style="font-size:13px;color:rgba(244,237,226,.7);margin-top:4px">Promemoria Scadenze</div>
    </div>
    <div style="padding:24px 28px">
      <p style="font-size:14px;color:#6A4A2A;margin-bottom:20px;line-height:1.6">
        Ecco il riepilogo dei vini che richiedono la tua attenzione:
      </p>
      <table style="width:100%;border-collapse:collapse;border-radius:8px;overflow:hidden;border:1px solid #CDBFA8">
        <thead>
          <tr style="background:#EDE4D6">
            <th style="padding:8px 12px;font-size:11px;color:#6A4A2A;text-align:left;letter-spacing:1px;text-transform:uppercase">Cantina</th>
            <th style="padding:8px 12px;font-size:11px;color:#6A4A2A;text-align:left;letter-spacing:1px;text-transform:uppercase">Vino</th>
            <th style="padding:8px 12px;font-size:11px;color:#6A4A2A;text-align:left;letter-spacing:1px;text-transform:uppercase">Scadenza</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="font-size:12px;color:#B09070;margin-top:20px;line-height:1.5">
        Apri l'app per gestire la tua cantina e aggiornare le date di consumo.
      </p>
    </div>
    <div style="background:#EDE4D6;padding:14px 28px;text-align:center;font-size:11px;color:#B09070">
      La Mia Cantina · Promemoria automatico<br>
      Per disabilitare vai su Impostazioni → Promemoria Email
    </div>
  </div>
</body>
</html>`;
}

/* ── Costruisce il corpo testo plain della mail ── */
function buildEmailText(scaduti, scadenti, thresh) {
  let txt = '🍷 LA MIA CANTINA — Promemoria Scadenze\n\n';
  if (scaduti.length > 0) {
    txt += `⚠️ VINI OLTRE LA DATA LIMITE (${scaduti.length}):\n`;
    for (const w of scaduti) {
      const g = Math.abs(Math.ceil((new Date(w.datalimite) - new Date()) / 86400000));
      txt += `  • ${w.cantina} — ${w.nome} (scaduto da ${g} gg)\n`;
    }
    txt += '\n';
  }
  if (scadenti.length > 0) {
    txt += `🕐 VINI IN SCADENZA ENTRO ${thresh} GIORNI (${scadenti.length}):\n`;
    for (const w of scadenti) {
      const diff = Math.ceil((new Date(w.datalimite) - new Date()) / 86400000);
      txt += `  • ${w.cantina} — ${w.nome} (${fmtDate(w.datalimite)}, ${diff} gg)\n`;
    }
  }
  txt += '\nApri La Mia Cantina per gestire la tua cantina.\nPer disabilitare: Impostazioni → Promemoria Email';
  return txt;
}
