// Ritlogboek: rit opnemen tijdens het navigeren, statistieken bewaren, en
// onthouden welke wegen je al gereden hebt (voor "Ontdek nieuwe wegen").
import { angleDiff, bearing, distance, resample, type LatLng } from './geo';
import { decodePolyline } from './valhalla';

export interface RideRecord {
  id: string;
  name: string;
  startedAt: number;
  endedAt: number;
  distanceM: number;
  movingS: number;
  maxKmh: number;
  avgKmh: number;
  maxLeanLeft: number;
  maxLeanRight: number;
  /** Gereden spoor als polyline (precisie 5) */
  track: string;
}

export interface RecorderFix extends LatLng {
  speed?: number | null; // m/s
  accuracy?: number;
  time: number;
}

const G = 9.81;

/** Neemt een rit op en schat de hellingshoek uit snelheid en draaisnelheid. */
export class RideRecorder {
  private track: LatLng[] = [];
  private last?: RecorderFix;
  private lastHeading?: number;
  private yawRate = 0; // rad/s, gladgestreken
  distanceM = 0;
  movingS = 0;
  maxKmh = 0;
  maxLeanLeft = 0;
  maxLeanRight = 0;
  /** Huidige geschatte hellingshoek (graden, + = rechts, - = links) */
  lean = 0;
  readonly startedAt = Date.now();

  add(f: RecorderFix) {
    if (f.accuracy !== undefined && f.accuracy > 40) return; // te onnauwkeurig
    const p = { lat: f.lat, lon: f.lon };
    if (!this.last) {
      this.last = f;
      this.track.push(p);
      return;
    }
    const dt = (f.time - this.last.time) / 1000;
    if (dt <= 0) return;
    const d = distance(this.last, p);
    const v = f.speed != null && !Number.isNaN(f.speed) ? f.speed : d / dt;
    const kmh = v * 3.6;
    if (kmh > 260) return; // GPS-sprong

    if (kmh > 4) {
      this.movingS += dt;
      this.distanceM += d;
    }
    // Maximumsnelheid alleen meetellen bij een betrouwbare fix
    if ((f.accuracy ?? 10) < 25) this.maxKmh = Math.max(this.maxKmh, kmh);

    // Hellingshoek: tan(hoek) = snelheid × draaisnelheid / g
    if (d > 3) {
      const h = bearing(this.last, p);
      if (this.lastHeading !== undefined && kmh > 25) {
        const w = (angleDiff(this.lastHeading, h) * Math.PI) / 180 / dt;
        // Gladstrijken: één GPS-hik mag geen 60° opleveren
        this.yawRate = this.yawRate * 0.6 + w * 0.4;
        const lean = (Math.atan((v * this.yawRate) / G) * 180) / Math.PI;
        this.lean = Math.max(-55, Math.min(55, lean));
        if (this.lean > this.maxLeanRight) this.maxLeanRight = this.lean;
        if (-this.lean > this.maxLeanLeft) this.maxLeanLeft = -this.lean;
      } else {
        this.lean *= 0.5;
      }
      this.lastHeading = h;
    }
    if (distance(this.track[this.track.length - 1], p) >= 15) this.track.push(p);
    this.last = f;
  }

  finish(name: string): RideRecord | null {
    if (this.distanceM < 500 || this.track.length < 3) return null;
    const rec: RideRecord = {
      id: Math.random().toString(36).slice(2),
      name,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      distanceM: this.distanceM,
      movingS: this.movingS,
      maxKmh: this.maxKmh,
      avgKmh: this.movingS > 0 ? (this.distanceM / this.movingS) * 3.6 : 0,
      maxLeanLeft: Math.round(this.maxLeanLeft),
      maxLeanRight: Math.round(this.maxLeanRight),
      track: encodePolyline(this.track),
    };
    saveRide(rec);
    markRidden(this.track);
    return rec;
  }
}

export function encodePolyline(pts: LatLng[], precision = 5): string {
  const f = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let out = '';
  const enc = (v: number) => {
    let s = v < 0 ? ~(v << 1) : v << 1;
    while (s >= 0x20) {
      out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
      s >>= 5;
    }
    out += String.fromCharCode(s + 63);
  };
  for (const p of pts) {
    const lat = Math.round(p.lat * f);
    const lon = Math.round(p.lon * f);
    enc(lat - lastLat);
    enc(lon - lastLon);
    lastLat = lat;
    lastLon = lon;
  }
  return out;
}

export const rideTrack = (r: RideRecord) => decodePolyline(r.track, 5);

// ---------------- opslag ----------------

const RIDES = 'mototrips.rides';
const RIDDEN = 'mototrips.ridden';

export function loadRides(): RideRecord[] {
  try {
    return JSON.parse(localStorage.getItem(RIDES) || '[]');
  } catch {
    return [];
  }
}

function saveRide(r: RideRecord) {
  try {
    localStorage.setItem(RIDES, JSON.stringify([r, ...loadRides()].slice(0, 200)));
  } catch {
    /* opslag vol */
  }
}

export function deleteRide(id: string) {
  try {
    localStorage.setItem(RIDES, JSON.stringify(loadRides().filter((r) => r.id !== id)));
  } catch {
    /* negeren */
  }
}

// Gereden wegen als raster van ~55 m vakjes
const cellKey = (p: LatLng) => `${Math.round(p.lat / 0.0005)},${Math.round(p.lon / 0.0008)}`;
let riddenCache: Set<string> | null = null;

export function riddenCells(): Set<string> {
  if (riddenCache) return riddenCache;
  try {
    riddenCache = new Set(JSON.parse(localStorage.getItem(RIDDEN) || '[]'));
  } catch {
    riddenCache = new Set();
  }
  return riddenCache;
}

export function markRidden(track: LatLng[]) {
  const set = riddenCells();
  for (const p of resample(track, 40)) set.add(cellKey(p));
  try {
    localStorage.setItem(RIDDEN, JSON.stringify([...set]));
  } catch {
    /* opslag vol */
  }
}

export function clearRidden() {
  riddenCache = new Set();
  try {
    localStorage.removeItem(RIDDEN);
  } catch {
    /* negeren */
  }
}

/** Aandeel van een route (0-1) dat over nog niet gereden wegen gaat. */
export function newRoadShare(shape: LatLng[]): number {
  const set = riddenCells();
  if (!set.size) return 1;
  const pts = resample(shape, 80);
  if (!pts.length) return 1;
  let fresh = 0;
  for (const p of pts) if (!set.has(cellKey(p))) fresh++;
  return fresh / pts.length;
}
