// Client voor de Valhalla-routeringsengine (OpenStreetMap), motorprofiel.
import { cumulative, type LatLng } from './geo';

export interface RoutePrefs {
  /** 0 = rustig, 1 = wat bochten, 2 = bochtig, 3 = zo bochtig mogelijk */
  curviness: number;
  avoidHighways: boolean;
  /** 0 = smalle binnenwegen, 1 = provinciale 80-wegen (N-wegen) */
  roadType: number;
  avoidTolls: boolean;
  avoidFerries: boolean;
  allowUnpaved: boolean;
  /** Grote steden en dorpskernen zoveel mogelijk links laten liggen */
  avoidCities: boolean;
  /** Liever wegen die je nog niet gereden hebt */
  preferNew: boolean;
}

export const defaultPrefs: RoutePrefs = {
  curviness: 2,
  avoidHighways: true,
  roadType: 0.5,
  avoidTolls: true,
  avoidFerries: false,
  allowUnpaved: false,
  avoidCities: false,
  preferNew: false,
};

export interface Maneuver {
  type: number;
  instruction: string;
  alert?: string;
  pre?: string;
  post?: string;
  streets: string[];
  beginShapeIndex: number;
  endShapeIndex: number;
  lengthM: number;
  timeS: number;
  roundaboutExit?: number;
  /** Afstand langs de route waar deze manoeuvre begint (m). */
  at: number;
}

export interface Route {
  shape: LatLng[];
  cum: number[];
  maneuvers: Maneuver[];
  lengthM: number;
  timeS: number;
  hasHighway: boolean;
  hasToll: boolean;
  hasFerry: boolean;
  /** Tussenpunten waar de route doorheen gaat (zonder start en eind). */
  vias: LatLng[];
  start: LatLng;
  end: LatLng;
}

export interface RoutingLocation extends LatLng {
  type?: 'break' | 'through' | 'via';
  heading?: number;
  headingTolerance?: number;
  /** Alleen aan wegen van deze klasse of hoger koppelen. */
  minRoadClass?: 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential';
}

const SERVER_KEY = 'mototrips.server';
export const DEFAULT_SERVER = 'https://valhalla1.openstreetmap.de';

export function getServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
  } catch {
    return DEFAULT_SERVER;
  }
}

export function setServer(url: string) {
  try {
    if (!url || url === DEFAULT_SERVER) localStorage.removeItem(SERVER_KEY);
    else localStorage.setItem(SERVER_KEY, url.replace(/\/+$/, ''));
  } catch {
    /* geen opslag beschikbaar */
  }
}

/** Decodeer een Valhalla polyline (precisie 6). */
export function decodePolyline(str: string, precision = 6): LatLng[] {
  const factor = 10 ** precision;
  const out: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lon += delta;
    }
    out.push({ lat: lat / factor, lon: lon / factor });
  }
  return out;
}

export function costingOptions(p: RoutePrefs) {
  // Hoe bochtiger gewenst, hoe meer we kleine wegen verkiezen boven doorgaande wegen.
  const curvyBias = p.curviness / 3;
  const usePrimary = Math.max(0, Math.min(1, p.roadType * (1 - 0.35 * curvyBias)));
  return {
    motorcycle: {
      use_highways: p.avoidHighways ? 0 : 0.6,
      use_primary: Number(usePrimary.toFixed(2)),
      use_tolls: p.avoidTolls ? 0 : 0.5,
      use_ferry: p.avoidFerries ? 0 : 0.5,
      use_trails: p.allowUnpaved ? 0.6 : 0,
      use_living_streets: 0.1,
      // Woonwijk-sluiproutes en doorgaande wegen in de stad minder aantrekkelijk
      maneuver_penalty: 10,
    },
  };
}

// Eenvoudige wachtrij: de publieke server is gratis, dus we sturen niet te veel tegelijk.
let active = 0;
const queue: (() => void)[] = [];
const MAX_CONCURRENT = 2;
async function throttle<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

export class RoutingError extends Error {}

