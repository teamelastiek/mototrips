// Routes delen via een link: alle punten en voorkeuren zitten in de URL zelf.
import type { LatLng } from './geo';
import type { RoutePrefs } from './valhalla';

export interface SharedRoute {
  name: string;
  mode: 'loop' | 'ab';
  start: LatLng;
  end: LatLng;
  vias: LatLng[];
  prefs: RoutePrefs;
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;
const pt = (p: LatLng) => [r5(p.lat), r5(p.lon)];
const unpt = (a: number[]): LatLng => ({ lat: a[0], lon: a[1] });

function b64urlEncode(s: string) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeShare(r: SharedRoute): string {
  const p = r.prefs;
  const data = {
    n: r.name,
    m: r.mode === 'loop' ? 0 : 1,
    s: pt(r.start),
    e: pt(r.end),
    v: r.vias.map(pt),
    p: [p.curviness, p.avoidHighways ? 1 : 0, Math.round(p.roadType * 100), p.avoidTolls ? 1 : 0, p.avoidFerries ? 1 : 0, p.allowUnpaved ? 1 : 0, p.avoidCities ? 1 : 0, p.preferNew ? 1 : 0],
  };
  return b64urlEncode(JSON.stringify(data));
}

export function decodeShare(code: string): SharedRoute | null {
  try {
    const d = JSON.parse(b64urlDecode(code));
    const p = d.p as number[];
    return {
      name: String(d.n ?? 'Gedeelde route').slice(0, 120),
      mode: d.m === 0 ? 'loop' : 'ab',
      start: unpt(d.s),
      end: unpt(d.e),
      vias: (d.v as number[][]).map(unpt),
      prefs: {
        curviness: p[0] ?? 2,
        avoidHighways: !!p[1],
        roadType: (p[2] ?? 50) / 100,
        avoidTolls: !!p[3],
        avoidFerries: !!p[4],
        allowUnpaved: !!p[5],
        avoidCities: !!p[6],
        preferNew: !!p[7],
      },
    };
  } catch {
    return null;
  }
}

export function shareUrl(r: SharedRoute): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}#r=${encodeShare(r)}`;
}

/** Leest een gedeelde route uit de huidige URL (en haalt hem daarna weg). */
export function takeSharedFromUrl(): SharedRoute | null {
  const m = location.hash.match(/[#&]r=([\w-]+)/);
  if (!m) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return decodeShare(m[1]);
}

/** Deelt via het deelmenu van de telefoon, of kopieert de link. */
export async function shareRoute(r: SharedRoute): Promise<'shared' | 'copied' | 'failed'> {
  const url = shareUrl(r);
  const text = `Motorroute: ${r.name}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: r.name, text, url });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'failed';
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    prompt('Kopieer deze link:', url);
    return 'copied';
  }
}
