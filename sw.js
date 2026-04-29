/* ═══════════════════════════════════════════════════
   La Mia Cantina — Service Worker

   ⚠️  REGOLA: aggiorna CACHE_VERSION ad ogni release,
       mantenendola ALLINEATA con la versione mostrata
       in index.html (es. v4.6 → 'cantina-v4.8').

   Strategia di aggiornamento:
   - Il nuovo SW si installa in background senza
     interrompere la sessione in corso.
   - Diventa attivo solo alla prossima apertura dell'app
     (oppure se l'utente preme "Aggiorna ora").
   - L'app funziona sempre offline: cache-first per
     tutti gli asset, nessun blocco senza connessione.
═══════════════════════════════════════════════════ */

const CACHE_VERSION = 'cantina-v4.8';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700;800&family=Lora:ital,wght@0,400;0,600;1,400&display=swap'
];

/* ── Install: pre-cache degli asset, NON forza attivazione immediata ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(ASSETS).catch(() => {}))
    /* Niente self.skipWaiting(): il nuovo SW aspetta che
       l'utente chiuda/riapra l'app o prema "Aggiorna ora". */
  );
});

/* ── Activate: rimuove cache vecchie, NON reclama tab aperte ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION)
          .map(k => caches.delete(k))
      )
    )
    /* Niente self.clients.claim(): le tab aperte continuano
       con il vecchio SW fino alla prossima apertura volontaria. */
  );
});

/* ── Fetch: cache-first, fallback rete, fallback offline ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.startsWith('chrome-extension://')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (!response || response.status !== 200 || response.type === 'opaque') {
            return response;
          }
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
          return response;
        })
        .catch(() => {
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
    })
  );
});

/* ── Message: skipWaiting solo su richiesta esplicita dell'utente ── */
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
