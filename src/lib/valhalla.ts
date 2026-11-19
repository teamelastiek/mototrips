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
}

export const defaultPrefs: RoutePrefs = {
  curviness: 2,
  avoidHighways: true,
  roadType: 0.5,
  avoidTolls: true,
  avoidFerries: false,
  allowUnpaved: false,
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

  const res = await throttle(() =>
    fetch(`${getServer()}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    }),
  );
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.trip) {
    if (res.status === 429) throw new RoutingError('De routeserver is even druk. Probeer het over een minuut opnieuw.');
    throw new RoutingError(data?.error ? `Geen route gevonden: ${data.error}` : `Routeserver gaf fout ${res.status}`);
  }
  return parseTrip(data.trip, locations);
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
