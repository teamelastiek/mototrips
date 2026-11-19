// GPX-export zodat je de route ook in een Garmin, TomTom Rider of andere app kunt laden.
import type { Route } from './valhalla';

const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export function toGpx(r: Route, name: string): string {
  const pt = (p: { lat: number; lon: number }) => `lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"`;
  const routePoints = [r.start, ...r.vias, r.end]
    .map((p, i, arr) => `    <rtept ${pt(p)}><name>${i === 0 ? 'Start' : i === arr.length - 1 ? 'Einde' : `Via ${i}`}</name></rtept>`)
    .join('\n');
  const track = r.shape.map((p) => `      <trkpt ${pt(p)}/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="MotoTrips" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <rte>
    <name>${esc(name)}</name>
${routePoints}
  </rte>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${track}
    </trkseg>
  </trk>
</gpx>
`;
}

export function downloadGpx(r: Route, name: string) {
  const blob = new Blob([toGpx(r, name)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'route'}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
