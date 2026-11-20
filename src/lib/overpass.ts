// Plekken langs de route uit OpenStreetMap: tankstations, cafés/restaurants en steden.
// Eerst via Photon (snel en betrouwbaar, dezelfde dienst als het adressen zoeken);
// lukt dat niet, dan via Overpass als reserve. Alles gratis en zonder sleutel.
import { distance, pointAlong, projectOnRoute, resample, type LatLng } from './geo';
import type { Route } from './valhalla';

export type PoiKind = 'fuel' | 'cafe' | 'restaurant';

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

async function poisViaPhoton(r: Route, signal?: AbortSignal): Promise<Poi[]> {
  const total = r.lengthM;
  const samples = (from: number, to: number, step: number) => {
    const out: LatLng[] = [];
    for (let a = from; a <= to; a += step) out.push(pointAlong(r.shape, r.cum, a).point);
    if (!out.length) out.push(pointAlong(r.shape, r.cum, (from + to) / 2).point);
    return out;
  };
  // Zuinig met de gratis server: hooguit 5 zoekpunten voor tanken en 3 voor eten/drinken
  // (rond de helft van de rit, daar zoek je een pauze), nooit meer dan 2 tegelijk.
  const fuelPts = samples(0, total, Math.max(8000, total / 4));
  const foodFrom = total > 60000 ? total * 0.35 : 0;
  const foodTo = total > 60000 ? total * 0.65 : total;
  const foodPts = samples(foodFrom, foodTo, Math.max(3000, (foodTo - foodFrom) / 2));
  const jobs = [
    ...fuelPts.slice(0, 5).map((p) => () => photonNear(p, 5, ['amenity:fuel'], 20, signal)),
    ...foodPts.slice(0, 3).map((p) => () => photonNear(p, 3, ['amenity:cafe', 'amenity:restaurant'], 20, signal)),
  ];
  // Eerst één vraag als proef: reageert de server niet, dan meteen stoppen (niet 8× wachten)
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
      const kind = pr.osm_value as PoiKind;
      if (kind !== 'fuel' && kind !== 'cafe' && kind !== 'restaurant') continue;
      const p = { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
      const proj = projectOnRoute(p, r.shape, r.cum);
      // Alleen wat echt langs de route ligt
      if (!proj || proj.offset > (kind === 'fuel' ? 800 : 500)) continue;
      out.push({
        id: pr.osm_id,
        kind,
        ...p,
        name: pr.name || pr.brand || (kind === 'fuel' ? 'Tankstation' : kind === 'cafe' ? 'Café' : 'Restaurant'),
        brand: pr.brand,
        along: proj.along,
        offset: proj.offset,
      });
    }
  }
  out.sort((a, b) => a.along - b.along);
  return out;
}

// ---------------------------------------------------------------- Overpass (reserve)

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Publieke Overpass-servers zijn soms overbelast: probeer ze na elkaar, met een korte tijdslimiet
const OVERPASS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
];

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

async function poisViaOverpass(r: Route, signal?: AbortSignal): Promise<Poi[]> {
  // Lichte zoekvraag: route vereenvoudigd tot ±1 punt per 3 km (max. 100 punten),
  // alleen punten en gebouwen (geen grote relaties)
  const step = Math.max(3000, r.lengthM / 100);
  const line = resample(r.shape, step);
  line.push(r.shape[r.shape.length - 1]);
  const pl = line.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(',');
  const els = await overpass(
    `[out:json][timeout:20];(nw(around:900,${pl})[amenity=fuel];nw(around:600,${pl})[amenity~"^(cafe|restaurant)$"];);out center tags qt 400;`,
    signal,
  );
  const out: Poi[] = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const t = el.tags ?? {};
    const kind = t.amenity as PoiKind;
    if (kind !== 'fuel' && kind !== 'cafe' && kind !== 'restaurant') continue;
    const proj = projectOnRoute({ lat, lon }, r.shape, r.cum);
    if (!proj) continue;
    out.push({
      id: el.id,
      kind,
      lat,
      lon,
      name: t.name || t.brand || (kind === 'fuel' ? 'Tankstation' : kind === 'cafe' ? 'Café' : 'Restaurant'),
      brand: t.brand,
      opening: t.opening_hours,
      along: proj.along,
      offset: proj.offset,
    });
  }
  out.sort((a, b) => a.along - b.along);
  return out;
}

/**
 * Tankstations, cafés en restaurants vlak langs de route.
 * Eerst één lichte Overpass-vraag; lukt dat niet, dan een paar kleine Photon-vragen.
 */
export async function poisAlongRoute(r: Route, signal?: AbortSignal): Promise<Poi[]> {
  try {
    const viaOverpass = (await poisViaOverpass(r, signal)).filter((p) => p.offset <= (p.kind === 'fuel' ? 900 : 600));
    return viaOverpass;
  } catch (e) {
    if (signal?.aborted) throw e;
    return poisViaPhoton(r, signal);
  }
}

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
