import { useState } from 'react';
import { formatDistance, type LatLng } from '../lib/geo';
import type { Poi } from '../lib/overpass';
import { formatClock } from '../lib/sun';
import type { ElevationProfile, Route } from '../lib/valhalla';
import { weatherLabel, weatherWarnings, type WeatherPoint } from '../lib/weather';
import { ElevationChart } from './ElevationChart';

export type Loadable<T> = { state: 'idle' | 'loading' } | { state: 'error'; error: string } | { state: 'ok'; data: T };

export interface RouteExtras {
  elevation: Loadable<ElevationProfile>;
  weather: Loadable<WeatherPoint[]>;
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
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Status({ l, what, onRetry }: { l: Loadable<unknown>; what: keyof RouteExtras; onRetry: Props['onRetry'] }) {
  if (l.state === 'loading' || l.state === 'idle') return <p className="hint loading-line">Laden…</p>;
  if (l.state === 'error')
    return (
      <p className="hint">
        {l.error}{' '}
        <button className="link-btn" onClick={() => onRetry(what)}>
          Opnieuw
        </button>
      </p>
    );
  return null;
}

function PoiRow({ p, onAdd, onFocus }: { p: Poi; onAdd: () => void; onFocus: () => void }) {
  const [added, setAdded] = useState(false);
  return (
    <li className="poi">
      <button className="poi-main" onClick={onFocus}>
        <span className="poi-icon">{p.kind === 'fuel' ? '⛽' : p.kind === 'cafe' ? '☕' : '🍽️'}</span>
        <span className="poi-text">
          <strong>{p.name}</strong>
          <small>
            na {formatDistance(p.along)}
            {p.offset > 150 ? ` · ${formatDistance(p.offset)} van de route` : ''}
          </small>
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

/** Welke tankstations en pauzeplekken we voorstellen voor deze route. */
export function stopSuggestions(route: Route, pois: Poi[], fuelRangeKm: number) {
  const km = route.lengthM / 1000;
  const fuel = pois.filter((p) => p.kind === 'fuel');
  const food = pois.filter((p) => p.kind !== 'fuel');

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

  // Pauze: rond de helft van de rit (bij korte ritjes het hele stuk)
  const pauseFrom = km > 60 ? route.lengthM * 0.3 : 0;
  const pauseTo = km > 60 ? route.lengthM * 0.7 : route.lengthM;
  const pauseList = food
    .filter((p) => p.along >= pauseFrom && p.along <= pauseTo)
    .sort((a, b) => Math.abs(a.along - route.lengthM / 2) - Math.abs(b.along - route.lengthM / 2))
    .slice(0, 8)
    .sort((a, b) => a.along - b.along);
  return { needsFuel, fuelList, pauseList, allFuel: fuel };
}

export function RouteDetails({ route, extras, departure, setDeparture, fuelRangeKm, sun, onAddStop, onFocus, onRetry }: Props) {
  const [open, setOpen] = useState<'fuel' | 'pause' | null>(null);
  const { needsFuel, fuelList, pauseList } = stopSuggestions(route, extras.pois.state === 'ok' ? extras.pois.data : [], fuelRangeKm);

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
        <Status l={extras.weather} what="weather" onRetry={onRetry} />
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
        <Status l={extras.elevation} what="elevation" onRetry={onRetry} />
        {extras.elevation.state === 'ok' && <ElevationChart profile={extras.elevation.data} />}
      </section>

      <section className="detail">
        <button className="detail-toggle" onClick={() => setOpen(open === 'fuel' ? null : 'fuel')} aria-expanded={open === 'fuel'}>
          <h3>⛽ Tanken</h3>
          <span className={`pill ${needsFuel ? 'warn' : 'good'}`}>
            {needsFuel ? `tanken nodig (bereik ${fuelRangeKm} km)` : `past in één tank`}
          </span>
        </button>
        {open === 'fuel' && (
          <>
            <Status l={extras.pois} what="pois" onRetry={onRetry} />
            {extras.pois.state === 'ok' &&
              (fuelList.length ? (
                <ul className="poi-list">
                  {fuelList.map((p) => (
                    <PoiRow key={p.id} p={p} onAdd={() => onAddStop(p)} onFocus={() => onFocus(p)} />
                  ))}
                </ul>
              ) : (
                <p className="hint">Geen tankstations vlak langs de route gevonden.</p>
              ))}
            {needsFuel && <p className="hint">Voorgesteld vóór elke {Math.round(fuelRangeKm * 0.7)} km. Je tankbereik stel je in bij Instellingen.</p>}
          </>
        )}
      </section>

      <section className="detail">
        <button className="detail-toggle" onClick={() => setOpen(open === 'pause' ? null : 'pause')} aria-expanded={open === 'pause'}>
          <h3>☕ Pauzeplek</h3>
          <span className="pill">{extras.pois.state === 'ok' ? `${pauseList.length} rond de helft` : '…'}</span>
        </button>
        {open === 'pause' && (
          <>
            <Status l={extras.pois} what="pois" onRetry={onRetry} />
            {extras.pois.state === 'ok' &&
              (pauseList.length ? (
                <ul className="poi-list">
                  {pauseList.map((p) => (
                    <PoiRow key={p.id} p={p} onAdd={() => onAddStop(p)} onFocus={() => onFocus(p)} />
                  ))}
                </ul>
              ) : (
                <p className="hint">Geen cafés of restaurants gevonden rond de helft van de route.</p>
              ))}
          </>
        )}
      </section>

      <p className="hint edit-hint">
        ✏️ Route aanpassen: tik op de kaart om een tussenpunt toe te voegen, sleep een wit punt naar een andere weg, of tik erop om het te verwijderen.
      </p>
    </div>
  );
}
