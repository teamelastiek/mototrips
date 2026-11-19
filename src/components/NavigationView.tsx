import { useEffect, useRef, useState } from 'react';
import { formatDistance, formatDuration, pointAlong } from '../lib/geo';
import { Navigator, Simulator, type NavState } from '../lib/navigator';
import type { Route, RoutePrefs } from '../lib/valhalla';
import { isVoiceEnabled, setVoiceEnabled, speak } from '../lib/voice';
import { IconClose, IconMute, IconPlay, IconRecenter, IconVolume } from './Icons';
import { ManeuverIcon } from './ManeuverIcon';
import type { NavView } from './MapView';

interface Props {
  route: Route;
  prefs: RoutePrefs;
  demo: boolean;
  follow: boolean;
  setFollow: (f: boolean) => void;
  onView: (v: NavView | null) => void;
  onExit: () => void;
}

function streetOf(m?: { streets: string[]; instruction: string }) {
  return m?.streets?.[0];
}

export function NavigationView({ route, prefs, demo: startDemo, follow, setFollow, onView, onExit }: Props) {
  const [state, setState] = useState<NavState | null>(null);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [muted, setMuted] = useState(!isVoiceEnabled());
  const [demo, setDemo] = useState(startDemo);
  const [confirmStop, setConfirmStop] = useState(false);
  const navRef = useRef<Navigator | null>(null);
  const routeRef = useRef(route);
  const followRef = useRef(follow);
  followRef.current = follow;

  // Navigator maken (één keer per rit)
  useEffect(() => {
    const nav = new Navigator(route, prefs, {
      onState: (s) => {
        setState(s);
        const r = routeRef.current;
        const idx = pointAlong(r.shape, r.cum, s.along).index;
        onView({
          position: s.position,
          heading: s.heading,
          speedKmh: s.speedKmh,
          remaining: s.offRoute ? r.shape : [s.position, ...r.shape.slice(idx + 1)],
          follow: followRef.current,
        });
      },
      onRoute: (r) => {
        routeRef.current = r;
      },
      speak: (t, p) => speak(t, p),
    });
    navRef.current = nav;
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
      const sim = new Simulator(() => routeRef.current, (f) => navRef.current?.update(f), 70);
      sim.start();
      return () => sim.stop();
    }
    if (!navigator.geolocation) {
      setGpsError('Deze browser ondersteunt geen GPS-locatie.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGpsError(null);
        navRef.current?.update({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          heading: p.coords.heading,
          speed: p.coords.speed,
          accuracy: p.coords.accuracy,
          time: p.timestamp,
        });
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

  const toggleMute = () => {
    setVoiceEnabled(muted);
    setMuted(!muted);
  };

  const eta = state ? new Date(Date.now() + state.remainingS * 1000) : null;
  const next = state?.next;

  if (state?.arrived) {
    return (
      <div className="nav-arrived">
        <div className="arrived-card">
          <div className="arrived-flag">
            <ManeuverIcon type={4} size={56} />
          </div>
          <h2>Je bent er!</h2>
          <p>
            {formatDistance(routeRef.current.lengthM)} gereden. Goed rijden en tot de volgende rit.
          </p>
          <button className="primary big" onClick={onExit}>
            Terug naar planner
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

      {gpsError && state && !demo && <div className="nav-toast">{gpsError}</div>}

      <div className="nav-side">
        <button className="round-btn" onClick={toggleMute} title={muted ? 'Geluid aan' : 'Geluid uit'}>
          {muted ? <IconMute /> : <IconVolume />}
        </button>
        {!follow && (
          <button className="round-btn accent" onClick={() => setFollow(true)} title="Volg mijn positie">
            <IconRecenter />
          </button>
        )}
      </div>

      <div className="nav-bottom">
        <div className="speed">
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
        <button
          className={`stop-btn ${confirmStop ? 'confirm' : ''}`}
          onClick={() => (confirmStop ? onExit() : setConfirmStop(true))}
          title="Navigatie stoppen"
        >
          {confirmStop ? 'Stop?' : <IconClose />}
        </button>
      </div>

      {!demo && (!state || gpsError) && (
        <button className="demo-btn" onClick={() => setDemo(true)}>
          <IconPlay size={16} /> Geen GPS? Start demo-rit
        </button>
      )}
      {demo && <div className="demo-badge">Demo-rit</div>}
    </div>
  );
}
