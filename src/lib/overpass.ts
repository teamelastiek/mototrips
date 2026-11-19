// Plekken langs de route uit OpenStreetMap (via Overpass): tankstations,
// cafés/restaurants en steden. Gratis en zonder sleutel.
import { distance, projectOnRoute, resample, type LatLng } from './geo';
import type { Route } from './valhalla';

const ENDPOINT = 'https://overpass-api.de/api/interpreter';

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

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

// Publieke Overpass-servers zijn soms overbelast: probeer ze na elkaar
const ENDPOINTS = [ENDPOINT, 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];

async function query(q: string, signal?: AbortSignal): Promise<OsmElement[]> {
  let lastStatus = 0;
  for (const ep of ENDPOINTS) {
    if (signal?.aborted) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(ep, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctrl.signal });
      lastStatus = res.status;
      if (!res.ok) continue;
      const data = await res.json();
      return data.elements ?? [];
    } catch {
      /* volgende server proberen */
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  if (signal?.aborted) throw new DOMException('Afgebroken', 'AbortError');
  throw new Error(
    lastStatus === 429
      ? 'De plekkendienst (OpenStreetMap) is even druk. Probeer het zo opnieuw.'
      : 'De plekkendienst (OpenStreetMap) reageert nu niet. Probeer het later opnieuw.',
  );
}

function polyline(points: LatLng[]) {
  return points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
}

/** Tankstations, cafés en restaurants binnen ~600 m van de route. */
export async function poisAlongRoute(r: Route, signal?: AbortSignal): Promise<Poi[]> {
  // Route vereenvoudigen tot ±1 punt per 1,5 km (Overpass houdt niet van lange lijnen)
  const step = Math.max(1500, r.lengthM / 250);
  const line = resample(r.shape, step);
  line.push(r.shape[r.shape.length - 1]);
  const pl = polyline(line);
  const q = `[out:json][timeout:40];
(
  nwr(around:700,${pl})[amenity=fuel];
  nwr(around:400,${pl})[amenity~"^(cafe|restaurant)$"];
);
out center tags qt 600;`;
  const els = await query(q, signal);
  const out: Poi[] = [];
  for (const el of els) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const t = el.tags ?? {};
    const kind = t.amenity as PoiKind;
    if (kind !== 'fuel' && kind !== 'cafe' && kind !== 'restaurant') continue;
    // Tankstations die alleen LPG/elektrisch zijn overslaan
    if (kind === 'fuel' && (t['fuel:octane_95'] === 'no' && t['fuel:e10'] === 'no')) continue;
    const p = { lat, lon };
    const proj = projectOnRoute(p, r.shape, r.cum);
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

export interface City extends LatLng {
  name: string;
  /** straal (m) van het gebied dat we als 'stad' beschouwen */
  radius: number;
}

/** Steden en grote dorpen in een gebied, met een geschatte straal op basis van inwoners. */
export async function citiesInArea(center: LatLng, radiusM: number, signal?: AbortSignal): Promise<City[]> {
  const q = `[out:json][timeout:25];
node(around:${Math.round(Math.min(radiusM, 150000))},${center.lat.toFixed(4)},${center.lon.toFixed(4)})[place~"^(city|town)$"];
out tags qt;`;
  const els = await query(q, signal);
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
