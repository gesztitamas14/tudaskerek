// Service worker: az alkalmazás offline is elinduljon és játszható legyen.
//
// Stratégia:
//   * App shell (HTML, CSS, JS, ikonok, kérdésbank) → precache telepítéskor,
//     majd „stale-while-revalidate”: azonnal a cache-ből szolgálunk ki, és a
//     háttérben frissítünk. Így offline is működik, online viszont nem ragad be
//     egy régi verzióba.
//   * A Supabase API hívások SOHA nem cache-elődnek: azok élő adatot adnak, és
//     hitelesítést használnak. Ezeket egyszerűen átengedjük a hálózatra.
//
// A CACHE_VERSION növelésével minden régi cache törlődik. A `build:seed`
// futtatása után érdemes emelni, ha a kérdésbank változott.

const CACHE_VERSION = 'tudaskerek-v9';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './seed-questions.json',
  './js/app.js',
  './js/api.js',
  './js/config.js',
  './js/game-screen.js',
  './js/multiplayer.js',
  './js/picker.js',
  './js/sound.js',
  './js/rules.js',
  './js/screens.js',
  './js/store.js',
  './js/ui.js',
  './js/wheel.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // Egyenként adjuk hozzá: ha egy fájl hiányzik, ne dőljön el az egész
      // telepítés (pl. még nem generált ikon).
      await Promise.all(
        PRECACHE.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] nem cache-elhető:', url, error.message);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Csak GET-et cache-elünk, és csak a saját origin-ünkről.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Supabase és egyéb API: átengedjük

  // Navigáció (címsor, home screen indítás): offline is az index.html jöjjön.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_VERSION);
          cache.put('./index.html', response.clone());
          return response;
        } catch {
          const cached = await caches.match('./index.html');
          return cached ?? new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })()
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(request);

      // stale-while-revalidate
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) cache.put(request, response.clone());
          return response;
        })
        .catch(() => null);

      if (cached) {
        // A frissítés a háttérben fut, a válasz azonnal jön a cache-ből.
        network.catch(() => {});
        return cached;
      }

      const response = await network;
      return (
        response ??
        new Response('Offline és nincs cache-elt változat.', {
          status: 504,
          statusText: 'Offline'
        })
      );
    })()
  );
});

// Az alkalmazás kérheti az azonnali frissítést (pl. „új verzió elérhető”).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
