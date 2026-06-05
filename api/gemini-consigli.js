// api/gemini-consigli.js
// Vercel Serverless Function — proxy sicuro verso Google Gemini API (gratuita)
// La API key è salvata nelle Environment Variables di Vercel

module.exports = async function handler(req, res) {

  // Accetta solo POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Leggi la API key dalla variabile d'ambiente di Vercel
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key Gemini non configurata sul server. Registrati su https://aistudio.google.com/app/apikeys' });
  }

  try {
    const { system, messages, max_tokens } = req.body;

    // Combina system prompt con il messaggio dell'utente per Gemini
    const userMessage = messages[0]?.content || '';
    const fullPrompt = system ? `${system}\n\n${userMessage}` : userMessage;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: fullPrompt,
              }
            ],
          }
        ],
        generationConfig: {
          maxOutputTokens: max_tokens || 2500,  // Aumentato da 1000 a 2500
          temperature: 0.1,
          topP: 0.95,
          topK: 40,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    // Converti la risposta Gemini nel formato atteso dall'app (stesso di Claude)
    let geminiText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    
    // Pulizia: estrai JSON se Gemini ha aggiunto testo prima/dopo
    if (geminiText && !geminiText.trim().startsWith('{')) {
      const jsonMatch = geminiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        geminiText = jsonMatch[0];
      }
    }
    
    // Rimuovi markdown backticks se presenti
    geminiText = geminiText.replace(/```json\n?|\n?```/g, '').trim();
    
    // Crea una risposta nello stesso formato di Claude per uniformità
    const claudeFormatResponse = {
      content: [
        {
          type: 'text',
          text: geminiText,
        }
      ],
    };

    return res.status(200).json(claudeFormatResponse);

  } catch (err) {
    console.error('[api/gemini-consigli]', err);
    return res.status(500).json({ error: 'Errore interno: ' + err.message });
  }
}
