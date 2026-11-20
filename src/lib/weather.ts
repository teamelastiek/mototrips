// Weersverwachting langs de route op het moment dat je daar rijdt (Open-Meteo, gratis).
import { pointAlong, type LatLng } from './geo';
import type { Route } from './valhalla';

export interface WeatherPoint extends LatLng {
  along: number; // m
  at: Date; // verwachte doorkomsttijd
  temp: number; // °C
  rainChance: number; // %
  rainMm: number;
  wind: number; // km/u
  gusts: number; // km/u
  code: number; // WMO-weercode
}

/** Moment waarop je op een bepaalde afstand langs de route bent. */
export function timeAtAlong(r: Route, along: number): number {
  // Tijd uit de manoeuvres (die bevatten de verwachte rijtijd per stuk)
  let t = 0;
  for (const m of r.maneuvers) {
    if (m.at + m.lengthM <= along) t += m.timeS;
    else {
      if (m.lengthM > 0 && along > m.at) t += m.timeS * ((along - m.at) / m.lengthM);
      break;
    }
  }
  return t;
}

/** Waar je bent (m langs de route) na een bepaalde rijtijd in seconden. */
export function alongAtTime(r: Route, seconds: number): number {
  let t = 0;
  for (const m of r.maneuvers) {
    if (t + m.timeS >= seconds) {
      const f = m.timeS > 0 ? (seconds - t) / m.timeS : 0;
      return Math.min(r.lengthM, m.at + m.lengthM * Math.max(0, f));
    }
    t += m.timeS;
  }
  return r.lengthM;
}

export async function weatherAlongRoute(r: Route, departure: Date, signal?: AbortSignal): Promise<WeatherPoint[]> {
  const total = r.cum[r.cum.length - 1];
  const n = Math.min(10, Math.max(3, Math.round(total / 25000) + 1));
  const samples = Array.from({ length: n }, (_, i) => {
    const along = (total * i) / (n - 1);
    return { along, p: pointAlong(r.shape, r.cum, along).point, at: new Date(departure.getTime() + timeAtAlong(r, along) * 1000) };
  });
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', samples.map((s) => s.p.lat.toFixed(3)).join(','));
  url.searchParams.set('longitude', samples.map((s) => s.p.lon.toFixed(3)).join(','));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m');
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('forecast_days', '7');
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error('Weer ophalen mislukt');
  const data = await res.json();
  const list = Array.isArray(data) ? data : [data];
  return samples.map((s, i) => {
    const h = list[i].hourly;
    // Dichtstbijzijnde uur kiezen
    const target = s.at.getTime();
    let best = 0;
    let bestDiff = Infinity;
    (h.time as string[]).forEach((t, j) => {
      const diff = Math.abs(new Date(t + 'Z').getTime() - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = j;
      }
    });
    return {
      ...s.p,
      along: s.along,
      at: s.at,
      temp: h.temperature_2m[best],
      rainChance: h.precipitation_probability[best] ?? 0,
      rainMm: h.precipitation[best] ?? 0,
      wind: h.wind_speed_10m[best],
      gusts: h.wind_gusts_10m[best],
      code: h.weather_code[best],
    };
  });
}

/** Korte omschrijving + emoji bij een WMO-weercode. */
export function weatherLabel(code: number): { icon: string; text: string } {
  if (code === 0) return { icon: '☀️', text: 'Zonnig' };
  if (code <= 2) return { icon: '🌤️', text: 'Licht bewolkt' };
  if (code === 3) return { icon: '☁️', text: 'Bewolkt' };
  if (code <= 48) return { icon: '🌫️', text: 'Mist' };
  if (code <= 57) return { icon: '🌦️', text: 'Motregen' };
  if (code <= 67) return { icon: '🌧️', text: 'Regen' };
  if (code <= 77) return { icon: '🌨️', text: 'Sneeuw' };
  if (code <= 82) return { icon: '🌧️', text: 'Buien' };
  if (code <= 86) return { icon: '🌨️', text: 'Sneeuwbuien' };
  return { icon: '⛈️', text: 'Onweer' };
}

export interface WeatherWarning {
  level: 'info' | 'warn';
  text: string;
}

export function weatherWarnings(w: WeatherPoint[]): WeatherWarning[] {
  const out: WeatherWarning[] = [];
  const rainy = w.filter((p) => p.rainChance >= 50 || p.rainMm >= 0.5);
  if (rainy.length) {
    const first = rainy[0];
    out.push({
      level: 'warn',
      text: `Kans op regen vanaf ${Math.round(first.along / 1000)} km (${first.rainChance}% rond ${first.at.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}). Regenpak mee!`,
    });
  }
  const gusty = w.filter((p) => p.gusts >= 60);
  if (gusty.length) out.push({ level: 'warn', text: `Harde windstoten tot ${Math.round(Math.max(...gusty.map((p) => p.gusts)))} km/u.` });
  const cold = Math.min(...w.map((p) => p.temp));
  if (cold <= 3) out.push({ level: 'warn', text: `Koud: tot ${Math.round(cold)} °C. Let op gladheid.` });
  else if (cold <= 10) out.push({ level: 'info', text: `Fris: ${Math.round(cold)} °C. Warme laag aan.` });
  return out;
}
