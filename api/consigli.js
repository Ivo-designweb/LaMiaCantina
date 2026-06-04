// api/consigli.js
// Vercel Serverless Function — proxy sicuro verso Anthropic API
// La API key è salvata nelle Environment Variables di Vercel, mai nel sorgente.

export default async function handler(req, res) {

  // Accetta solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Leggi la API key dalla variabile d'ambiente di Vercel
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key non configurata sul server' });
  }

  try {
    const { system, messages, model, max_tokens } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify({
        model:      model      || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system,
        messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    return res.status(200).json(data);

  } catch (err) {
    console.error('[api/consigli]', err);
    return res.status(500).json({ error: 'Errore interno: ' + err.message });
  }
}
