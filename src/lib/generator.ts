// Routegenerator: maakt rondjes en A→B-routes en kiest de mooiste op basis van bochten.
import { analyzeShape, bearing, destination, distance, type LatLng, type ShapeStats } from './geo';
import { route, RoutingError, type Route, type RoutePrefs, type RoutingLocation } from './valhalla';

export type TargetKind = 'distance' | 'time' | 'none';

export interface PlanRequest {
  mode: 'loop' | 'ab';
  start: LatLng;
  end?: LatLng;
  target: { kind: TargetKind; value: number }; // km of minuten
  prefs: RoutePrefs;
}

export interface Candidate {
  id: string;
  label: string;
  route: Route;
  stats: ShapeStats & { avgSpeedKmh: number };
  score: number;
  /** Afwijking van het doel (0.1 = 10% te lang). */
  deviation: number;
}

const COMPASS = ['noord', 'noordoost', 'oost', 'zuidoost', 'zuid', 'zuidwest', 'west', 'noordwest'];
const compassName = (deg: number) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
const rand = (a: number, b: number) => a + Math.random() * (b - a);

/** Geschatte gemiddelde snelheid (km/u) om een tijd-doel om te zetten naar afstand. */
function estimatedSpeed(p: RoutePrefs): number {
  let v = p.avoidHighways ? 58 : 70;
  v -= p.curviness * 4;
  v += (p.roadType - 0.5) * 10;
  return v;
}

function viaRoadClass(p: RoutePrefs): RoutingLocation['minRoadClass'] {
  if (p.allowUnpaved) return 'residential';
  if (p.roadType > 0.7) return 'secondary';
  if (p.roadType > 0.35) return 'tertiary';
  return 'unclassified';
}

function measure(r: Route, kind: TargetKind) {
  return kind === 'time' ? r.timeS / 60 : r.lengthM / 1000;
}

function score(r: Route, prefs: RoutePrefs, deviation: number, extraPenalty = 0) {
  const shape = analyzeShape(r.shape);
  const avgSpeedKmh = r.lengthM / 1000 / (r.timeS / 3600);
  const wCurve = prefs.curviness / 3;
  let s = 0;
  // Bochtigheid: logaritmisch zodat extreem kronkelige stadsstukken niet domineren.
  s += wCurve * 2.2 * Math.log1p(shape.curvature / 30);
  // Wie rustig wil rijden, waardeert een vlotte doorstroming.
  s += (1 - wCurve) * 0.02 * Math.min(avgSpeedKmh, 90);
  // Erg lage gemiddelde snelheid = veel bebouwde kom / stoplichten.
  if (avgSpeedKmh < 38) s -= (38 - avgSpeedKmh) * 0.06;
  s -= shape.overlap * 6; // heen-en-weer over dezelfde weg
  s -= shape.uTurns * 0.6;
  s -= Math.abs(deviation) * 4;
  if (prefs.avoidHighways && r.hasHighway) s -= 1.5;
  if (prefs.avoidTolls && r.hasToll) s -= 1;
  s -= extraPenalty;
  return { s, stats: { ...shape, avgSpeedKmh } };
}

