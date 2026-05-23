// ============================================================
// RAICE — Service Worker v2
// Estrategia clara y simple:
//   - App shell (HTML/CSS/JS): Cache-first, actualiza en fondo
//   - API /raice/*: Network-first, fallback a caché
//   - Offline: página de aviso simple
// ============================================================

const VERSION      = 'raice-v3';
const CACHE_SHELL  = VERSION + '-shell';
const CACHE_API    = VERSION + '-api';

// Páginas que se pre-cachean al instalar
const SHELL_URLS = [
  '/login',
  '/admin',
  '/docente',
  '/superadmin',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/offline'
];

// ── INSTALL ─────────────────────────────────────────────────
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_SHELL).then(cache =>
      Promise.allSettled(SHELL_URLS.map(url => cache.add(url)))
    )
  );
});

// ── ACTIVATE: eliminar cachés viejas ────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_SHELL && k !== CACHE_API)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Ignorar: no-GET, otros orígenes (excepto Google Fonts), extensiones de Chrome
  if (req.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.origin !== location.origin &&
      !url.href.startsWith('https://fonts.googleapis.com') &&
      !url.href.startsWith('https://fonts.gstatic.com') &&
      !url.href.startsWith('https://cdnjs.cloudflare.com')) return;

  // API → Network-first
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/raice/')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Todo lo demás → Cache-first
  event.respondWith(cacheFirst(req));
});

// Network-first: intenta red, fallback a caché
// NUNCA cachear respuestas autenticadas (Cache-Control: no-store)
async function networkFirst(req) {
  const cache = await caches.open(CACHE_API);
  try {
    const res = await fetch(req.clone());
    const noStore = res.headers.get('cache-control')?.includes('no-store');
    if (res.ok && !noStore) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'Sin conexión', offline: true }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// Cache-first: sirve caché inmediatamente, actualiza en fondo
async function cacheFirst(req) {
  const cache  = await caches.open(CACHE_SHELL);
  const cached = await cache.match(req);

  // Actualizar en background
  const fetchAndCache = fetch(req.clone())
    .then(res => { if (res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);

  if (cached) {
    fetchAndCache; // fire-and-forget
    return cached;
  }

  // No hay caché → esperar red
  const res = await fetchAndCache;
  if (res) return res;

  // Sin red y sin caché → página offline para HTML
  if (req.headers.get('Accept')?.includes('text/html')) {
    const offline = await cache.match('/offline');
    if (offline) return offline;
  }
  return new Response('Sin conexión', { status: 503 });
}
