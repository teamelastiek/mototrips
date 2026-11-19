// Kaart rond een route vooraf downloaden zodat hij werkt zonder mobiel bereik.
// De tegels gaan in een cache die de service worker gebruikt.
import { distance, type LatLng } from './geo';
import type { Route } from './valhalla';

export const OFFLINE_CACHE = 'mototrips-offline-v1';
const TILEJSON = 'https://tiles.openfreemap.org/planet';
export const STYLE_URLS = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

function tileXY(p: LatLng, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((p.lon + 180) / 360) * n);
  const latR = (p.lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/** Alle tegels (z/x/y) rond de route: dichtbij gedetailleerd, verder weg grover. */
export function tilesForRoute(r: Route): string[] {
  const set = new Set<string>();
  const zooms: [number, number][] = [
    [6, 20000],
    [8, 10000],
    [10, 5000],
    [11, 3000],
    [12, 2000],
    [13, 1200],
    [14, 800],
  ];
  for (const [z, buffer] of zooms) {
    const step = Math.min(buffer, 500);
    let last: LatLng | null = null;
    for (let i = 0; i < r.shape.length; i++) {
      const p = r.shape[i];
      if (last && distance(last, p) < step && i < r.shape.length - 1) continue;
      last = p;
      const dLat = buffer / 111320;
      const dLon = buffer / (111320 * Math.cos((p.lat * Math.PI) / 180));
      const a = tileXY({ lat: p.lat + dLat, lon: p.lon - dLon }, z);
      const b = tileXY({ lat: p.lat - dLat, lon: p.lon + dLon }, z);
      for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) set.add(`${z}/${x}/${y}`);
    }
  }
  return [...set];
}

async function styleExtras(styleUrl: string): Promise<string[]> {
  const urls = [styleUrl];
  try {
    const style = await (await fetch(styleUrl)).json();
    if (typeof style.sprite === 'string') {
      for (const s of ['', '@2x']) urls.push(`${style.sprite}${s}.json`, `${style.sprite}${s}.png`);
    }
    if (typeof style.glyphs === 'string') {
      const fonts = new Set<string>();
      for (const l of style.layers ?? []) for (const f of l.layout?.['text-font'] ?? []) if (typeof f === 'string') fonts.add(f);
      for (const f of fonts) for (const range of ['0-255', '256-511', '8192-8447']) urls.push(style.glyphs.replace('{fontstack}', encodeURIComponent(f)).replace('{range}', range));
    }
  } catch {
    /* stijl niet bereikbaar */
  }
  return urls;
}

export interface OfflineProgress {
  done: number;
  total: number;
  bytes: number;
}

export async function downloadRouteMap(
  r: Route,
  onProgress: (p: OfflineProgress) => void,
  signal?: AbortSignal,
): Promise<OfflineProgress> {
  if (!('caches' in window)) throw new Error('Offline opslaan wordt niet ondersteund in deze browser.');
  // Vraag de browser de opslag niet zomaar op te ruimen
  navigator.storage?.persist?.().catch(() => {});

  const tilejson = await (await fetch(TILEJSON, { signal })).json();
  const template: string = tilejson.tiles[0];
  const urls = [
    TILEJSON,
    ...(await styleExtras(STYLE_URLS.light)),
    ...(await styleExtras(STYLE_URLS.dark)),
    ...tilesForRoute(r).map((t) => {
      const [z, x, y] = t.split('/');
      return template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    }),
  ];
  const cache = await caches.open(OFFLINE_CACHE);
  const prog: OfflineProgress = { done: 0, total: urls.length, bytes: 0 };
  onProgress(prog);

  let i = 0;
  const worker = async () => {
    while (i < urls.length) {
      if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');
      const url = urls[i++];
      try {
        const hit = await cache.match(url);
        if (!hit) {
          const res = await fetch(url, { signal });
          if (res.ok) {
            const blob = await res.clone().blob();
            prog.bytes += blob.size;
            await cache.put(url, res);
          }
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      prog.done++;
      if (prog.done % 10 === 0 || prog.done === prog.total) onProgress({ ...prog });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return prog;
}

export async function offlineCacheSize(): Promise<{ tiles: number }> {
  if (!('caches' in window)) return { tiles: 0 };
  const c = await caches.open(OFFLINE_CACHE);
  return { tiles: (await c.keys()).length };
}

export async function clearOfflineMaps() {
  if ('caches' in window) await caches.delete(OFFLINE_CACHE);
}
