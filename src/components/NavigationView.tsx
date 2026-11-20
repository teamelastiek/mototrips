import { useEffect, useRef, useState } from 'react';
import { distance, formatDistance, formatDuration, pointAlong, projectOnRoute } from '../lib/geo';
import { isStale, QUICK, type QuickKind, type Rider } from '../lib/group';
import { relLabel, type RiderInfo } from './GroupUI';
import { RideRecorder, type RideRecord } from '../lib/logbook';
import { Navigator, Simulator, type NavState } from '../lib/navigator';
import type { Poi } from '../lib/overpass';
import { getSettings } from '../lib/settings';
import { speedLimits, type Route, type RoutePrefs } from '../lib/valhalla';
import { announce, isVoiceEnabled, setVoiceEnabled, speak } from '../lib/voice';
import { IconClose, IconMute, IconPlay, IconRecenter, IconVolume } from './Icons';
import { ManeuverIcon } from './ManeuverIcon';
import type { NavView } from './MapView';

interface Props {
  route: Route;
  name: string;
  prefs: RoutePrefs;
  demo: boolean;
  follow: boolean;
  fuelStops: Poi[];
  setFollow: (f: boolean) => void;
  onView: (v: NavView | null) => void;
  onExit: (ride: RideRecord | null) => void;
  /** Elke positie (GPS of demo), voor delen met de groep */
  onFix?: (f: { lat: number; lon: number; heading: number; speedKmh: number; accuracy?: number }) => void;
  riders?: Rider[];
  onQuick?: (k: QuickKind) => void;
}

function streetOf(m?: { streets: string[]; instruction: string }) {
  return m?.streets?.[0];
}

// Korte waarschuwingstoon bij te hard rijden
let audio: AudioContext | null = null;
function chime() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch {
    /* geen audio */
  }
}

