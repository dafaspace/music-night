/* Tunemail - service worker
 *
 * Bump CACHE_VERSION on every deploy that changes the precached files below,
 * otherwise returning visitors keep the old shell until the cache is evicted.
 */
const CACHE_VERSION = 'v25';
const CACHE_NAME = `tunemail-${CACHE_VERSION}`;

/* Same-origin shell. Without any one of these the page cannot render, so these
 * go through addAll: if a single request fails the whole install fails and the
 * browser retries later, instead of leaving a half-filled cache behind. */
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.png',
  './fonts/bebas-neue-latin.woff2',
  './fonts/bebas-neue-latin-ext.woff2',
  './fonts/dm-sans-latin.woff2',
  './fonts/dm-sans-latin-ext.woff2',
];

/* Cross-origin code the page needs to boot. Same criticality as the shell. */
const VENDOR = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js',
];

/* Hosts whose GET responses we keep in the cache as we see them. */
const RUNTIME_HOSTS = new Set([
  'cdn.jsdelivr.net',
]);

/* cache.put refuses a redirected response, and jsdelivr redirects version
 * ranges to a pinned file. Rebuild the response so the body is stored under
 * the URL the page will actually ask for. */
async function put(cache, request, response) {
  if (!response || !response.ok) return false;
  const body = await response.blob();
  await cache.put(request, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  }));
  return true;
}

async function fetchAndPut(cache, url) {
  const res = await fetch(url, { cache: 'reload', credentials: 'omit' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  await put(cache, url, res);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL);
    await Promise.all(VENDOR.map((url) => fetchAndPut(cache, url)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => (n.startsWith('music-night-') || n.startsWith('tunemail-')) && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

/* Serve from cache, and refresh the entry in the background for next time. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request, { ignoreVary: true });

  const network = fetch(request)
    .then(async (res) => {
      await put(cache, request, res.clone());
      return res;
    })
    .catch(() => null);

  if (hit) return hit;

  const res = await network;
  if (res) return res;
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

/* The click on the home-screen icon arrives here. Network first so a deployed
 * update shows up immediately, cached shell when there is no network. */
async function navigation(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(request);
    if (res.ok) await put(cache, './index.html', res.clone());
    return res;
  } catch (err) {
    return (
      (await cache.match(request, { ignoreSearch: true })) ||
      (await cache.match('./index.html')) ||
      (await cache.match('./')) ||
      new Response('Offline', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      })
    );
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigation(request));
    return;
  }

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin || RUNTIME_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  /* Everything else - Supabase, the workers, album art from the streaming
   * CDNs - goes straight to the network untouched. */
});
