// Pijl-icoon per Valhalla-manoeuvretype.

const ANGLE: Record<number, number> = {
  0: 0, 1: 0, 7: 0, 8: 0, 17: 0, 22: 0, 25: 0, 28: 0, 29: 0,
  9: 40, 18: 40, 20: 40, 23: 30, 37: 30,
  2: 90, 10: 90, 5: 90,
  11: 135,
  14: -135,
  3: -90, 15: -90, 6: -90,
  16: -40, 19: -40, 21: -40, 24: -30, 38: -30,
};

export function ManeuverIcon({ type, exit, size = 64 }: { type: number; exit?: number; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 100 100',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 11,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (type === 4) {
    return (
      <svg {...common} strokeWidth={8}>
        <path d="M30 92V12" />
        <path d="M30 14h44l-10 16 10 16H30" fill="currentColor" />
      </svg>
    );
  }

  if (type === 26 || type === 27) {
    return (
      <svg {...common}>
        <circle cx="50" cy="44" r="20" strokeWidth={9} />
        <path d="M50 92V64" />
        <path d="M64 30l16-16" />
        <path d="M66 12h16v16" strokeWidth={9} />
        {exit ? (
          <text x="50" y="52" textAnchor="middle" fontSize="26" fontWeight="800" fill="currentColor" stroke="none" fontFamily="inherit">
            {exit}
          </text>
        ) : null}
      </svg>
    );
  }

  if (type === 12 || type === 13) {
    const flip = type === 13 ? -1 : 1;
    return (
      <svg {...common} transform={`scale(${-flip},1)`}>
        <path d="M66 92V40a16 16 0 0 0-32 0v30" />
        <path d="M22 60l12 14 12-14" strokeWidth={9} />
      </svg>
    );
  }

  const a = ((ANGLE[type] ?? 0) * Math.PI) / 180;
  const jx = 50;
  const jy = 54;
  const L = 34;
  const ex = jx + L * Math.sin(a);
  const ey = jy - L * Math.cos(a);
  // Pijlpunt
  const hl = 16;
  const back = a + Math.PI;
  const h1x = ex + hl * Math.sin(back + 0.6);
  const h1y = ey - hl * Math.cos(back + 0.6);
  const h2x = ex + hl * Math.sin(back - 0.6);
  const h2y = ey - hl * Math.cos(back - 0.6);
  return (
    <svg {...common}>
      <path d={`M50 94V${jy}L${ex.toFixed(1)} ${ey.toFixed(1)}`} />
      <path d={`M${h1x.toFixed(1)} ${h1y.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}L${h2x.toFixed(1)} ${h2y.toFixed(1)}`} strokeWidth={9} />
    </svg>
  );
}