export function NavigationView({ route, name, prefs, demo: startDemo, follow, fuelStops, setFollow, onView, onExit, onFix, riders = [], onQuick }: Props) {
  const [quickOpen, setQuickOpen] = useState(false);
  const gapWarned = useRef(new Set<string>());
  const onFixRef = useRef(onFix);
  onFixRef.current = onFix;
  const [state, setState] = useState<NavState | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [muted, setMuted] = useState(!isVoiceEnabled());
  const [demo, setDemo] = useState(startDemo);
  const [confirmStop, setConfirmStop] = useState(false);
  const [lean, setLean] = useState(0);
  const navRef = useRef<Navigator | null>(null);
  const routeRef = useRef(route);
  const followRef = useRef(follow);
  followRef.current = follow;
  const recorderRef = useRef<RideRecorder | null>(null);
  const overspeedRef = useRef(false);
  const settings = getSettings();

  // Maximumsnelheden ophalen voor een (nieuwe) route
  const loadLimits = (r: Route) => {
    if (!settings.showSpeedLimit) return;
    speedLimits(r)
      .then((segs) => navRef.current?.setSpeedLimits(segs, r))
      .catch(() => {});
  };

  // Navigator maken (één keer per rit)
  useEffect(() => {
    const nav = new Navigator(route, prefs, {
      onState: (s) => {
        setState(s);
        const r = routeRef.current;
        const idx = pointAlong(r.shape, r.cum, s.along).index;
        onFixRef.current?.({ lat: s.raw.lat, lon: s.raw.lon, heading: s.heading, speedKmh: s.speedKmh, accuracy: s.accuracy });
        onView({
          position: s.position,
          heading: s.heading,
          speedKmh: s.speedKmh,
          remaining: s.offRoute ? r.shape : [s.position, ...r.shape.slice(idx + 1)],
          follow: followRef.current,
        });
        // Te hard? Eén piepje per overtreding
        const over = s.speedLimit !== undefined && s.speedKmh > s.speedLimit + 4;
        if (over && !overspeedRef.current && getSettings().speedWarning) chime();
        overspeedRef.current = over;
      },
      onRoute: (r) => {
        routeRef.current = r;
        loadLimits(r);
      },
      speak: (t, p) => speak(t, p),
    });
    navRef.current = nav;
    loadLimits(route);
    return () => {
      navRef.current = null;
      onView(null);
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // GPS of demo-rit
  useEffect(() => {
    if (demo) {
      recorderRef.current = null; // demo-ritten niet in het logboek
      const sim = new Simulator(() => routeRef.current, (f) => navRef.current?.update(f), 70);
      sim.start();
      return () => sim.stop();
    }
    if (!navigator.geolocation) {
      setGpsError('Deze browser ondersteunt geen GPS-locatie.');
      return;
    }
    recorderRef.current ??= getSettings().recordRides ? new RideRecorder() : null;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGpsError(null);
        const fix = {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          heading: p.coords.heading,
          speed: p.coords.speed,
          accuracy: p.coords.accuracy,
          time: p.timestamp,
        };
        navRef.current?.update(fix);
        const rec = recorderRef.current;
        if (rec) {
          rec.add(fix);
          setLean(rec.lean);
        }
      },
      (e) =>
        setGpsError(
          e.code === 1
            ? 'Geen toestemming voor je locatie. Sta locatie toe in je browserinstellingen.'
            : 'Wachten op GPS-signaal…',
        ),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [demo]);

  // Scherm aan houden tijdens het rijden
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const request = async () => {
      try {
        lock = await navigator.wakeLock?.request('screen');
      } catch {
        /* niet ondersteund */
      }
    };
    request();
    const onVis = () => document.visibilityState === 'visible' && request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!confirmStop) return;
    const t = setTimeout(() => setConfirmStop(false), 3000);
    return () => clearTimeout(t);
  }, [confirmStop]);

  // Rijd ik voorop en raakt iemand ver achter? Dan één keer waarschuwen.
  useEffect(() => {
    if (!state || state.offRoute) return;
    const gap = getSettings().groupGapKm * 1000;
    const live = infos.filter((i) => !isStale(i.rider) && i.delta !== null);
    if (!live.length || live.some((i) => (i.delta ?? 0) > 150)) return; // ik ben niet de voorste
    for (const i of live) {
      const behind = -(i.delta ?? 0);
      if (behind > gap && !gapWarned.current.has(i.rider.id)) {
        gapWarned.current.add(i.rider.id);
        if (getSettings().groupVoice) announce(`${i.rider.name} rijdt ${formatDistance(behind).replace('km', 'kilometer')} achter je. Even wachten?`);
      } else if (behind < gap / 2) gapWarned.current.delete(i.rider.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.along, riders]);

  const exit = () => onExit(recorderRef.current?.finish(name) ?? null);

  const toggleMute = () => {
    setVoiceEnabled(muted);
    setMuted(!muted);
  };

  // Groepsgenoten ten opzichte van mij, langs de route
  const infos: RiderInfo[] = riders.map((r) => {
    if (!r.pos || !state) return { rider: r, delta: null, straight: null };
    const rt = routeRef.current;
    const pr = projectOnRoute(r.pos, rt.shape, rt.cum);
    const straight = distance(r.pos, state.raw);
    return { rider: r, delta: pr && pr.offset < 300 ? pr.along - state.along : null, straight };
  });
  const eta = state ? new Date(Date.now() + state.remainingS * 1000) : null;
  const next = state?.next;
  const over = state?.speedLimit !== undefined && state.speedKmh > state.speedLimit + 4;
  // Eerstvolgende tankstation (alleen als de route niet herberekend is, anders kloppen de afstanden niet)
  const nextFuel = state && routeRef.current === route ? fuelStops.find((p) => p.along > state.along + 100) : undefined;

  if (state?.arrived) {
    const rec = recorderRef.current;
    return (
      <div className="nav-arrived">
        <div className="arrived-card">
          <div className="arrived-flag">
            <ManeuverIcon type={4} size={56} />
          </div>
          <h2>Je bent er!</h2>
          {rec && rec.distanceM > 500 ? (
            <div className="arrived-stats">
              <div>
                <b>{formatDistance(rec.distanceM)}</b>
                <span>gereden</span>
              </div>
              <div>
                <b>{formatDuration(rec.movingS)}</b>
                <span>rijtijd</span>
              </div>
              <div>
                <b>{Math.round(rec.maxKmh)}</b>
                <span>max km/u</span>
              </div>
              <div>
                <b>
                  {Math.round(rec.maxLeanLeft)}° / {Math.round(rec.maxLeanRight)}°
                </b>
                <span>helling L/R</span>
              </div>
            </div>
          ) : (
            <p>{formatDistance(routeRef.current.lengthM)} gereden. Goed rijden en tot de volgende rit.</p>
          )}
          <button className="primary big" onClick={exit}>
            {rec ? 'Opslaan in logboek' : 'Terug naar planner'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="nav">
      <div className={`nav-banner ${state?.offRoute ? 'off' : ''}`}>
        {!state ? (
          <div className="nav-wait">{gpsError ?? 'GPS-signaal zoeken…'}</div>
        ) : state.offRoute ? (
          <div className="nav-wait">{state.rerouting ? 'Route herberekenen…' : 'Je bent van de route af'}</div>
        ) : next ? (
          <>
            <div className="nav-icon">
              <ManeuverIcon type={next.type} exit={next.roundaboutExit} size={72} />
            </div>
            <div className="nav-text">
              <div className="nav-dist">{formatDistance(state.distToNext)}</div>
              <div className="nav-instr">{streetOf(next) ?? next.instruction}</div>
              {streetOf(next) && <div className="nav-sub">{next.instruction}</div>}
            </div>
          </>
        ) : null}
        {state?.then && !state.offRoute && (
          <div className="nav-then">
            Daarna <ManeuverIcon type={state.then.type} exit={state.then.roundaboutExit} size={26} />
          </div>
        )}
      </div>

      <div className="nav-left">
        {state?.speedLimit !== undefined && (
          <div className={`limit-sign ${over ? 'over' : ''}`} title="Maximumsnelheid">
            {state.speedLimit}
          </div>
        )}
        {nextFuel && (
          <div className="fuel-chip" title={nextFuel.name}>
            <span>⛽</span> {formatDistance(nextFuel.along - state!.along)}
          </div>
        )}
        {recorderRef.current && state && state.speedKmh > 15 && Math.abs(lean) >= 3 && (
          <div className="lean-chip" title="Geschatte hellingshoek">
            <span style={{ transform: `rotate(${lean}deg)` }}>🏍️</span> {Math.abs(Math.round(lean))}°
          </div>
        )}
      </div>

      {riders.length > 0 && (
        <ul className="group-mini">
          {infos.slice(0, 5).map((i) => (
            <li key={i.rider.id} className={isStale(i.rider) ? 'stale' : ''}>
              <span className="rider-dot" style={{ background: i.rider.color }} />
              <b>{i.rider.name}</b> <span>{relLabel(i)}</span>
            </li>
          ))}
        </ul>
      )}

      {quickOpen && onQuick && (
        <div className="quick-pop">
          {(Object.keys(QUICK) as QuickKind[]).map((k) => (
            <button
              key={k}
              className="quick"
              onClick={() => {
                onQuick(k);
                setQuickOpen(false);
              }}
            >
              <span>{QUICK[k].icon}</span>
              {QUICK[k].text}
            </button>
          ))}
        </div>
      )}

      {gpsError && state && !demo && <div className="nav-toast">{gpsError}</div>}

      <div className="nav-side">
        <button className="round-btn" onClick={toggleMute} title={muted ? 'Geluid aan' : 'Geluid uit'}>
          {muted ? <IconMute /> : <IconVolume />}
        </button>
        {onQuick && (
          <button className={`round-btn ${quickOpen ? 'accent' : ''}`} onClick={() => setQuickOpen(!quickOpen)} title="Bericht aan de groep">
            👥
          </button>
        )}
        {!follow && (
          <button className="round-btn accent" onClick={() => setFollow(true)} title="Volg mijn positie">
            <IconRecenter />
          </button>
        )}
      </div>

      <div className="nav-bottom">
        <div className={`speed ${over ? 'over' : ''}`}>
          <b>{state ? Math.round(state.speedKmh) : '–'}</b>
          <span>km/u</span>
        </div>
        <div className="nav-stats">
          <div>
            <b>{state ? formatDuration(state.remainingS) : '–'}</b>
            <span>resterend</span>
          </div>
          <div>
            <b>{state ? formatDistance(state.remainingM) : '–'}</b>
            <span>afstand</span>
          </div>
          <div>
            <b>{eta ? eta.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '–'}</b>
            <span>aankomst</span>
          </div>
        </div>
        <button className={`stop-btn ${confirmStop ? 'confirm' : ''}`} onClick={() => (confirmStop ? exit() : setConfirmStop(true))} title="Navigatie stoppen">
          {confirmStop ? 'Stop?' : <IconClose />}
        </button>
      </div>

      {!demo && (!state || gpsError) && (
        <button className="demo-btn" onClick={() => setDemo(true)}>
          <IconPlay size={16} /> Geen GPS? Start demo-rit
        </button>
      )}
      {demo && <div className="demo-badge">Demo-rit</div>}
      {!demo && recorderRef.current && <div className="rec-badge">● Rit wordt opgenomen</div>}
    </div>
  );
}