export async function route(
  locations: RoutingLocation[],
  prefs: RoutePrefs,
  signal?: AbortSignal,
): Promise<Route> {
  const body = {
    locations: locations.map((l, i) => {
      const loc: Record<string, unknown> = {
        lat: Number(l.lat.toFixed(6)),
        lon: Number(l.lon.toFixed(6)),
        type: l.type ?? (i === 0 || i === locations.length - 1 ? 'break' : 'through'),
      };
      if (l.heading !== undefined) {
        loc.heading = Math.round(l.heading);
        loc.heading_tolerance = l.headingTolerance ?? 60;
      }
      if (l.minRoadClass) {
        loc.search_filter = {
          min_road_class: l.minRoadClass,
          ...(prefs.avoidHighways ? { max_road_class: 'primary' } : {}),
          exclude_ramp: true,
        };
        loc.radius = 800;
      }
      return loc;
    }),
    costing: 'motorcycle',
    costing_options: costingOptions(prefs),
    directions_options: { language: 'nl-NL', units: 'kilometers' },
  };

  const data = await post('route', body, signal);
  if (!data?.trip) throw new RoutingError('Geen route gevonden');
  return parseTrip(data.trip, locations);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<any> {
  const res = await throttle(() =>
    fetch(`${getServer()}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 429) throw new RoutingError('De routeserver is even druk. Probeer het over een minuut opnieuw.');
    throw new RoutingError(data?.error ? `Geen route gevonden: ${data.error}` : `Routeserver gaf fout ${res.status}`);
  }
  return data;
}

/** De publieke server staat maximaal 10 punten per route toe. */
export const MAX_LOCATIONS = 10;

/** Plak meerdere routes achter elkaar tot één route. */
export function mergeRoutes(parts: Route[], vias: LatLng[]): Route {
  if (parts.length === 1) return { ...parts[0], vias };
  const shape: LatLng[] = [];
  const maneuvers: Maneuver[] = [];
  parts.forEach((r, pi) => {
    const offset = shape.length === 0 ? 0 : shape.length - 1;
    shape.push(...(shape.length === 0 ? r.shape : r.shape.slice(1)));
    r.maneuvers.forEach((m, mi) => {
      const isArrive = m.type === 4 || m.type === 5 || m.type === 6;
      if (isArrive && pi < parts.length - 1) return;
      if (mi === 0 && pi > 0) return; // vertrek-manoeuvre van vervolgstuk
      maneuvers.push({ ...m, beginShapeIndex: m.beginShapeIndex + offset, endShapeIndex: m.endShapeIndex + offset });
    });
  });
  const cum = cumulative(shape);
  for (const m of maneuvers) m.at = cum[Math.min(m.beginShapeIndex, cum.length - 1)];
  return {
    shape,
    cum,
    maneuvers,
    lengthM: parts.reduce((s, r) => s + r.lengthM, 0),
    timeS: parts.reduce((s, r) => s + r.timeS, 0),
    hasHighway: parts.some((r) => r.hasHighway),
    hasToll: parts.some((r) => r.hasToll),
    hasFerry: parts.some((r) => r.hasFerry),
    vias,
    start: parts[0].start,
    end: parts[parts.length - 1].end,
  };
}

/** Route langs willekeurig veel punten: knipt in stukken van maximaal 10 punten. */
export async function routeMany(points: RoutingLocation[], prefs: RoutePrefs, signal?: AbortSignal): Promise<Route> {
  if (points.length <= MAX_LOCATIONS) return route(points, prefs, signal);
  const parts: Route[] = [];
  for (let i = 0; i < points.length - 1; i += MAX_LOCATIONS - 1) {
    const chunk = points.slice(i, i + MAX_LOCATIONS).map((p, j, arr) => ({
      ...p,
      type: j === 0 || j === arr.length - 1 ? ('break' as const) : p.type ?? ('through' as const),
    }));
    if (chunk.length < 2) break;
    parts.push(await route(chunk, prefs, signal));
  }
  return mergeRoutes(parts, points.slice(1, -1).map(({ lat, lon }) => ({ lat, lon })));
}

/**
 * Koppel een opgenomen spoor (GPX-track) aan de weg en maak er een route met
 * afslagen van. Lange sporen gaan in stukken.
 */
export async function traceRoute(points: LatLng[], prefs: RoutePrefs, signal?: AbortSignal): Promise<Route> {
  // Kleine stukken (~15 km bij 30 m tussen punten): zo valt er bij een misser weinig weg
  const CHUNK = 500;
  const parts: Route[] = [];
  for (let i = 0; i < points.length - 1; i += CHUNK - 1) {
    const chunk = points.slice(i, i + CHUNK);
    if (chunk.length < 2) break;
    const inputM = cumulative(chunk)[chunk.length - 1];
    let part: Route | null = null;
    try {
      const data = await post(
        'trace_route',
        {
          shape: chunk.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
          costing: 'motorcycle',
          costing_options: costingOptions(prefs),
          shape_match: 'map_snap',
          directions_options: { language: 'nl-NL', units: 'kilometers' },
        },
        signal,
      );
      if (data?.trip) part = parseTrip(data.trip, [chunk[0], chunk[chunk.length - 1]]);
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    // Viel er een flink stuk weg (bv. een heen-en-terug-uitstapje)? Dan via punten op het spoor rijden.
    if (!part || part.lengthM < inputM * 0.85) {
      const step = Math.max(1, Math.floor((chunk.length - 1) / (MAX_LOCATIONS - 1)));
      const sample: RoutingLocation[] = [];
      for (let j = 0; j < chunk.length; j += step) sample.push({ ...chunk[j], type: 'via' });
      if (sample[sample.length - 1] !== chunk[chunk.length - 1]) sample.push({ ...chunk[chunk.length - 1], type: 'via' });
      sample[0].type = 'break';
      sample[sample.length - 1].type = 'break';
      part = await routeMany(sample, prefs, signal);
    }
    parts.push(part);
  }
  return mergeRoutes(parts, []);
}

export interface SpeedSegment {
  from: number; // afstand langs de route (m)
  to: number;
  limit: number; // km/u
}

/** Maximumsnelheden langs de route (uit OpenStreetMap), per wegstuk. */
export async function speedLimits(r: Route, signal?: AbortSignal): Promise<SpeedSegment[]> {
  const out: SpeedSegment[] = [];
  const CHUNK = 3000;
  for (let i = 0; i < r.shape.length - 1; i += CHUNK - 1) {
    const chunk = r.shape.slice(i, i + CHUNK);
    const base = r.cum[i];
    const data = await post(
      'trace_attributes',
      {
        shape: chunk.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
        costing: 'motorcycle',
        shape_match: 'edge_walk',
        filters: { attributes: ['edge.speed_limit', 'edge.length'], action: 'include' },
      },
      signal,
    ).catch(() =>
      // edge_walk vereist een exacte match; anders gewoon op de kaart klikken
      post(
        'trace_attributes',
        {
          shape: chunk.map((p) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
          costing: 'motorcycle',
          shape_match: 'map_snap',
          filters: { attributes: ['edge.speed_limit', 'edge.length'], action: 'include' },
        },
        signal,
      ),
    );
    let pos = base;
    for (const e of (data?.edges ?? []) as { speed_limit?: number | string; length: number }[]) {
      const len = e.length * 1000;
      const lim = typeof e.speed_limit === 'number' ? e.speed_limit : NaN;
      if (lim > 0 && lim < 200) {
        const last = out[out.length - 1];
        if (last && last.limit === lim && Math.abs(last.to - pos) < 1) last.to = pos + len;
        else out.push({ from: pos, to: pos + len, limit: lim });
      }
      pos += len;
    }
  }
  return out;
}

export interface ElevationProfile {
  /** [afstand langs route (m), hoogte (m)] */
  points: [number, number][];
  ascent: number;
  descent: number;
  min: number;
  max: number;
}

/** Hoogteprofiel van de route. */
export async function elevation(r: Route, signal?: AbortSignal): Promise<ElevationProfile> {
  // Niet meer dan ~400 meetpunten opvragen
  const step = Math.max(50, Math.round(r.lengthM / 400));
  const pts: LatLng[] = [];
  let next = 0;
  for (let i = 0; i < r.shape.length; i++) {
    if (r.cum[i] >= next || i === r.shape.length - 1) {
      pts.push(r.shape[i]);
      next = r.cum[i] + step;
    }
  }
  const data = await post(
    'height',
    { shape: pts.map((p) => ({ lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5) })), range: true },
    signal,
  );
  const raw = (data?.range_height ?? []) as [number, number | null][];
  const points = raw.filter((p): p is [number, number] => p[1] !== null && p[1] > -500);
  // Gladstrijken (voortschrijdend gemiddelde) zodat ruis in de hoogtedata niet als klimmen telt
  const smooth = points.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(points.length - 1, i + 3); j++) {
      s += points[j][1];
      n++;
    }
    return s / n;
  });
  let ascent = 0;
  let descent = 0;
  // Alleen tellen als de hoogte echt een paar meter verandert (hysterese)
  let ref = smooth[0] ?? 0;
  for (const h of smooth) {
    if (h - ref >= 3) {
      ascent += h - ref;
      ref = h;
    } else if (ref - h >= 3) {
      descent += ref - h;
      ref = h;
    }
  }
  const hs = points.map((p) => p[1]);
  return {
    points,
    ascent: Math.round(ascent),
    descent: Math.round(descent),
    min: hs.length ? Math.min(...hs) : 0,
    max: hs.length ? Math.max(...hs) : 0,
  };
}

interface ValhallaManeuver {
  type: number;
  instruction: string;
  verbal_transition_alert_instruction?: string;
  verbal_pre_transition_instruction?: string;
  verbal_post_transition_instruction?: string;
  street_names?: string[];
  begin_shape_index: number;
  end_shape_index: number;
  length: number;
  time: number;
  roundabout_exit_count?: number;
  highway?: boolean;
  toll?: boolean;
  ferry?: boolean;
}

interface ValhallaLeg {
  shape: string;
  maneuvers: ValhallaManeuver[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTrip(trip: any, locations: RoutingLocation[]): Route {
  const shape: LatLng[] = [];
  const maneuvers: Maneuver[] = [];
  const legs: ValhallaLeg[] = trip.legs;
  legs.forEach((leg, li) => {
    const pts = decodePolyline(leg.shape);
    // Eerste punt van een vervolgleg is gelijk aan het laatste van de vorige.
    const offset = shape.length === 0 ? 0 : shape.length - 1;
    shape.push(...(shape.length === 0 ? pts : pts.slice(1)));
    for (const m of leg.maneuvers) {
      const isArrive = m.type === 4 || m.type === 5 || m.type === 6;
      const isDepart = m.type === 1 || m.type === 2 || m.type === 3;
      if (isArrive && li < legs.length - 1) continue; // tussenstop overslaan
      if (isDepart && li > 0) continue;
      maneuvers.push({
        type: m.type,
        instruction: m.instruction,
        alert: m.verbal_transition_alert_instruction,
        pre: m.verbal_pre_transition_instruction,
        post: m.verbal_post_transition_instruction,
        streets: m.street_names ?? [],
        beginShapeIndex: m.begin_shape_index + offset,
        endShapeIndex: m.end_shape_index + offset,
        lengthM: m.length * 1000,
        timeS: m.time,
        roundaboutExit: m.roundabout_exit_count,
        at: 0,
      });
    }
  });
  const cum = cumulative(shape);
  for (const m of maneuvers) m.at = cum[Math.min(m.beginShapeIndex, cum.length - 1)];
  const s = trip.summary;
  return {
    shape,
    cum,
    maneuvers,
    lengthM: s.length * 1000,
    timeS: s.time,
    hasHighway: !!s.has_highway,
    hasToll: !!s.has_toll,
    hasFerry: !!s.has_ferry,
    vias: locations.slice(1, -1).map(({ lat, lon }) => ({ lat, lon })),
    start: { lat: locations[0].lat, lon: locations[0].lon },
    end: { lat: locations[locations.length - 1].lat, lon: locations[locations.length - 1].lon },
  };
}
