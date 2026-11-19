// Turn-by-turn navigatie-engine: koppelt GPS aan de route, kondigt afslagen aan
// en berekent een nieuwe route als je van de route af rijdt.
import { bearing, distance, pointAlong, projectOnRoute, type LatLng } from './geo';
import { route as fetchRoute, type Maneuver, type Route, type RoutePrefs } from './valhalla';

export interface Fix extends LatLng {
  heading?: number | null;
  /** m/s */
  speed?: number | null;
  accuracy?: number;
  time: number;
}

export interface NavState {
  position: LatLng; // gekoppeld aan de route (of ruwe positie als je van de route af bent)
  raw: LatLng;
  heading: number;
  speedKmh: number;
  along: number;
  offRoute: boolean;
  rerouting: boolean;
  next?: Maneuver;
  nextIndex: number;
  distToNext: number;
  then?: Maneuver;
  remainingM: number;
  remainingS: number;
  arrived: boolean;
  accuracy?: number;
}

export interface NavCallbacks {
  onState(s: NavState): void;
  onRoute(r: Route): void;
  speak(text: string, priority?: boolean): void;
}

const ARRIVE = new Set([4, 5, 6]);

function lowerFirst(s: string) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export function spokenDistance(m: number): string {
  if (m >= 950) {
    const km = Math.round(m / 500) / 2;
    return km === 1 ? '1 kilometer' : `${String(km).replace('.', ',')} kilometer`;
  }
  const r = m > 300 ? Math.round(m / 100) * 100 : Math.round(m / 50) * 50;
  return `${Math.max(50, r)} meter`;
}

export class Navigator {
  route: Route;
  private prefs: RoutePrefs;
  private cb: NavCallbacks;
  private lastIndex = 0;
  private lastAlong = 0;
  private offCount = 0;
  private lastReroute = 0;
  private rerouting = false;
  private spoken = new Map<number, Set<string>>();
  private viaAlong: number[] = [];
  private lastHeading = 0;
  private lastFix?: Fix;
  private started = false;
  private arrived = false;
  private smoothedSpeed = 0;

  constructor(route: Route, prefs: RoutePrefs, cb: NavCallbacks) {
    this.route = route;
    this.prefs = prefs;
    this.cb = cb;
    this.computeViaAlong();
  }

  private computeViaAlong() {
    // Positie van elk tussenpunt langs de route (in volgorde), voor het herberekenen.
    let from = 0;
    this.viaAlong = this.route.vias.map((v) => {
      const p = projectOnRoute(v, this.route.shape, this.route.cum, from);
      if (!p) return 0;
      from = p.index;
      return p.along;
    });
  }

  private setRoute(r: Route, keepVias: LatLng[]) {
    this.route = { ...r, vias: keepVias };
    // Bij rerouting zijn de tussenpunten ook doorgangspunten in de nieuwe route
    this.computeViaAlong();
    this.lastIndex = 0;
    this.lastAlong = 0;
    this.spoken.clear();
    this.offCount = 0;
    this.cb.onRoute(this.route);
  }

