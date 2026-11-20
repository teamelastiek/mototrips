// Lopende rit bewaren, zodat je na het afsluiten van de app gewoon verder rijdt.
// De route (groot) en de voortgang (klein, vaak) staan apart, zodat we niet elke keer alles wegschrijven.
import type { Poi } from './overpass';
import type { RecorderSnapshot } from './logbook';
import type { Route } from './valhalla';

const ROUTE_KEY = 'mototrips.ride.route';
const STATE_KEY = 'mototrips.ride.state';
/** Langer dan dit niets van je gehoord? Dan is de rit voorbij. */
const MAX_AGE_MS = 6 * 3600 * 1000;

export interface ActiveRideState {
  name: string;
  fuel: Poi[];
  intercom: boolean;
  along: number;
  recorder?: RecorderSnapshot;
  savedAt: number;
}

export interface ActiveRide extends ActiveRideState {
  route: Route;
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* vol of geblokkeerd: dan maar geen hervatten */
  }
}

/** Nieuwe rit gestart. */
export function startActiveRide(s: Omit<ActiveRideState, 'along' | 'savedAt'>) {
  write(STATE_KEY, { ...s, along: 0, savedAt: Date.now() });
}

/** Route opslaan (bij de start en na elke herberekening). */
export function saveRideRoute(r: Route) {
  const round = (p: { lat: number; lon: number }) => ({ lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) });
  write(ROUTE_KEY, { ...r, shape: r.shape.map(round), cum: r.cum.map((c) => Math.round(c * 10) / 10) });
}

export function updateActiveRide(patch: Partial<ActiveRideState>) {
  const cur = readState();
  if (!cur) return;
  write(STATE_KEY, { ...cur, ...patch, savedAt: Date.now() });
}

function readState(): ActiveRideState | null {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
  } catch {
    return null;
  }
}

export function loadActiveRide(): ActiveRide | null {
  try {
    const s = readState();
    const route = JSON.parse(localStorage.getItem(ROUTE_KEY) || 'null') as Route | null;
    if (!s || !route?.shape?.length || Date.now() - s.savedAt > MAX_AGE_MS) {
      clearActiveRide();
      return null;
    }
    return { ...s, route };
  } catch {
    clearActiveRide();
    return null;
  }
}

export function clearActiveRide() {
  try {
    localStorage.removeItem(ROUTE_KEY);
    localStorage.removeItem(STATE_KEY);
  } catch {
    /* negeren */
  }
}
