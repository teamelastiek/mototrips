// Plekken langs de route uit OpenStreetMap: tankstations, cafés/restaurants en steden.
// Eerst één lichte Overpass-vraag; lukt dat niet, dan een paar kleine Photon-vragen.
// Alles gratis en zonder sleutel, en zuinig zodat de servers ons niet blokkeren.
import { distance, pointAlong, projectOnRoute, resample, type LatLng } from './geo';
import type { Route } from './valhalla';

export type PoiKind = 'fuel' | 'cafe' | 'restaurant' | 'place';

export const poiIcon = (k: PoiKind) => (k === 'fuel' ? '⛽' : k === 'cafe' ? '☕' : k === 'restaurant' ? '🍽️' : '📍');

export interface Poi extends LatLng {
  id: number;
  kind: PoiKind;
  name: string;
  /** Afstand langs de route waar je het tegenkomt (m) */
  along: number;
  /** Hoe ver van de route af (m) */
  offset: number;
  brand?: string;
  opening?: string;
}

const UNAVAILABLE = 'De plekkendienst (OpenStreetMap) reageert nu niet. Probeer het later opnieuw.';

/** Fetch met eigen tijdslimiet, die ook stopt als de aanroeper afbreekt. */
async function fetchWithTimeout(url: string, init: RequestInit, ms: number, signal?: AbortSignal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Voer taken uit met hooguit `n` tegelijk (vriendelijk voor de gratis servers). */
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<PromiseSettledResult<T>[]> {
  const out: PromiseSettledResult<T>[] = new Array(jobs.length);
  let i = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const k = i++;
      try {
        out[k] = { status: 'fulfilled', value: await jobs[k]() };
      } catch (reason) {
        out[k] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- Photon

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: { osm_id: number; osm_type: string; osm_key: string; osm_value: string; name?: string; brand?: string };
}

async function photonNear(p: LatLng, radiusKm: number, tags: string[], limit: number, signal?: AbortSignal): Promise<PhotonFeature[]> {
  const url = new URL('https://photon.komoot.io/reverse');
  url.searchParams.set('lat', p.lat.toFixed(5));
  url.searchParams.set('lon', p.lon.toFixed(5));
  url.searchParams.set('radius', String(radiusKm));
  url.searchParams.set('limit', String(limit));
  for (const t of tags) url.searchParams.append('osm_tag', t);
  const res = await fetchWithTimeout(url.toString(), {}, 6000, signal);
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  return ((await res.json()).features ?? []) as PhotonFeature[];
}

/** Wat we zoeken: tankstations, of iets om te eten/drinken. */
export type Want = 'fuel' | 'food';

const KIND_OF: Record<string, PoiKind | undefined> = { fuel: 'fuel', cafe: 'cafe', restaurant: 'restaurant', fast_food: 'restaurant' };
const MAX_OFFSET: Record<Want, number> = { fuel: 900, food: 600 };

function toPoi(r: Route, id: number, value: string, p: LatLng, tags: { name?: string; brand?: string; opening?: string }, want: Want): Poi | null {
  const kind = KIND_OF[value];
  if (!kind || (want === 'fuel') !== (kind === 'fuel')) return null;
  const proj = projectOnRoute(p, r.shape, r.cum);
  // Alleen wat echt langs de route ligt
  if (!proj || proj.offset > MAX_OFFSET[want]) return null;
  return {
    id,
    kind,
    ...p,
    name: tags.name || tags.brand || (kind === 'fuel' ? 'Tankstation' : kind === 'cafe' ? 'Café' : 'Restaurant'),
    brand: tags.brand,
    opening: tags.opening,
    along: proj.along,
    offset: proj.offset,
  };
}

/** Punten langs (een stuk van) de route. */
function samplesAlong(r: Route, from: number, to: number, step: number): LatLng[] {
  const out: LatLng[] = [];
  for (let a = from; a <= to; a += step) out.push(pointAlong(r.shape, r.cum, a).point);
  out.push(pointAlong(r.shape, r.cum, to).point);
  return out;
}

async function viaPhoton(r: Route, want: Want, from: number, to: number, signal?: AbortSignal): Promise<Poi[]> {
  // Zuinig met de gratis server: hooguit 5 zoekpunten, nooit meer dan 2 tegelijk
  const len = to - from;
  const pts = samplesAlong(r, from, to, Math.max(want === 'fuel' ? 8000 : 3000, len / 4)).slice(0, 5);
  const jobs = pts.map(
    (p) => () =>
      want === 'fuel'
        ? photonNear(p, 5, ['amenity:fuel'], 20, signal)
        : photonNear(p, 3, ['amenity:cafe', 'amenity:restaurant', 'amenity:fast_food'], 20, signal),
  );
  // Eerst één vraag als proef: reageert de server niet, dan meteen stoppen (niet 5× wachten)
  const first = await pool(jobs.slice(0, 1), 1);
  if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');
  if (first[0].status === 'rejected') throw new Error(UNAVAILABLE);
  const results = [...first, ...(await pool(jobs.slice(1), 2))];
  if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');

  const seen = new Set<string>();
  const out: Poi[] = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    for (const f of res.value) {
      const pr = f.properties;
      const key = `${pr.osm_type}${pr.osm_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const poi = toPoi(r, pr.osm_id, pr.osm_value, { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }, pr, want);
      if (poi) out.push(poi);
    }
  }
  return out.sort((a, b) => a.along - b.along);
}

// ---------------------------------------------------------------- Overpass

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Publieke Overpass-servers zijn soms overbelast: probeer ze na elkaar, met een korte tijdslimiet
const OVERPASS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter'];

async function overpass(q: string, signal?: AbortSignal): Promise<OsmElement[]> {
  for (const ep of OVERPASS) {
    if (signal?.aborted) break;
    try {
      const res = await fetchWithTimeout(ep, { method: 'POST', body: new URLSearchParams({ data: q }) }, 6000, signal);
      if (!res.ok) continue;
      return (await res.json()).elements ?? [];
    } catch {
      /* volgende server proberen */
    }
  }
  if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');
  throw new Error(UNAVAILABLE);
}

async function viaOverpass(r: Route, want: Want, from: number, to: number, signal?: AbortSignal): Promise<Poi[]> {
  // Lichte zoekvraag: het stuk route vereenvoudigd tot hooguit ±100 punten
  const pts = samplesAlong(r, from, to, Math.max(want === 'fuel' ? 3000 : 1000, (to - from) / 100));
  const pl = pts.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(',');
  const filter = want === 'fuel' ? '[amenity=fuel]' : '[amenity~"^(cafe|restaurant|fast_food)$"]';
  const els = await overpass(`[out:json][timeout:20];nw(around:${MAX_OFFSET[want]},${pl})${filter};out center tags qt 300;`, signal);
  const out: Poi[] = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const t = el.tags ?? {};
    const poi = toPoi(r, el.id, t.amenity ?? '', { lat, lon }, { name: t.name, brand: t.brand, opening: t.opening_hours }, want);
    if (poi) out.push(poi);
  }
  return out.sort((a, b) => a.along - b.along);
}

/** Plekken langs een stuk van de route (van/tot in meters langs de route). */
export async function placesAlong(r: Route, want: Want, from = 0, to = r.lengthM, signal?: AbortSignal): Promise<Poi[]> {
  from = Math.max(0, from);
  to = Math.min(r.lengthM, Math.max(to, from + 1000));
  try {
    return await viaOverpass(r, want, from, to, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    return viaPhoton(r, want, from, to, signal);
  }
}

/** Alle tankstations langs de route. */
export const poisAlongRoute = (r: Route, signal?: AbortSignal) => placesAlong(r, 'fuel', 0, r.lengthM, signal);

// ---------------------------------------------------------------- steden

export interface City extends LatLng {
  name: string;
  /** straal (m) van het gebied dat we als 'stad' beschouwen */
  radius: number;
}

/** Steden en grote dorpen in een gebied. */
export async function citiesInArea(center: LatLng, radiusM: number, signal?: AbortSignal): Promise<City[]> {
  const km = Math.round(Math.min(radiusM, 150000) / 1000);
  try {
    const feats = await photonNear(center, Math.max(5, km), ['place:city', 'place:town'], 80, signal);
    return feats.map((f) => ({
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      name: f.properties.name ?? '',
      // Zonder inwonertal: stad ≈ 3,5 km, dorp/kleine stad ≈ 1,5 km straal
      radius: f.properties.osm_value === 'city' ? 3500 : 1500,
    }));
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  const els = await overpass(
    `[out:json][timeout:25];node(around:${km * 1000},${center.lat.toFixed(4)},${center.lon.toFixed(4)})[place~"^(city|town)$"];out tags qt;`,
    signal,
  );
  return els
    .filter((e) => e.lat !== undefined)
    .map((e) => {
      const pop = parseInt((e.tags?.population ?? '').replace(/\D/g, ''), 10);
      const isCity = e.tags?.place === 'city';
      // Grofweg: 20k inwoners ≈ 1,5 km, 150k ≈ 4 km, 500k+ ≈ 6 km
      const r = Number.isFinite(pop) ? Math.min(7000, Math.max(1200, Math.sqrt(pop) * 10)) : isCity ? 4000 : 1500;
      return { lat: e.lat!, lon: e.lon!, name: e.tags?.name ?? '', radius: r };
    });
}

/** Hoeveel meter van de route binnen de opgegeven steden ligt. */
export function metersInCities(shape: LatLng[], cities: City[]): number {
  if (!cities.length) return 0;
  const pts = resample(shape, 100);
  let n = 0;
  for (const p of pts) if (cities.some((c) => distance(p, c) < c.radius)) n++;
  return n * 100;
}

/** Schuif een punt naar buiten als het in een stad ligt. */
export function pushOutOfCities(p: LatLng, cities: City[], keep: LatLng[]): LatLng {
  for (const c of cities) {
    const d = distance(p, c);
    // Start/eind/vaste punten in deze stad? Dan niet verplaatsen
    if (d >= c.radius || keep.some((k) => distance(k, c) < c.radius)) continue;
    const f = (c.radius * 1.25) / Math.max(d, 1);
    return { lat: c.lat + (p.lat - c.lat) * f, lon: c.lon + (p.lon - c.lon) * f };
  }
  return p;
}