async function safeRoute(locs: RoutingLocation[], prefs: RoutePrefs, signal?: AbortSignal): Promise<Route | null> {
  try {
    return await route(locs, prefs, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    // Doorgangspunt lag misschien op een doodlopende weg: probeer als gewoon tussenpunt.
    if (locs.length > 2) {
      try {
        return await route(
          locs.map((l, i) => (i === 0 || i === locs.length - 1 ? l : { ...l, type: 'via' as const })),
          prefs,
          signal,
        );
      } catch (e2) {
        if (signal?.aborted) throw e2;
      }
    }
    if (e instanceof RoutingError && /druk/.test(e.message)) throw e;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rondje
// ---------------------------------------------------------------------------

function loopPoints(start: LatLng, radius: number, heading: number, angles: number[], radii: number[]): LatLng[] {
  const center = destination(start, radius, heading);
  const startAngle = (heading + 180) % 360; // vanuit het centrum gezien ligt de start hier
  return angles.map((a, i) => destination(center, radius * radii[i], startAngle + a));
}

async function makeLoop(
  req: PlanRequest,
  heading: number,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  const { prefs, start } = req;
  const targetKm =
    req.target.kind === 'distance'
      ? req.target.value
      : req.target.kind === 'time'
        ? (req.target.value / 60) * estimatedSpeed(prefs)
        : 80;
  const target = req.target.kind === 'none' ? 80 : req.target.value;
  const kind: TargetKind = req.target.kind === 'none' ? 'distance' : req.target.kind;

  const n = prefs.curviness >= 2 ? (Math.random() < 0.5 ? 3 : 4) : 3;
  const dir = Math.random() < 0.5 ? 1 : -1;
  const angles = Array.from({ length: n }, (_, k) => dir * ((360 / (n + 1)) * (k + 1) + rand(-12, 12)));
  const radii = Array.from({ length: n }, () => rand(0.82, 1.15));
  // Wegen zijn langer dan de cirkel: corrigeer met een omrijfactor.
  let radius = (targetKm * 1000) / (2 * Math.PI * 1.3);

  let best: { r: Route; dev: number } | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const vias = loopPoints(start, radius, heading, angles, radii);
    const cls = viaRoadClass(prefs);
    const r = await safeRoute(
      [{ ...start, type: 'break' }, ...vias.map((v) => ({ ...v, type: 'through' as const, minRoadClass: cls })), { ...start, type: 'break' }],
      prefs,
      signal,
    );
    if (!r) return best ? toCandidate(best.r, best.dev) : null;
    const actual = measure(r, kind);
    const dev = actual / target - 1;
    if (!best || Math.abs(dev) < Math.abs(best.dev)) best = { r, dev };
    if (Math.abs(dev) < 0.1 || req.target.kind === 'none') break;
    radius *= Math.max(0.5, Math.min(1.8, target / actual));
  }
  return best ? toCandidate(best.r, best.dev) : null;

  function toCandidate(r: Route, dev: number): Candidate {
    const { s, stats } = score(r, prefs, req.target.kind === 'none' ? 0 : dev);
    return {
      id: Math.random().toString(36).slice(2),
      label: `Rondje richting ${compassName(heading)}`,
      route: r,
      stats,
      score: s,
      deviation: req.target.kind === 'none' ? 0 : dev,
    };
  }
}

// ---------------------------------------------------------------------------
// Van A naar B
// ---------------------------------------------------------------------------

async function makeAB(
  req: PlanRequest,
  side: number,
  h: number,
  nVias: number,
  directM: number,
  signal?: AbortSignal,
): Promise<Candidate | null> {
  const { prefs, start } = req;
  const end = req.end!;
  const brg = bearing(start, end);
  const kind = req.target.kind;
  const D = distance(start, end);

  let offset = h;
  let best: { r: Route; dev: number } | null = null;
  for (let attempt = 0; attempt < (kind === 'none' || h === 0 ? 1 : 3); attempt++) {
    const vias: LatLng[] = [];
    for (let k = 1; k <= nVias; k++) {
      const frac = k / (nVias + 1) + rand(-0.05, 0.05);
      const onLine = destination(start, D * frac, brg);
      // Bij twee punten: beide aan dezelfde kant, zodat er een mooie boog ontstaat
      vias.push(destination(onLine, offset * rand(0.85, 1.1), brg + 90 * side));
    }
    const cls = viaRoadClass(prefs);
    const r = await safeRoute(
      [{ ...start, type: 'break' }, ...vias.map((v) => ({ ...v, type: 'through' as const, minRoadClass: cls })), { ...end, type: 'break' }],
      prefs,
      signal,
    );
    if (!r) break;
    let dev = 0;
    if (kind !== 'none') {
      const actual = measure(r, kind);
      dev = actual / req.target.value - 1;
      if (!best || Math.abs(dev) < Math.abs(best.dev)) best = { r, dev };
      if (Math.abs(dev) < 0.1) break;
      // Grove correctie van de zijwaartse uitwijking
      offset *= Math.max(0.4, Math.min(2, (req.target.value / actual) ** 1.6));
    } else {
      best = { r, dev: 0 };
    }
  }
  if (!best) return null;
  // Zonder doel: lichte straf voor omrijden, afhankelijk van hoeveel bochten je wilt.
  const detour = best.r.lengthM / directM - 1;
  const penalty = kind === 'none' ? Math.max(0, detour) * (2.5 - (prefs.curviness / 3) * 2) : 0;
  const { s, stats } = score(best.r, prefs, best.dev, penalty);
  const label =
    h === 0 ? 'Meest directe route' : `Via de ${side > 0 ? 'rechter' : 'linker'}kant${nVias > 1 ? ' (ruime boog)' : ''}`;
  return { id: Math.random().toString(36).slice(2), label, route: best.r, stats, score: s, deviation: best.dev };
}

// ---------------------------------------------------------------------------

export async function generate(
  req: PlanRequest,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Candidate[]> {
  const results: Candidate[] = [];
  let done = 0;

  const run = async (jobs: (() => Promise<Candidate | null>)[]) => {
    onProgress?.(0, jobs.length);
    await Promise.all(
      jobs.map(async (job) => {
        const c = await job();
        if (c) results.push(c);
        onProgress?.(++done, jobs.length);
      }),
    );
  };

  if (req.mode === 'loop') {
    const base = rand(0, 360);
    const N = 6;
    await run(Array.from({ length: N }, (_, i) => () => makeLoop(req, (base + (i * 360) / N + rand(-15, 15)) % 360, signal)));
  } else {
    if (!req.end) throw new Error('Kies een bestemming');
    const direct = await route([req.start, req.end], req.prefs, signal);
    const directM = direct.lengthM;
    const D = distance(req.start, req.end);
    const jobs: (() => Promise<Candidate | null>)[] = [];

    const targetM =
      req.target.kind === 'distance'
        ? req.target.value * 1000
        : req.target.kind === 'time'
          ? (req.target.value / 60) * estimatedSpeed(req.prefs) * 1000
          : 0;

    if (targetM > directM * 1.1) {
      // Omrijden om aan de gewenste afstand/tijd te komen.
      const f = 1.25;
      const h = Math.sqrt(Math.max(0, (targetM / (2 * f)) ** 2 - (D / 2) ** 2));
      for (const side of [1, -1]) {
        jobs.push(() => makeAB(req, side, h, 1, directM, signal));
        jobs.push(() => makeAB(req, side, h * 0.8, 2, directM, signal));
      }
    } else {
      jobs.push(async () => {
        const dev = req.target.kind === 'none' ? 0 : measure(direct, req.target.kind) / req.target.value - 1;
        const { s, stats } = score(direct, req.prefs, req.target.kind === 'none' ? 0 : Math.max(0, -dev));
        return { id: 'direct', label: 'Meest directe route', route: direct, stats, score: s, deviation: dev };
      });
      const spreads = req.prefs.curviness >= 2 ? [0.18, 0.32] : [0.12, 0.22];
      for (const side of [1, -1]) for (const sp of spreads) jobs.push(() => makeAB({ ...req, target: { kind: 'none', value: 0 } }, side, D * sp, sp > 0.25 ? 2 : 1, directM, signal));
    }
    await run(jobs);
  }

  if (!results.length) throw new RoutingError('Er kon geen route worden gemaakt. Probeer een ander startpunt of andere instellingen.');

  // Dubbele routes (bijna gelijke lengte en vorm) weghalen
  results.sort((a, b) => b.score - a.score);
  const unique: Candidate[] = [];
  for (const c of results) {
    const dup = unique.some(
      (u) =>
        Math.abs(u.route.lengthM - c.route.lengthM) < 300 &&
        distance(u.route.shape[Math.floor(u.route.shape.length / 2)], c.route.shape[Math.floor(c.route.shape.length / 2)]) < 500,
    );
    if (!dup) unique.push(c);
  }
  return unique.slice(0, 4);
}

/** Bochtigheid als 1-5 sterren voor weergave. */
export function curvinessStars(curvature: number): number {
  // Grofweg: polder ±25°/km, Veluwe-binnenwegen ±60, Ardennen 120+
  if (curvature < 30) return 1;
  if (curvature < 50) return 2;
  if (curvature < 75) return 3;
  if (curvature < 110) return 4;
  return 5;
}
