# La Mia Cantina

App PWA (HTML + JavaScript vanilla) per l'archivio personale dei vini acquistati. Deploy su Vercel.

## Struttura del progetto

- `index.html` — app principale (single file, HTML/CSS/JS inline). Contiene UI, logica, gestione dati via IndexedDB (`DB_NAME`, `DB_VERSION`).
- `manual.html` — manuale utente.
- `manifest.json` — manifest PWA (icone, tema, nome app).
- `sw.js` — service worker (cache offline, aggiornamenti).
- `api/` — funzioni serverless Vercel:
  - `consigli.js`, `claude-consigli.js`, `gemini-consigli.js` — consigli AI sui vini (integrazioni Claude/Gemini).
  - `push-subscribe.js`, `push-reminder.js`, `cron-reminder.js`, `email-reminder.js` — notifiche push/email e reminder schedulati (vedi `vercel.json` per il cron).
- `vercel.json` — configurazione cron job Vercel.
- `Vino.webp`, `icon192.png`, `icon512.png` — asset immagine.

## Dati utente

I dati (vini, movimenti) vivono in **IndexedDB nel browser**, non nel file HTML. Aggiornare l'app (nuovo file `index.html`) non cancella i dati se aperto nello stesso browser. Consigliare sempre un backup JSON prima di aggiornamenti importanti (vedi funzione di export, versione dati `4.0`).

## Regole di versioning (obbligatorie)

Ogni volta che modifichi `index.html` (o altri file HTML dell'app):

1. **Incrementa la versione di 0.1** (es. v8.5 → v8.6). In `index.html` la versione compare in due punti da tenere allineati:
   - `#header-version-label` (span `.header-ver`, riga vicino a "La Mia Cantina")
   - `#app-version-label` nel drawer (`.drawer-version`)
2. Se è presente una **pagina/sezione impostazioni**, aggiorna il numero di versione anche lì.
3. Nella sezione impostazioni/drawer deve **sempre comparire in fondo**: "Contatta lo sviluppatore:" con email `ivotaffarel@gmail.com` cliccabile (`mailto:`). Non rimuovere questo blocco (già presente nel drawer e nell'admin overlay).

## Prima di sviluppare

Se una richiesta è ambigua o ci sono più modi ragionevoli di implementarla, **fai sempre domande prima di iniziare** invece di assumere.

## Convenzioni

- Linguaggio dell'app e dei commit: italiano per contenuti/testi rivolti all'utente; commit message anche in italiano va bene.
- Preferire modifiche dirette a `index.html` invece di introdurre build step/framework: l'app resta volutamente single-file HTML/JS.
- Non aggiungere dipendenze esterne pesanti senza necessità reale.
