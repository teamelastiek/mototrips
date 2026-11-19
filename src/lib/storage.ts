// Opgeslagen routes in de browser. We bewaren de punten + voorkeuren en
// de route zelf als gecomprimeerde lijn, zodat je hem offline kunt bekijken.
import type { LatLng } from './geo';
import type { Route, RoutePrefs } from './valhalla';

export interface SavedRoute {
  id: string;
  name: string;
  createdAt: number;
  mode: 'loop' | 'ab';
  prefs: RoutePrefs;
  start: LatLng;
  end: LatLng;
  vias: LatLng[];
  lengthM: number;
  timeS: number;
  curvature: number;
}

const KEY = 'mototrips.saved';

export function loadSaved(): SavedRoute[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}

function write(list: SavedRoute[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* opslag vol of geblokkeerd */
  }
}

export function saveRoute(r: Route, name: string, mode: 'loop' | 'ab', prefs: RoutePrefs, curvature: number): SavedRoute {
  const item: SavedRoute = {
    id: Math.random().toString(36).slice(2),
    name,
    createdAt: Date.now(),
    mode,
    prefs,
    start: r.start,
    end: r.end,
    vias: r.vias,
    lengthM: r.lengthM,
    timeS: r.timeS,
    curvature,
  };
  write([item, ...loadSaved()]);
  return item;
}

export function deleteSaved(id: string) {
  write(loadSaved().filter((s) => s.id !== id));
}

const PLAN_KEY = 'mototrips.plan';
export function loadPlanSettings<T>(fallback: T): T {
  try {
    const v = localStorage.getItem(PLAN_KEY);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch {
    return fallback;
  }
}
export function savePlanSettings(v: unknown) {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(v));
  } catch {
    /* negeren */
  }
}
