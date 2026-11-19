import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapView, type NavView } from './components/MapView';
import { NavigationView } from './components/NavigationView';
import { Planner, type PlanSettings } from './components/Planner';
import { getCurrentPosition } from './components/PlaceInput';
import { SavedList } from './components/SavedList';
import { Settings } from './components/Settings';
import { IconBike, IconBookmark, IconChevron, IconGear } from './components/Icons';
import { generate, type Candidate } from './lib/generator';
import { reverseGeocode } from './lib/geocode';
import { analyzeShape, type LatLng } from './lib/geo';
import { downloadGpx } from './lib/gpx';
import { deleteSaved, loadPlanSettings, loadSaved, savePlanSettings, saveRoute, type SavedRoute } from './lib/storage';
import { defaultPrefs, route as fetchRoute, type Route } from './lib/valhalla';
import { unlockVoice } from './lib/voice';

type Tab = 'plan' | 'saved' | 'settings';

const DEFAULT_PLAN: PlanSettings = {
  mode: 'loop',
  start: null,
  end: null,
  targetKind: 'distance',
  distanceKm: 120,
  timeMin: 150,
  prefs: defaultPrefs,
};

function useIsWide() {
  const q = '(min-width: 860px)';
  const [wide, setWide] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

function routeName(plan: PlanSettings, c: Candidate) {
  const from = plan.start?.name.replace(/^Mijn locatie · /, '').split(',')[0] ?? 'Start';
  if (plan.mode === 'loop') return `${from} – ${c.label.replace('Rondje ', '')} (${Math.round(c.route.lengthM / 1000)} km)`;
  const to = plan.end?.name.split(',')[0] ?? 'Bestemming';
  return `${from} → ${to}`;
}

export default function App() {
  const wide = useIsWide();
  const [plan, setPlanState] = useState<PlanSettings>(() => {
    const p = loadPlanSettings(DEFAULT_PLAN);
    return { ...p, prefs: { ...defaultPrefs, ...p.prefs } };
  });
  const setPlan = (p: PlanSettings) => {
    setPlanState(p);
    savePlanSettings(p);
  };
  const [tab, setTab] = useState<Tab>('plan');
  const [sheetOpen, setSheetOpen] = useState(true);
  const [mapStyle, setMapStyleState] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('mototrips.mapstyle') as 'light' | 'dark') || 'light';
    } catch {
      return 'light';
    }
  });
  const setMapStyle = (s: 'light' | 'dark') => {
    setMapStyleState(s);
    try {
      localStorage.setItem('mototrips.mapstyle', s);
    } catch {
      /* negeren */
    }
  };

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [showResults, setShowResults] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState<number>();
  const [centerOn, setCenterOn] = useState<{ p: LatLng; key: number } | null>(null);
  const [myLoc, setMyLoc] = useState<LatLng | null>(null);
  const [clickMenu, setClickMenu] = useState<{ p: LatLng; x: number; y: number } | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSaved);
  const [savedNotice, setSavedNotice] = useState(false);
  const [loadingSavedId, setLoadingSavedId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [nav, setNav] = useState<{ route: Route; demo: boolean } | null>(null);
  const [navView, setNavView] = useState<NavView | null>(null);
  const [follow, setFollow] = useState(true);

  const selected = candidates.find((c) => c.id === selectedId);

  // Als locatie al eerder is toegestaan: kaart meteen daarheen
  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        if (s.state !== 'granted') return;
        getCurrentPosition()
          .then((p) => {
            setMyLoc(p);
            if (!plan.start) setCenterOn({ p, key: Date.now() });
          })
          .catch(() => {});
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Naar het (nieuwe) startpunt of de bestemming vliegen zolang er nog geen routes getoond worden
  const startKey = plan.start ? `${plan.start.lat},${plan.start.lon}` : '';
  const endKey = plan.end ? `${plan.end.lat},${plan.end.lon}` : '';
  useEffect(() => {
    if (plan.start && !showResults) setCenterOn({ p: plan.start, key: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startKey]);
  useEffect(() => {
    if (plan.end && plan.mode === 'ab' && !showResults) setCenterOn({ p: plan.end, key: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endKey]);

  const runGenerate = useCallback(async () => {
    if (!plan.start) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGenerating(true);
    setError(null);
    setProgress(null);
    setSavedNotice(false);
    try {
      const target =
        plan.targetKind === 'distance'
          ? { kind: 'distance' as const, value: plan.distanceKm }
          : plan.targetKind === 'time'
            ? { kind: 'time' as const, value: plan.timeMin }
            : { kind: 'none' as const, value: 0 };
      const result = await generate(
        { mode: plan.mode, start: plan.start, end: plan.end ?? undefined, target, prefs: plan.prefs },
        (done, total) => setProgress({ done, total }),
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      setCandidates(result);
      setSelectedId(result[0]?.id);
      setShowResults(true);
      setSheetOpen(true);
      setFitKey(Date.now());
    } catch (e) {
      if (!ctrl.signal.aborted) setError((e as Error).message || 'Er ging iets mis bij het maken van de route.');
    } finally {
      if (abortRef.current === ctrl) {
        setGenerating(false);
        setProgress(null);
      }
    }
  }, [plan]);

  const selectCandidate = (id: string) => {
    setSelectedId(id);
    setSavedNotice(false);
    setFitKey(Date.now());
  };

  const startNav = (demo = false) => {
    if (!selected) return;
    unlockVoice(); // iOS: spraak moet vanuit een tik worden gestart
    setFollow(true);
    setNav({ route: selected.route, demo });
  };

  const onMapClick = (p: LatLng, screen: { x: number; y: number }) => {
    if (nav || tab !== 'plan' || showResults) {
      setClickMenu(null);
      return;
    }
    setClickMenu({ p, ...screen });
  };

  const setPoint = async (which: 'start' | 'end', p: LatLng) => {
    setClickMenu(null);
    const label = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    const next = { ...plan, [which]: { ...p, name: label } };
    if (which === 'end' && plan.mode === 'loop') next.mode = 'ab';
    if (next.mode === 'ab' && next.targetKind !== 'none' && which === 'end' && plan.mode === 'loop') next.targetKind = 'none';
    setPlan(next);
    const name = await reverseGeocode(p);
    setPlanState((cur) => {
      const pt = cur[which];
      if (!pt || pt.lat !== p.lat || pt.lon !== p.lon) return cur;
      const upd = { ...cur, [which]: { ...pt, name } };
      savePlanSettings(upd);
      return upd;
    });
  };

  const openSaved = async (s: SavedRoute) => {
    setLoadingSavedId(s.id);
    setError(null);
    try {
      const r = await fetchRoute(
        [{ ...s.start, type: 'break' }, ...s.vias.map((v) => ({ ...v, type: 'through' as const })), { ...s.end, type: 'break' }],
        s.prefs,
      );
      const stats = analyzeShape(r.shape);
      const c: Candidate = {
        id: `saved-${s.id}`,
        label: s.name,
        route: r,
        stats: { ...stats, avgSpeedKmh: r.lengthM / r.timeS / 3.6 },
        score: 0,
        deviation: 0,
      };
      setPlan({ ...plan, mode: s.mode, prefs: s.prefs, start: { ...s.start, name: s.name.split(/ [–→] /)[0] }, end: s.mode === 'ab' ? { ...s.end, name: s.name.split(' → ')[1] ?? 'Bestemming' } : plan.end });
      setCandidates([c]);
      setSelectedId(c.id);
      setShowResults(true);
      setSavedNotice(true);
      setTab('plan');
      setFitKey(Date.now());
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setLoadingSavedId(null);
    }
  };

  const mapCandidates = useMemo(() => (showResults && tab === 'plan' ? candidates.map((c) => ({ id: c.id, shape: c.route.shape })) : []), [candidates, showResults, tab]);

  const padding = useMemo(() => {
    if (nav) return { top: 0, bottom: 110, left: 0, right: 0 };
    if (wide) return { top: 0, bottom: 0, left: 420, right: 0 };
    return { top: 0, bottom: sheetOpen ? Math.round(window.innerHeight * 0.55) : 80, left: 0, right: 0 };
  }, [nav, wide, sheetOpen]);

  return (
    <div className={`app ${nav ? 'navigating' : ''} ${wide ? 'wide' : 'narrow'}`}>
      <MapView
        styleName={mapStyle}
        candidates={mapCandidates}
        selectedId={selectedId}
        start={nav ? null : plan.start}
        end={nav ? nav.route.end : plan.mode === 'ab' ? plan.end : null}
        vias={showResults && selected ? selected.route.vias : []}
        fitKey={fitKey}
        centerOn={centerOn}
        nav={navView ? { ...navView, follow } : null}
        padding={padding}
        onMapClick={onMapClick}
        onCandidateClick={selectCandidate}
        onUserPan={() => {
          setClickMenu(null);
          if (nav) setFollow(false);
        }}
      />

      {!nav && (
        <aside className={`panel ${sheetOpen ? 'open' : 'closed'}`}>
          <header className="panel-head">
            {!wide && (
              <button className="sheet-handle" onClick={() => setSheetOpen(!sheetOpen)} aria-label={sheetOpen ? 'Paneel inklappen' : 'Paneel uitklappen'}>
                <IconChevron size={20} style={{ transform: sheetOpen ? 'none' : 'rotate(180deg)' }} />
              </button>
            )}
            <div className="brand">
              <IconBike size={26} />
              <span>
                Moto<b>Trips</b>
              </span>
            </div>
            <nav className="tabs">
              <button className={tab === 'plan' ? 'on' : ''} onClick={() => (setTab('plan'), setSheetOpen(true))}>
                Plannen
              </button>
              <button className={tab === 'saved' ? 'on' : ''} onClick={() => (setTab('saved'), setSheetOpen(true))} title="Mijn routes">
                <IconBookmark size={18} />
                {saved.length > 0 && <span className="count">{saved.length}</span>}
              </button>
              <button className={tab === 'settings' ? 'on' : ''} onClick={() => (setTab('settings'), setSheetOpen(true))} title="Instellingen">
                <IconGear size={18} />
              </button>
            </nav>
          </header>
          <div className="panel-body">
            {tab === 'plan' && (
              <Planner
                plan={plan}
                setPlan={setPlan}
                near={myLoc}
                generating={generating}
                progress={progress}
                error={error}
                candidates={candidates}
                selectedId={selectedId}
                showResults={showResults}
                onGenerate={runGenerate}
                onBack={() => setShowResults(false)}
                onSelect={selectCandidate}
                onNavigate={() => startNav(false)}
                onGpx={() => selected && downloadGpx(selected.route, routeName(plan, selected))}
                onSave={() => {
                  if (!selected) return;
                  saveRoute(selected.route, routeName(plan, selected), plan.mode, plan.prefs, selected.stats.curvature);
                  setSaved(loadSaved());
                  setSavedNotice(true);
                }}
                savedNotice={savedNotice}
              />
            )}
            {tab === 'saved' && (
              <SavedList
                items={saved}
                loadingId={loadingSavedId}
                onOpen={openSaved}
                onDelete={(id) => {
                  deleteSaved(id);
                  setSaved(loadSaved());
                }}
              />
            )}
            {tab === 'settings' && <Settings mapStyle={mapStyle} setMapStyle={setMapStyle} />}
          </div>
        </aside>
      )}

      {clickMenu && !nav && (
        <div className="click-menu" style={{ left: clickMenu.x, top: clickMenu.y }}>
          <button onClick={() => setPoint('start', clickMenu.p)}>
            <span className="place-dot dot-a">A</span> {plan.mode === 'loop' ? 'Start hier' : 'Vertrek hier'}
          </button>
          <button onClick={() => setPoint('end', clickMenu.p)}>
            <span className="place-dot dot-b">B</span> Bestemming hier
          </button>
        </div>
      )}

      {nav && (
        <NavigationView
          key={nav.route.lengthM + ':' + nav.demo}
          route={nav.route}
          prefs={plan.prefs}
          demo={nav.demo}
          follow={follow}
          setFollow={setFollow}
          onView={setNavView}
          onExit={() => {
            setNav(null);
            setNavView(null);
            setFitKey(Date.now());
          }}
        />
      )}
    </div>
  );
}
