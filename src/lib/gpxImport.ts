// GPX-bestanden inlezen (van een motorclub, forum, Garmin, enz.) en er een
// navigeerbare route met afslagen van maken.
import { distance, resample, type LatLng } from './geo';
import { MAX_LOCATIONS, route, routeMany, traceRoute, type Route, type RoutePrefs } from './valhalla';

export interface GpxData {
  name: string;
  track: LatLng[]; // trk/trkpt (opgenomen of getekend spoor)
  routePoints: LatLng[]; // rte/rtept (routepunten)
  waypoints: LatLng[];
}

function readPoints(doc: Document, tag: string): LatLng[] {
  return Array.from(doc.getElementsByTagName(tag))
    .map((el) => ({ lat: parseFloat(el.getAttribute('lat') ?? ''), lon: parseFloat(el.getAttribute('lon') ?? '') }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}

export function parseGpx(xml: string, fileName = 'Geïmporteerde route'): GpxData {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Dit is geen geldig GPX-bestand.');
  const name =
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    doc.querySelector('trk > name, rte > name')?.textContent?.trim() ||
    fileName.replace(/\.gpx$/i, '');
  const data = {
    name,
    track: readPoints(doc, 'trkpt'),
    routePoints: readPoints(doc, 'rtept'),
    waypoints: readPoints(doc, 'wpt'),
  };
  if (data.track.length < 2 && data.routePoints.length < 2) throw new Error('Het GPX-bestand bevat geen route of spoor.');
  return data;
}

export function isLoop(points: LatLng[]): boolean {
  return points.length > 2 && distance(points[0], points[points.length - 1]) < 300;
}

/**
 * Maak er een route van. Een spoor wordt aan de weg gekoppeld zodat de vorm
 * exact gevolgd wordt; lukt dat niet, dan rijden we via punten op het spoor.
 */
export async function gpxToRoute(gpx: GpxData, prefs: RoutePrefs, signal?: AbortSignal): Promise<Route> {
  if (gpx.track.length >= 2) {
    const pts = resample(gpx.track, 30);
    pts.push(gpx.track[gpx.track.length - 1]);
    try {
      const r = await traceRoute(pts, prefs, signal);
      // Tussenpunten bewaren (voor herberekenen/delen): elke ~15 km een punt
      r.vias = sampleVias(pts, 15000);
      r.start = pts[0];
      r.end = pts[pts.length - 1];
      return r;
    } catch (e) {
      if (signal?.aborted) throw e;
      // terugval: via punten om de ~5 km
      const vias = sampleVias(pts, 5000);
      return routeMany([pts[0], ...vias, pts[pts.length - 1]], prefs, signal);
    }
  }
  const rp = gpx.routePoints;
  if (rp.length <= MAX_LOCATIONS) return route(rp, prefs, signal);
  return routeMany(rp, prefs, signal);
}

function sampleVias(pts: LatLng[], every: number): LatLng[] {
  const out: LatLng[] = [];
  let acc = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    acc += distance(pts[i - 1], pts[i]);
    if (acc >= every) {
      out.push(pts[i]);
      acc = 0;
    }
  }
  return out;
}

export function pickGpxFile(): Promise<{ text: string; name: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.gpx,application/gpx+xml,application/xml,text/xml';
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { text: await f.text(), name: f.name } : null);
    };
    input.click();
  });
}
