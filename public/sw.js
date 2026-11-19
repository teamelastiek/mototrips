// Service worker: app-schil en kaarttegels offline beschikbaar houden.
// - mototrips-tiles: automatisch bewaarde tegels van wat je bekeken hebt (begrensd)
// - mototrips-offline: tegels die je bewust voor een route hebt gedownload (niet opgeruimd)
const APP_CACHE = 'mototrips-app-v2';
const TILE_CACHE = 'mototrips-tiles-v1';
const OFFLINE_CACHE = 'mototrips-offline-v1';
const KEEP = [APP_CACHE, TILE_CACHE, OFFLINE_CACHE];
const MAX_TILES = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP_CACHE).then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './icon.svg'])));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      // Alleen eigen oude caches opruimen (andere sites op hetzelfde domein met rust laten)
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mototrips-') && !KEEP.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

async function matchOwn(req) {
  for (const name of [OFFLINE_CACHE, TILE_CACHE, APP_CACHE]) {
    const c = await caches.open(name);
    const hit = await c.match(req, { ignoreVary: true });
    if (hit) return hit;
  }
  return undefined;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isMapHost = url.hostname === 'tiles.openfreemap.org';
  const isFont = url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com';

  // Tegels, sprites en lettertypen veranderen niet: eerst cache, dan netwerk
  const immutable = isFont || (isMapHost && /\.(pbf|png|json)$/.test(url.pathname) && !/^\/styles\//.test(url.pathname));
  if (immutable) {
    e.respondWith(
      matchOwn(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(TILE_CACHE).then((c) => c.put(req, copy));
              if (Math.random() < 0.02) trimTiles();
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Kaartstijl en tegeloverzicht: eerst netwerk (nieuwste versie), cache als terugval
  if (isMapHost) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(TILE_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => matchOwn(req).then((r) => r || Response.error())),
    );
    return;
  }

  // Eigen app: netwerk eerst, cache als terugval
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(APP_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => matchOwn(req).then((r) => r || caches.match('./index.html'))),
    );
  }
});
