import type { ElevationProfile } from '../lib/valhalla';

export function ElevationChart({ profile }: { profile: ElevationProfile }) {
  const pts = profile.points;
  if (pts.length < 2) return <p className="hint">Geen hoogtegegevens beschikbaar.</p>;
  const W = 320;
  const H = 90;
  const total = pts[pts.length - 1][0] || 1;
  const span = Math.max(20, profile.max - profile.min);
  const lo = profile.min - span * 0.1;
  const hi = profile.max + span * 0.15;
  const x = (d: number) => (d / total) * W;
  const y = (h: number) => H - ((h - lo) / (hi - lo)) * H;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
  const area = `${line}L${W} ${H}L0 ${H}Z`;
  return (
    <div className="elev">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Hoogteprofiel van ${Math.round(profile.min)} tot ${Math.round(profile.max)} meter`}>
        <defs>
          <linearGradient id="elevFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.45" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#elevFill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="elev-axis">
        <span>0 km</span>
        <span>{Math.round(total / 1000)} km</span>
      </div>
      <div className="elev-stats">
        <span>
          ↗ <b>{profile.ascent} m</b> klimmen
        </span>
        <span>
          ↘ <b>{profile.descent} m</b> dalen
        </span>
        <span>
          ▲ <b>{Math.round(profile.max)} m</b> hoogste punt
        </span>
      </div>
    </div>
  );
}
