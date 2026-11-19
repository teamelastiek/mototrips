// Geografische hulpfuncties: afstand, koers, projectie en route-analyse.

export interface LatLng {
  lat: number;
  lon: number;
}

const R = 6371008.8; // aardstraal in meters
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Afstand in meters tussen twee punten. */
export function distance(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Koers (0-360°) van a naar b. */
export function bearing(a: LatLng, b: LatLng): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Punt op afstand (m) en koers (°) vanaf een startpunt. */
export function destination(p: LatLng, distM: number, bearingDeg: number): LatLng {
  const δ = distM / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(p.lat);
  const λ1 = toRad(p.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 =
    λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** Kleinste hoekverschil (-180..180). */
export function angleDiff(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Cumulatieve afstanden (m) langs een lijn. */
export function cumulative(shape: LatLng[]): number[] {
  const out = new Array<number>(shape.length);
  out[0] = 0;
  for (let i = 1; i < shape.length; i++) out[i] = out[i - 1] + distance(shape[i - 1], shape[i]);
  return out;
}

/** Herbemonster een lijn op vaste stapgrootte (m). */
export function resample(shape: LatLng[], step: number): LatLng[] {
  if (shape.length < 2) return shape.slice();
  const out: LatLng[] = [shape[0]];
  let carry = 0;
  for (let i = 1; i < shape.length; i++) {
    const a = shape[i - 1];
    const b = shape[i];
    const seg = distance(a, b);
    if (seg === 0) continue;
    let pos = step - carry;
    while (pos <= seg) {
      const t = pos / seg;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      pos += step;
    }
    carry = seg - (pos - step);
  }
  return out;
}

export interface ShapeStats {
  /** Graden koersverandering per km, alleen echte bochten meegeteld. */
  curvature: number;
  /** Aandeel van de route dat over eerder gereden weg gaat (0-1). */
  overlap: number;
  /** Aantal keerpunten (doodlopende stukken heen en terug). */
  uTurns: number;
}

/**
 * Analyseer de vorm van een route. Bochtigheid wordt gemeten als som van
 * koersveranderingen over korte stukken; kruispunten en rotondes in de stad
 * tellen ook mee, maar die worden door de snelheid in de score gecorrigeerd.
 */
export function analyzeShape(shape: LatLng[]): ShapeStats {
  const pts = resample(shape, 40);
  const km = Math.max(0.1, (pts.length * 40) / 1000);
  let turn = 0;
  let uTurns = 0;
  const headings: number[] = [];
  for (let i = 1; i < pts.length; i++) headings.push(bearing(pts[i - 1], pts[i]));
  for (let i = 1; i < headings.length; i++) {
    const d = Math.abs(angleDiff(headings[i - 1], headings[i]));
    if (d > 150) {
      uTurns++;
      continue;
    }
    // Kleine ruis (<4°) negeren; bochten tellen tot max 90° per 40 m.
    if (d > 4) turn += Math.min(d, 90);
  }

  // Overlap: punten die dicht bij een eerder punt liggen (ver terug in de route).
  let overlapCount = 0;
  const cell = 0.0006; // ~50-60 m raster
  const grid = new Map<string, number[]>();
  for (let i = 0; i < pts.length; i++) {
    const gx = Math.floor(pts[i].lon / cell);
    const gy = Math.floor(pts[i].lat / cell);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const list = grid.get(`${gx + dx},${gy + dy}`);
        if (!list) continue;
        for (const j of list) {
          if (i - j > 25 && distance(pts[i], pts[j]) < 35) {
            hit = true;
            break;
          }
        }
      }
    }
    if (hit) overlapCount++;
    const key = `${gx},${gy}`;
    const l = grid.get(key);
    if (l) l.push(i);
    else grid.set(key, [i]);
  }

  return {
    curvature: turn / km,
    overlap: pts.length ? overlapCount / pts.length : 0,
    uTurns,
  };
}

export interface Projection {
  /** Index van het segment (shape[index] -> shape[index+1]). */
  index: number;
  /** Fractie binnen het segment. */
  t: number;
  /** Geprojecteerd punt. */
  point: LatLng;
  /** Afstand van het punt tot de lijn (m). */
  offset: number;
  /** Afstand langs de route vanaf het begin (m). */
  along: number;
}

/**
 * Projecteer een positie op de route. Zoekt in een venster rond de laatst
 * bekende index zodat de navigatie niet terugspringt bij lussen.
 */
export function projectOnRoute(
  pos: LatLng,
  shape: LatLng[],
  cum: number[],
  fromIndex = 0,
  window = Infinity,
): Projection | null {
  if (shape.length < 2) return null;
  const cosLat = Math.cos(toRad(pos.lat));
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * cosLat;
  let best: Projection | null = null;
  const start = Math.max(0, fromIndex);
  for (let i = start; i < shape.length - 1; i++) {
    if (cum[i] - cum[start] > window) break;
    const a = shape[i];
    const b = shape[i + 1];
    const ax = (a.lon - pos.lon) * mPerDegLon;
    const ay = (a.lat - pos.lat) * mPerDegLat;
    const bx = (b.lon - pos.lon) * mPerDegLon;
    const by = (b.lat - pos.lat) * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t;
    const py = ay + dy * t;
    const off = Math.hypot(px, py);
    if (!best || off < best.offset) {
      const point = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
      best = { index: i, t, point, offset: off, along: cum[i] + (cum[i + 1] - cum[i]) * t };
    }
  }
  return best;
}

/** Punt op een gegeven afstand langs de route. */
export function pointAlong(shape: LatLng[], cum: number[], along: number): { point: LatLng; index: number } {
  if (along <= 0) return { point: shape[0], index: 0 };
  const total = cum[cum.length - 1];
  if (along >= total) return { point: shape[shape.length - 1], index: shape.length - 2 };
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= along) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo];
  const t = seg === 0 ? 0 : (along - cum[lo]) / seg;
  const a = shape[lo];
  const b = shape[hi];
  return { point: { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t }, index: lo };
}

export function formatDistance(m: number): string {
  if (m < 50) return `${Math.max(0, Math.round(m / 5) * 5)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  if (m < 10000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 1000)} km`;
}

export function formatDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} u ${m.toString().padStart(2, '0')}`;
}
