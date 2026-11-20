import { useEffect, useMemo, useRef, useState } from 'react';
import type { Place } from '../lib/geocode';
import { searchPlaces } from '../lib/geocode';
import { formatDistance, formatDuration, pointAlong, projectOnRoute, type LatLng } from '../lib/geo';
import { placesAlong, poiIcon, type Poi, type PoiKind } from '../lib/overpass';
import { formatClock } from '../lib/sun';
import type { ElevationProfile, Route } from '../lib/valhalla';
import { alongAtTime, timeAtAlong, weatherLabel, weatherWarnings, type WeatherPoint } from '../lib/weather';
import { ElevationChart } from './ElevationChart';

export type Loadable<T> = { state: 'idle' | 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: T };

export interface RouteExtras {
  elevation: Loadable<ElevationProfile>;
  weather: Loadable<WeatherPoint[]>;
  /** Tankstations langs de hele route */
  pois: Loadable<Poi[]>;
}

interface Props {
  route: Route;
  extras: RouteExtras;
  departure: Date;
  setDeparture: (d: Date) => void;
  fuelRangeKm: number;
  sun: { sunset: Date; arrival: Date; darkMinutes: number; startsDark: boolean } | null;
  onAddStop: (p: LatLng) => void;
  onFocus: (p: LatLng) => void;
  onRetry: (what: keyof RouteExtras) => void;
  /** Welke plekken nu in het paneel staan (die tonen we ook op de kaart) */
  onShowPois: (pois: Poi[]) => void;
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StatusLine({ l, onRetry }: { l: Loadable<unknown>; onRetry: () => void }) {
  if (l.state === 'loading' || l.state === 'idle') return <p className="hint loading-line">Zoeken…</p>;
  if (l.state === 'error')
    return (
      <p className="hint">
        {l.error}{' '}
        <button className="link-btn" onClick={onRetry}>
          Opnieuw
        </button>
      </p>
    );
  return null;
}

/** "na 35 min · 28 km" (en eventueel hoe ver van de route) */
function whenLabel(route: Route, p: Poi) {
  // Ver van de route? Dan zegt 'na x min' niets: alleen de afstand tot de route
  if (p.offset > 3000) return `${formatDistance(p.offset)} van de route`;
  const t = timeAtAlong(route, p.along);
  return `na ${formatDuration(t)} · ${formatDistance(p.along)}${p.offset > 150 ? ` · ${formatDistance(p.offset)} van de route` : ''}`;
}

function PoiRow({ route, p, onAdd, onFocus }: { route: Route; p: Poi; onAdd: () => void; onFocus: () => void }) {
  const [added, setAdded] = useState(false);
  return (
    <li className="poi">
      <button className="poi-main" onClick={onFocus}>
        <span className="poi-icon">{poiIcon(p.kind)}</span>
        <span className="poi-text">
          <strong>{p.name}</strong>
          <small>{whenLabel(route, p)}</small>
        </span>
      </button>
      <button
        className="secondary small"
        disabled={added}
        onClick={() => {
          setAdded(true);
          onAdd();
        }}
      >
        {added ? 'Toegevoegd' : '+ Stop'}
      </button>
    </li>
  );
}

/** Welke tankstations we voorstellen voor deze route (op basis van je tankbereik). */
export function stopSuggestions(route: Route, fuel: Poi[], fuelRangeKm: number) {
  const km = route.lengthM / 1000;
  // Tanken: past de rit niet in één tank (met 15% marge), zoek stations vóór elk tankmoment
  const needsFuel = km > fuelRangeKm * 0.85;
  const fuelPoints: number[] = [];
  if (needsFuel) for (let d = fuelRangeKm * 0.7; d < km - 15; d += fuelRangeKm * 0.7) fuelPoints.push(d * 1000);
  const suggested = fuelPoints.flatMap((target) =>
    fuel
      .filter((p) => p.along <= target && p.along > target - fuelRangeKm * 350)
      .sort((a, b) => b.along - a.along)
      .slice(0, 2),
  );
  const fuelList = needsFuel ? suggested : fuel.filter((p) => p.offset < 400).slice(0, 6);
  return { needsFuel, fuelList, allFuel: fuel };
}

const PAUSE_WINDOW_S = 10 * 60; // zoek ±10 minuten rijden rond het gekozen pauzemoment

export function RouteDetails({ route, extras, departure, setDeparture, fuelRangeKm, sun, onAddStop, onFocus, onRetry, onShowPois }: Props) {
  const [open, setOpenState] = useState<'fuel' | 'pause' | 'own' | null>(null);
  const [fuelMode, setFuelMode] = useState<'suggested' | 'all'>('suggested');
  // Tankstations pas ophalen als je die sectie openklapt
  const setOpen = (v: 'fuel' | 'pause' | 'own' | null) => {
    setOpenState(v);
    if (v === 'fuel' && extras.pois.state === 'idle') onRetry('pois');
  };
  const fuel = extras.pois.state === 'ok' ? extras.pois.data : [];
  const { needsFuel, fuelList, allFuel } = stopSuggestions(route, fuel, fuelRangeKm);
  const shownFuel = fuelMode === 'all' ? allFuel : fuelList;

  // ---------- pauze: zelf kiezen wanneer
  const totalMin = Math.max(10, Math.floor(route.timeS / 60));
  const [pauseMin, setPauseMin] = useState(() => Math.max(10, Math.round(route.timeS / 60 / 2 / 10) * 10));
  const [food, setFood] = useState<{ key: string; l: Loadable<Poi[]> }>({ key: '', l: { state: 'idle' } });
  const foodCache = useRef(new Map<string, Poi[]>());
  const routeRef = useRef(route);
  if (routeRef.current !== route) {
    // Andere route: alles opnieuw
    routeRef.current = route;
    foodCache.current = new Map();
  }
  const clampedPause = Math.min(pauseMin, totalMin);
  const target = alongAtTime(route, clampedPause * 60);
  const winFrom = alongAtTime(route, Math.max(0, clampedPause * 60 - PAUSE_WINDOW_S));
  const winTo = alongAtTime(route, clampedPause * 60 + PAUSE_WINDOW_S);
  const foodKey = `${clampedPause}`;

  const loadFood = () => {
    const key = foodKey;
    const cached = foodCache.current.get(key);
    if (cached) {
      setFood({ key, l: { state: 'ok', data: cached } });
      return () => {};
    }
    setFood({ key, l: { state: 'loading' } });
    const ctrl = new AbortController();
    // Even wachten: wie snel op + tikt, stuurt zo maar één zoekvraag
    const t = setTimeout(() => {
      placesAlong(route, 'food', winFrom, winTo, ctrl.signal)
        .then((data) => {
          foodCache.current.set(key, data);
          setFood((cur) => (cur.key === key ? { key, l: { state: 'ok', data } } : cur));
        })
        .catch((e) => {
          if (!ctrl.signal.aborted) setFood((cur) => (cur.key === key ? { key, l: { state: 'error', error: (e as Error).message } } : cur));
        });
    }, 700);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  };

  useEffect(() => {
    if (open !== 'pause') return;
    return loadFood();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, foodKey, route]);

  const foodList = food.l.state === 'ok' && food.key === foodKey
    ? [...food.l.data]
        .sort((a, b) => Math.abs(a.along - target) - Math.abs(b.along - target))
        .slice(0, 8)
        .sort((a, b) => a.along - b.along)
    : [];

  // ---------- eigen stop zoeken
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Loadable<Place[]>>({ state: 'idle' });
  useEffect(() => {
    if (open !== 'own' || q.trim().length < 3) {
      setFound({ state: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setFound({ state: 'loading' });
      // Zoeken rond het midden van de route
      const near = pointAlong(route.shape, route.cum, route.lengthM / 2).point;
      searchPlaces(q.trim(), near, ctrl.signal)
        .then((places) => setFound({ state: 'ok', data: places }))
        .catch((e) => !ctrl.signal.aborted && setFound({ state: 'error', error: (e as Error).message || 'Zoeken mislukt' }));
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Bewust niet opnieuw zoeken als alleen de route verandert (bijv. na "+ Stop")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);
  // Afstand tot de (eventueel aangepaste) route lokaal berekenen
  const foundList: Poi[] = useMemo(() => {
    if (found.state !== 'ok') return [];
    return found.data
          .map((pl, i): Poi => {
            const pr = projectOnRoute(pl, route.shape, route.cum);
            const kind: PoiKind = pl.category === 'fuel' ? 'fuel' : pl.category === 'cafe' ? 'cafe' : pl.category === 'restaurant' || pl.category === 'fast_food' ? 'restaurant' : 'place';
            return {
              id: -(i + 1),
              kind,
              lat: pl.lat,
              lon: pl.lon,
              name: pl.detail ? `${pl.name}, ${pl.detail.split(', ')[0]}` : pl.name,
              along: pr?.along ?? 0,
              offset: pr?.offset ?? 0,
            };
          })
          .sort((a, b) => a.offset - b.offset);
  }, [found, route]);

  // ---------- wat in het paneel staat, ook op de kaart tonen
  const visible = open === 'fuel' ? shownFuel : open === 'pause' ? foodList : open === 'own' ? foundList : [];
  const visibleKey = visible.map((p) => `${p.kind}${p.id}`).join(',');
  useEffect(() => {
    onShowPois(visible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey]);
  useEffect(() => () => onShowPois([]), [onShowPois]);

  const warnings = extras.weather.state === 'ok' ? weatherWarnings(extras.weather.data) : [];

  return (
    <div className="details">
      <section className="detail">
        <div className="detail-head">
          <h3>Vertrek</h3>
          <input
            type="datetime-local"
            className="time-input"
            value={toLocalInput(departure)}
            onChange={(e) => e.target.value && setDeparture(new Date(e.target.value))}
          />
        </div>
        {sun && (sun.darkMinutes > 0 || sun.startsDark) && (
          <div className="notice warn">
            🌙{' '}
            {sun.startsDark
              ? 'Je vertrekt in het donker.'
              : `De zon gaat om ${formatClock(sun.sunset)} onder; je rijdt de laatste ${sun.darkMinutes} min in het donker.`}
          </div>
        )}
        {sun && !sun.darkMinutes && !sun.startsDark && (
          <p className="hint">
            Aankomst rond {formatClock(sun.arrival)}, zonsondergang {formatClock(sun.sunset)}.
          </p>
        )}
      </section>

      <section className="detail">
        <h3>Weer onderweg</h3>
        <StatusLine l={extras.weather} onRetry={() => onRetry('weather')} />
        {extras.weather.state === 'ok' && (
          <>
            <div className="weather-strip">
              {extras.weather.data.map((w, i) => {
                const lbl = weatherLabel(w.code);
                return (
                  <button key={i} className="wx" onClick={() => onFocus(w)} title={`${lbl.text}, wind ${Math.round(w.wind)} km/u`}>
                    <span className="wx-time">{formatClock(w.at)}</span>
                    <span className="wx-icon">{lbl.icon}</span>
                    <b>{Math.round(w.temp)}°</b>
                    <span className={`wx-rain ${w.rainChance >= 50 ? 'wet' : ''}`}>{w.rainChance}%</span>
                    <span className="wx-km">{Math.round(w.along / 1000)} km</span>
                  </button>
                );
              })}
            </div>
            {warnings.map((w, i) => (
              <div key={i} className={`notice ${w.level}`}>
                {w.text}
              </div>
            ))}
          </>
        )}
      </section>

      <section className="detail">
        <h3>Hoogteprofiel</h3>
        <StatusLine l={extras.elevation} onRetry={() => onRetry('elevation')} />
        {extras.elevation.state === 'ok' && <ElevationChart profile={extras.elevation.data} />}
      </section>

      {/* ---------- Tanken ---------- */}
      <section className="detail">
        <button className="detail-toggle" onClick={() => setOpen(open === 'fuel' ? null : 'fuel')} aria-expanded={open === 'fuel'}>
          <h3>⛽ Tanken</h3>
          <span className={`pill ${needsFuel ? 'warn' : 'good'}`}>{needsFuel ? `tanken nodig (bereik ${fuelRangeKm} km)` : `past in één tank`}</span>
        </button>
        {open === 'fuel' && (
          <>
            <div className="segmented small-seg">
              <button className={fuelMode === 'suggested' ? 'on' : ''} onClick={() => setFuelMode('suggested')}>
                Voorgesteld
              </button>
              <button className={fuelMode === 'all' ? 'on' : ''} onClick={() => setFuelMode('all')}>
                Alle langs de route{extras.pois.state === 'ok' ? ` (${allFuel.length})` : ''}
              </button>
            </div>
            <StatusLine l={extras.pois} onRetry={() => onRetry('pois')} />
            {extras.pois.state === 'ok' &&
              (shownFuel.length ? (
                <ul className="poi-list">
                  {shownFuel.map((p) => (
                    <PoiRow key={p.id} route={route} p={p} onAdd={() => onAddStop(p)} onFocus={() => onFocus(p)} />
                  ))}
                </ul>
              ) : (
                <p className="hint">Geen tankstations vlak langs de route gevonden. Zoek er zelf een bij "Eigen stop".</p>
              ))}
            {needsFuel && fuelMode === 'suggested' && (
              <p className="hint">Voorgesteld vóór elke {Math.round(fuelRangeKm * 0.7)} km. Je tankbereik stel je in bij Instellingen.</p>
            )}
          </>
        )}
      </section>

      {/* ---------- Pauze ---------- */}
      <section className="detail">
        <button className="detail-toggle" onClick={() => setOpen(open === 'pause' ? null : 'pause')} aria-expanded={open === 'pause'}>
          <h3>☕ Pauze</h3>
          <span className="pill">na {formatDuration(clampedPause * 60)}</span>
        </button>
        {open === 'pause' && (
          <>
            <div className="pause-ctl">
              <button className="icon-btn" onClick={() => setPauseMin((m) => Math.max(10, Math.min(m, totalMin) - 10))} disabled={clampedPause <= 10} aria-label="10 minuten eerder">
                −
              </button>
              <div className="pause-val">
                <b>Pauze na {formatDuration(clampedPause * 60)}</b>
                <small>
                  rond {formatDistance(target)} · {formatClock(new Date(departure.getTime() + clampedPause * 60000))}
                </small>
              </div>
              <button className="icon-btn" onClick={() => setPauseMin((m) => Math.min(totalMin, m + 10))} disabled={clampedPause >= totalMin} aria-label="10 minuten later">
                +
              </button>
            </div>
            <StatusLine l={food.key === foodKey ? food.l : { state: 'loading' }} onRetry={loadFood} />
            {food.l.state === 'ok' &&
              food.key === foodKey &&
              (foodList.length ? (
                <ul className="poi-list">
                  {foodList.map((p) => (
                    <PoiRow key={p.id} route={route} p={p} onAdd={() => onAddStop(p)} onFocus={() => onFocus(p)} />
                  ))}
                </ul>
              ) : (
                <p className="hint">Geen cafés of restaurants rond dit moment. Kies een ander moment, of zoek een eigen stop.</p>
              ))}
          </>
        )}
      </section>

      {/* ---------- Eigen stop ---------- */}
      <section className="detail">
        <button className="detail-toggle" onClick={() => setOpen(open === 'own' ? null : 'own')} aria-expanded={open === 'own'}>
          <h3>📍 Eigen stop</h3>
          <span className="pill">restaurant, café, tankstation…</span>
        </button>
        {open === 'own' && (
          <>
            <input
              className="text-input"
              placeholder="Bijv. Bikers Café De Kruisweg of een plaatsnaam"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
              enterKeyHint="search"
            />
            {q.trim().length >= 3 && <StatusLine l={found} onRetry={() => setQ((x) => `${x} `.trimEnd())} />}
            {foundList.length > 0 && (
              <ul className="poi-list">
                {foundList.map((p) => (
                  <PoiRow key={`${p.id}-${p.name}`} route={route} p={p} onAdd={() => onAddStop(p)} onFocus={() => onFocus(p)} />
                ))}
              </ul>
            )}
            {found.state === 'ok' && !foundList.length && <p className="hint">Niets gevonden. Probeer een andere naam of voeg de plaats toe.</p>}
            <p className="hint">Maakt niet uit waar het ligt: met "+ Stop" gaat de route erlangs.</p>
          </>
        )}
      </section>

      <p className="hint edit-hint">
        ✏️ Route aanpassen: tik op de kaart om een tussenpunt toe te voegen, sleep een wit punt naar een andere weg, of tik erop om het te verwijderen.
      </p>
    </div>
  );
}