  update(fix: Fix) {
    const { route } = this;
    const raw = { lat: fix.lat, lon: fix.lon };

    // Snelheid: GPS-waarde of zelf berekenen uit opeenvolgende posities
    let speed = fix.speed ?? null;
    if ((speed === null || Number.isNaN(speed)) && this.lastFix) {
      const dt = (fix.time - this.lastFix.time) / 1000;
      if (dt > 0.3) speed = distance(this.lastFix, raw) / dt;
    }
    this.smoothedSpeed = this.smoothedSpeed * 0.6 + (speed ?? 0) * 0.4;
    const v = this.smoothedSpeed; // m/s

    // Koppel aan de route: eerst lokaal vooruit zoeken, daarna globaal
    let proj = projectOnRoute(raw, route.shape, route.cum, Math.max(0, this.lastIndex - 3), 3000);
    if (!proj || proj.offset > 50) {
      const global = projectOnRoute(raw, route.shape, route.cum, 0);
      // Globale match alleen accepteren als die echt beter is én niet ver terug in de route ligt
      if (global && global.offset < 30 && (!proj || global.offset < proj.offset) && global.along > this.lastAlong - 200) proj = global;
    }

    const tolerance = Math.max(35, Math.min(80, (fix.accuracy ?? 15) * 1.5));
    const off = !proj || proj.offset > tolerance;
    this.offCount = off ? this.offCount + 1 : 0;

    if (proj && !off) {
      this.lastIndex = proj.index;
      this.lastAlong = proj.along;
    }
    const along = this.lastAlong;

    // Rijrichting: GPS-heading bij snelheid, anders langs de route
    let heading = this.lastHeading;
    if (fix.heading != null && !Number.isNaN(fix.heading) && v > 2) heading = fix.heading;
    else if (this.lastFix && distance(this.lastFix, raw) > 5) heading = bearing(this.lastFix, raw);
    else if (!off) {
      const ahead = pointAlong(route.shape, route.cum, along + 20).point;
      const here = pointAlong(route.shape, route.cum, along).point;
      if (distance(here, ahead) > 1) heading = bearing(here, ahead);
    }
    this.lastHeading = heading;
    this.lastFix = fix;

    // Volgende manoeuvre: de eerste die nog voor ons ligt (met wat marge)
    let nextIndex = route.maneuvers.findIndex((m, i) => i > 0 && m.at > along + 8);
    if (nextIndex === -1) nextIndex = route.maneuvers.length - 1;
    const next = route.maneuvers[nextIndex];
    const distToNext = Math.max(0, next.at - along);
    const afterNext = route.maneuvers[nextIndex + 1];
    const then = afterNext && afterNext.at - next.at < 250 ? afterNext : undefined;

    const total = route.cum[route.cum.length - 1];
    const remainingM = Math.max(0, total - along);
    // Resterende tijd uit de manoeuvretijden
    let remainingS = 0;
    const cur = route.maneuvers[nextIndex - 1];
    if (cur && cur.lengthM > 0) remainingS += cur.timeS * Math.min(1, distToNext / cur.lengthM);
    for (let i = nextIndex; i < route.maneuvers.length; i++) remainingS += route.maneuvers[i].timeS;

    const arrived = this.arrived || (ARRIVE.has(next.type) && distToNext < 30 && !off) || (remainingM < 30 && !off);

    this.announce(nextIndex, distToNext, v, off);
    if (arrived && !this.arrived) {
      this.arrived = true;
      this.cb.speak(next.pre ?? 'U bent aangekomen.', true);
    }

    // Van de route af: na een paar metingen een nieuwe route berekenen
    if (off && this.offCount >= 3 && !this.rerouting && !this.arrived && Date.now() - this.lastReroute > 8000) {
      this.reroute(raw, heading, v);
    }

    this.cb.onState({
      position: off || !proj ? raw : proj.point,
      raw,
      heading,
      speedKmh: v * 3.6,
      along,
      offRoute: off,
      rerouting: this.rerouting,
      next,
      nextIndex,
      distToNext,
      then,
      remainingM,
      remainingS,
      arrived: this.arrived,
      accuracy: fix.accuracy,
    });
  }

  private once(index: number, stage: string): boolean {
    let s = this.spoken.get(index);
    if (!s) this.spoken.set(index, (s = new Set()));
    if (s.has(stage)) return false;
    s.add(stage);
    return true;
  }

  private announce(i: number, dist: number, v: number, off: boolean) {
    if (off) return;
    const m = this.route.maneuvers[i];
    if (!m) return;

    if (!this.started) {
      this.started = true;
      const first = this.route.maneuvers[0];
      this.once(0, 'pre');
      const intro = first?.pre ?? first?.instruction ?? 'Route gestart.';
      // Als de eerste afslag dichtbij is, die er meteen achteraan zeggen
      const nextText = dist < 400 && m.alert && !/daarna/i.test(intro) ? ` Daarna ${lowerFirst(m.alert)}` : '';
      this.cb.speak(intro + nextText, true);
      if (nextText) this.once(i, 'mid');
      return;
    }

    const kmh = v * 3.6;
    const nowDist = Math.max(35, v * 6 + 15); // ~6 seconden van tevoren
    const midDist = kmh > 70 ? 800 : kmh > 40 ? 400 : 200;
    const farDist = kmh > 80 ? 2000 : 0;
    const prev = this.route.maneuvers[i - 1];

    if (ARRIVE.has(m.type)) {
      if (dist < midDist && dist > nowDist * 2 && this.once(i, 'mid')) {
        this.cb.speak(`Over ${spokenDistance(dist)} bereikt u uw bestemming.`);
      }
      return;
    }

    if (dist <= nowDist) {
      if (this.once(i, 'now')) {
        let text = m.pre ?? m.instruction;
        const n2 = this.route.maneuvers[i + 1];
        // Valhalla voegt bij snel opeenvolgende afslagen zelf al "Daarna …" toe
        if (n2 && n2.at - m.at < 200 && n2.alert && !/daarna/i.test(text)) text += ` Daarna ${lowerFirst(n2.alert)}`;
        this.cb.speak(text, true);
      }
    } else if (dist <= midDist && dist > nowDist + 80) {
      if (this.once(i, 'mid')) this.cb.speak(`Over ${spokenDistance(dist)}, ${lowerFirst(m.alert ?? m.pre ?? m.instruction)}`);
    } else if (farDist && dist <= farDist && dist > midDist + 300) {
      if (this.once(i, 'far')) this.cb.speak(`Over ${spokenDistance(dist)}, ${lowerFirst(m.alert ?? m.pre ?? m.instruction)}`);
    } else if (prev && prev.lengthM > 3000 && dist > prev.lengthM - 400 && this.once(i - 1, 'post') && prev.post) {
      // Net een afslag genomen en het volgende stuk is lang: "12 kilometer doorgaan."
      this.cb.speak(prev.post);
    }
  }

  private async reroute(pos: LatLng, heading: number, v: number) {
    this.rerouting = true;
    this.lastReroute = Date.now();
    this.cb.speak('Route wordt herberekend.');
    try {
      // Nog niet gepasseerde tussenpunten behouden (anders wordt een rondje ineens afgekort)
      const remainingVias = this.route.vias.filter((_, i) => this.viaAlong[i] > this.lastAlong + 150);
      const r = await fetchRoute(
        [
          { ...pos, type: 'break', ...(v > 2 ? { heading, headingTolerance: 45 } : {}) },
          ...remainingVias.map((p) => ({ ...p, type: 'through' as const })),
          { ...this.route.end, type: 'break' },
        ],
        this.prefs,
      );
      this.setRoute(r, remainingVias);
    } catch {
      this.cb.speak('Herberekenen mislukt, probeer het zo opnieuw.');
    } finally {
      this.rerouting = false;
    }
  }
}

/** Rijdt virtueel over de route, voor een demo zonder GPS. */
export class Simulator {
  private along = 0;
  private timer?: number;
  speedKmh: number;
  private getRoute: () => Route;
  private emit: (f: Fix) => void;
  constructor(getRoute: () => Route, emit: (f: Fix) => void, speedKmh = 60) {
    this.getRoute = getRoute;
    this.emit = emit;
    this.speedKmh = speedKmh;
  }
  start() {
    const tick = 500;
    this.timer = window.setInterval(() => {
      const r = this.getRoute();
      const total = r.cum[r.cum.length - 1];
      this.along = Math.min(total, this.along + (this.speedKmh / 3.6) * (tick / 1000));
      const p = pointAlong(r.shape, r.cum, this.along).point;
      const ahead = pointAlong(r.shape, r.cum, this.along + 15).point;
      this.emit({ ...p, heading: bearing(p, ahead), speed: this.speedKmh / 3.6, accuracy: 5, time: Date.now() });
      if (this.along >= total) this.stop();
    }, tick);
  }
  /** Na een herberekening opnieuw beginnen bij het begin van de nieuwe route. */
  reset() {
    this.along = 0;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
