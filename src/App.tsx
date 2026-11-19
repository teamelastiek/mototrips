import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconBike, IconBookmark, IconChevron, IconGear, IconLog } from './components/Icons';
import { Logbook } from './components/Logbook';
import { MapView, type NavView } from './components/MapView';
import { NavigationView } from './components/NavigationView';
import { getCurrentPosition } from './components/PlaceInput';
import { Planner, type PlanSettings } from './components/Planner';
import { RouteDetails, stopSuggestions, type RouteExtras } from './components/RouteDetails';
import { SavedList } from './components/SavedList';
import { Settings } from './components/Settings';
import { candidateFromRoute, generate, type Candidate } from './lib/generator';
import { reverseGeocode } from './lib/geocode';
import { projectOnRoute, type LatLng } from './lib/geo';
import { downloadGpx, toGpx } from './lib/gpx';
import { gpxToRoute, isLoop, parseGpx, pickGpxFile } from './lib/gpxImport';
import { deleteRide, loadRides, rideTrack, type RideRecord } from './lib/logbook';
import { downloadRouteMap } from './lib/offline';
import { poisAlongRoute, type Poi } from './lib/overpass';
import { getSettings, onSettings, type AppSettings } from './lib/settings';
import { decodeShare, encodeShare, shareRoute, takeSharedFromUrl, type SharedRoute } from './lib/share';
import { groupRidesAvailable } from './lib/config';
import {
  GroupRide,
  QUICK,
  groupCodeFromUrl,
  groupInviteUrl,
  isStale,
  loadStoredGroup,
  newGroupCode,
  storeGroup,
  type QuickKind,
  type Rider,
} from './lib/group';
import { speak } from './lib/voice';
import { GroupChip, GroupNameDialog, GroupSheet, type RiderInfo } from './components/GroupUI';
import { updateSettings } from './lib/settings';
import { deleteSaved, loadPlanSettings, loadSaved, savePlanSettings, saveRoute, type SavedRoute } from './lib/storage';
import { isDark, sunTimes } from './lib/sun';
import { defaultPrefs, elevation, routeMany, type Route, type RoutePrefs, type RoutingLocation } from './lib/valhalla';
import { unlockVoice } from './lib/voice';
import { weatherAlongRoute } from './lib/weather';

type Tab = 'plan' | 'saved' | 'rides' | 'settings';
type Menu =
  | { kind: 'map'; p: LatLng; x: number; y: number }
  | { kind: 'via'; index: number; x: number; y: number }
  | { kind: 'poi'; poi: Poi; x: number; y: number };

const DEFAULT_PLAN: PlanSettings = {
  mode: 'loop',
  start: null,
  end: null,
  targetKind: 'distance',
  distanceKm: 120,
  timeMin: 150,
  prefs: defaultPrefs,
};

const EMPTY_EXTRAS: RouteExtras = { elevation: { state: 'idle' }, weather: { state: 'idle' }, pois: { state: 'idle' } };
const NL_CENTER = { lat: 52.2, lon: 5.6 };

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
  if (c.id.startsWith('import-') || c.id.startsWith('shared-') || c.id.startsWith('saved-')) return c.label.replace(/ \(aangepast\)$/, '');
  const from = plan.start?.name.replace(/^Mijn locatie · /, '').split(',')[0] ?? 'Start';
  if (plan.mode === 'loop') return `${from} – ${c.label.replace('Rondje ', '').replace(/ \(aangepast\)$/, '')} (${Math.round(c.route.lengthM / 1000)} km)`;
  const to = plan.end?.name.split(',')[0] ?? 'Bestemming';
  return `${from} → ${to}`;
}

const errMsg = (e: unknown) => (e as Error)?.message || 'Er ging iets mis.';

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
  const [settings, setSettings] = useState<AppSettings>(getSettings);
  useEffect(() => onSettings(setSettings), []);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [showResults, setShowResults] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState<number>();
  const [centerOn, setCenterOn] = useState<{ p: LatLng; key: number } | null>(null);
  const [myLoc, setMyLoc] = useState<LatLng | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [saved, setSaved] = useState<SavedRoute[]>(loadSaved);
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [loadingSavedId, setLoadingSavedId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // bezig met route aanpassen
  const [importing, setImporting] = useState(false);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [offline, setOffline] = useState<Record<string, { state: 'idle' | 'loading' | 'done' | 'error'; text?: string }>>({});
  const [departure, setDeparture] = useState(() => new Date());
  const [extras, setExtras] = useState<Record<string, RouteExtras>>({});
  const [rides, setRides] = useState<RideRecord[]>(loadRides);
  const [selectedRideId, setSelectedRideId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ------------------------------------------------------------ groepsrit
  const groupRef = useRef<GroupRide | null>(null);
  const [group, setGroup] = useState<GroupRide | null>(null);
  const [riders, setRidersState] = useState<Rider[]>([]);
  const ridersRef = useRef<Rider[]>([]);
  const setRiders = (r: Rider[]) => {
    ridersRef.current = r;
    setRidersState(r);
  };
  const [groupStatus, setGroupStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [groupSheet, setGroupSheet] = useState(false);
  const [nameDialog, setNameDialog] = useState<{ mode: 'start' | 'join'; code?: string; routeCode?: string | null } | null>(null);
  const [pendingRoute, setPendingRoute] = useState<{ code: string; from: string } | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);

  const [nav, setNav] = useState<{ route: Route; demo: boolean; name: string; fuel: Poi[] } | null>(null);
  const [navView, setNavView] = useState<NavView | null>(null);
  const [follow, setFollow] = useState(true);

  const selected = candidates.find((c) => c.id === selectedId);
  const selectedRide = rides.find((r) => r.id === selectedRideId);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ------------------------------------------------------------ nachtmodus
  const [night, setNight] = useState(false);
  useEffect(() => {
    const check = () => setNight(isDark(new Date(), myLoc ?? plan.start ?? NL_CENTER));
    check();
    const t = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [myLoc, plan.start]);
  const mapStyle = settings.mapStyle === 'auto' ? (night ? 'dark' : 'light') : settings.mapStyle;

  // ------------------------------------------------------------ opstarten
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

    // Gedeelde route via link? (ook als de app al open stond)
    openSharedFromUrl();
    window.addEventListener('hashchange', openSharedFromUrl);
    return () => window.removeEventListener('hashchange', openSharedFromUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openSharedFromUrl() {
    // Uitnodiging voor een groepsrit? (#g=CODE, eventueel met &r=route)
    const g = groupCodeFromUrl();
    const routeMatch = location.hash.match(/[#&]r=([\w-]+)/);
    const shared = takeSharedFromUrl();
    if (g) {
      if (!shared) history.replaceState(null, '', location.pathname + location.search);
      if (groupRef.current?.code !== g) setNameDialog({ mode: 'join', code: g, routeCode: routeMatch?.[1] ?? null });
    }
    if (shared) openShared(shared);
  }

  function openShared(shared: SharedRoute) {
    {
      setBusy('Gedeelde route laden…');
      routeMany(
        [{ ...shared.start, type: 'break' }, ...shared.vias.map((v) => ({ ...v, type: 'through' as const })), { ...shared.end, type: 'break' }],
        shared.prefs,
      )
        .then((r) => {
          const c = candidateFromRoute(r, shared.prefs, shared.name, `shared-${Date.now()}`);
          setPlan({
            ...loadPlanSettings(DEFAULT_PLAN),
            mode: shared.mode,
            prefs: shared.prefs,
            start: { ...shared.start, name: shared.name.split(/ [–→] /)[0] },
            end: shared.mode === 'ab' ? { ...shared.end, name: shared.name.split(' → ')[1] ?? 'Bestemming' } : null,
          });
          showSingle(c);
          setToast(`Gedeelde route geopend: ${shared.name}`);
        })
        .catch((e) => setError(`Gedeelde route kon niet geladen worden. ${errMsg(e)}`))
        .finally(() => setBusy(null));
    }
  }

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

  function showSingle(c: Candidate) {
    setCandidates([c]);
    setSelectedId(c.id);
    setShowResults(true);
    setTab('plan');
    setSheetOpen(true);
    setFitKey(Date.now());
  }

  // ------------------------------------------------------------ genereren
  const runGenerate = useCallback(async () => {
    if (!plan.start) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setGenerating(true);
    setError(null);
    setProgress(null);
    if (departure.getTime() < Date.now() - 10 * 60000) setDeparture(new Date());
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
      if (!ctrl.signal.aborted) setError(errMsg(e) || 'Er ging iets mis bij het maken van de route.');
    } finally {
      if (abortRef.current === ctrl) {
        setGenerating(false);
        setProgress(null);
      }
    }
  }, [plan, departure]);

  const selectCandidate = (id: string) => {
    setSelectedId(id);
    setFitKey(Date.now());
  };

  // ------------------------------------------------------------ extra info per route
  const setExtra = (id: string, patch: Partial<RouteExtras>) =>
    setExtras((cur) => ({ ...cur, [id]: { ...(cur[id] ?? EMPTY_EXTRAS), ...patch } }));

  const loadExtra = useCallback(
    (c: Candidate, what: keyof RouteExtras, dep: Date) => {
      setExtra(c.id, { [what]: { state: 'loading' } });
      const p =
        what === 'elevation' ? elevation(c.route) : what === 'weather' ? weatherAlongRoute(c.route, dep) : poisAlongRoute(c.route);
      (p as Promise<unknown>)
        .then((data) => setExtra(c.id, { [what]: { state: 'ok', data } } as Partial<RouteExtras>))
        .catch((e) => setExtra(c.id, { [what]: { state: 'error', error: errMsg(e) } }));
    },
    [],
  );

  // Bij het selecteren van een route (even wachten zodat snel doorklikken geen verzoeken spamt)
  useEffect(() => {
    if (!selected || !showResults || nav) return;
    const t = setTimeout(() => {
      const ex = extras[selected.id] ?? EMPTY_EXTRAS;
      if (ex.elevation.state === 'idle') loadExtra(selected, 'elevation', departure);
      if (ex.weather.state === 'idle') loadExtra(selected, 'weather', departure);
      if (ex.pois.state === 'idle') loadExtra(selected, 'pois', departure);
    }, 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, showResults, nav]);

  // Andere vertrektijd: weer opnieuw ophalen
  const depKey = Math.round(departure.getTime() / 60000);
  const firstDep = useRef(true);
  useEffect(() => {
    if (firstDep.current) {
      firstDep.current = false;
      return;
    }
    if (selected && showResults) loadExtra(selected, 'weather', departure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);

  const selExtras = selected ? extras[selected.id] ?? EMPTY_EXTRAS : EMPTY_EXTRAS;
  const selPois = selExtras.pois.state === 'ok' ? selExtras.pois.data : [];
  const suggestions = selected ? stopSuggestions(selected.route, selPois, settings.fuelRangeKm) : null;

  const sunInfo = useMemo(() => {
    if (!selected) return null;
    const t = sunTimes(departure, selected.route.start);
    if (!t) return null;
    const arrival = new Date(departure.getTime() + selected.route.timeS * 1000);
    const startsDark = departure < t.sunrise || departure > t.sunset;
    const darkFrom = Math.max(departure.getTime(), t.sunset.getTime());
    const darkMinutes = arrival.getTime() > darkFrom && !startsDark ? Math.round((arrival.getTime() - darkFrom) / 60000) : 0;
    return { sunset: t.sunset, arrival, darkMinutes, startsDark };
  }, [selected, departure]);

  // ------------------------------------------------------------ route aanpassen
  const rebuild = async (c: Candidate, vias: LatLng[], what: string) => {
    setBusy(what);
    setMenu(null);
    try {
      const locs: RoutingLocation[] = [
        { ...c.route.start, type: 'break' },
        ...vias.map((v) => ({ ...v, type: 'through' as const })),
        { ...c.route.end, type: 'break' },
      ];
      let r: Route;
      try {
        r = await routeMany(locs, plan.prefs);
      } catch {
        // Punt ligt misschien op een doodlopende weg: probeer als gewone tussenstop
        r = await routeMany(locs.map((l, i) => (i === 0 || i === locs.length - 1 ? l : { ...l, type: 'via' as const })), plan.prefs);
      }
      const label = c.label.endsWith('(aangepast)') ? c.label : `${c.label} (aangepast)`;
      const prefix = c.id.match(/^(import|shared|saved)-/)?.[0] ?? '';
      const n = candidateFromRoute(r, plan.prefs, label, `${prefix}edit-${Date.now()}`);
      setCandidates((cur) => cur.map((x) => (x.id === c.id ? n : x)));
      setSelectedId(n.id);
    } catch (e) {
      setToast(`Aanpassen lukte niet: ${errMsg(e)}`);
    } finally {
      setBusy(null);
    }
  };

  /** Voeg een tussenpunt toe op de logische plek in de route. */
  const addVia = (p: LatLng) => {
    if (!selected) return;
    const r = selected.route;
    const pAlong = projectOnRoute(p, r.shape, r.cum)?.along ?? r.lengthM;
    let from = 0;
    const viaAlong = r.vias.map((v) => {
      const pr = projectOnRoute(v, r.shape, r.cum, from);
      from = pr?.index ?? from;
      return pr?.along ?? 0;
    });
    const idx = viaAlong.filter((a) => a < pAlong).length;
    const vias = [...r.vias.slice(0, idx), p, ...r.vias.slice(idx)];
    rebuild(selected, vias, 'Tussenpunt toevoegen…');
  };

  const moveVia = (index: number, p: LatLng) => {
    if (!selected) return;
    const vias = selected.route.vias.map((v, i) => (i === index ? p : v));
    rebuild(selected, vias, 'Route aanpassen…');
  };

  const removeVia = (index: number) => {
    if (!selected) return;
    rebuild(
      selected,
      selected.route.vias.filter((_, i) => i !== index),
      'Tussenpunt verwijderen…',
    );
  };

  // ------------------------------------------------------------ acties
  const startNav = (demo = false) => {
    if (!selected) return;
    unlockVoice(); // iOS: spraak moet vanuit een tik worden gestart
    setFollow(true);
    setNav({
      route: selected.route,
      demo,
      name: routeName(plan, selected),
      fuel: suggestions?.allFuel.filter((p) => p.offset < 500) ?? [],
    });
  };

  const onMapClick = (p: LatLng, screen: { x: number; y: number }) => {
    if (nav || tab !== 'plan' || busy) {
      setMenu(null);
      return;
    }
    setMenu({ kind: 'map', p, ...screen });
  };

  const setPoint = async (which: 'start' | 'end', p: LatLng) => {
    setMenu(null);
    const label = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
    const next = { ...plan, [which]: { ...p, name: label } };
    if (which === 'end' && plan.mode === 'loop') {
      next.mode = 'ab';
      next.targetKind = 'none';
    }
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
      const prefs: RoutePrefs = { ...defaultPrefs, ...s.prefs };
      const r = await routeMany(
        [{ ...s.start, type: 'break' }, ...s.vias.map((v) => ({ ...v, type: 'through' as const })), { ...s.end, type: 'break' }],
        prefs,
      );
      const c = candidateFromRoute(r, prefs, s.name, `saved-${s.id}`);
      setPlan({
        ...plan,
        mode: s.mode,
        prefs,
        start: { ...s.start, name: s.name.split(/ [–→] /)[0] },
        end: s.mode === 'ab' ? { ...s.end, name: s.name.split(' → ')[1] ?? 'Bestemming' } : plan.end,
      });
      setSavedIds((cur) => new Set(cur).add(c.id));
      showSingle(c);
    } catch (e) {
      alert(errMsg(e));
    } finally {
      setLoadingSavedId(null);
    }
  };

  const importGpx = async () => {
    const file = await pickGpxFile();
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      const gpx = parseGpx(file.text, file.name);
      const r = await gpxToRoute(gpx, plan.prefs);
      const c = candidateFromRoute(r, plan.prefs, gpx.name, `import-${Date.now()}`);
      const loop = isLoop(gpx.track.length ? gpx.track : gpx.routePoints);
      setPlan({
        ...plan,
        mode: loop ? 'loop' : 'ab',
        targetKind: loop ? plan.targetKind === 'none' ? 'distance' : plan.targetKind : 'none',
        start: { ...r.start, name: `${gpx.name} (start)` },
        end: loop ? plan.end : { ...r.end, name: `${gpx.name} (einde)` },
      });
      showSingle(c);
      setToast(`GPX geopend: ${formatKm(r.lengthM)}, ${r.maneuvers.length} aanwijzingen`);
    } catch (e) {
      setError(`GPX openen mislukt: ${errMsg(e)}`);
    } finally {
      setImporting(false);
    }
  };

  const share = async () => {
    if (!selected) return;
    const res = await shareRoute({
      name: routeName(plan, selected),
      mode: plan.mode,
      start: selected.route.start,
      end: selected.route.end,
      vias: selected.route.vias,
      prefs: plan.prefs,
    });
    if (res === 'copied') setShareNotice('Link gekopieerd');
    if (res === 'shared') setShareNotice('Gedeeld');
    setTimeout(() => setShareNotice(null), 2500);
  };

  const makeOffline = async () => {
    if (!selected) return;
    const id = selected.id;
    setOffline((o) => ({ ...o, [id]: { state: 'loading', text: 'Voorbereiden…' } }));
    try {
      const res = await downloadRouteMap(selected.route, (p) =>
        setOffline((o) => ({ ...o, [id]: { state: 'loading', text: `${Math.round((p.done / p.total) * 100)}%` } })),
      );
      setOffline((o) => ({
        ...o,
        [id]: { state: 'done', text: `Kaart rond de route opgeslagen (${res.total} delen, ${(res.bytes / 1e6).toFixed(1)} MB nieuw). Werkt ook zonder bereik.` },
      }));
    } catch (e) {
      setOffline((o) => ({ ...o, [id]: { state: 'error', text: errMsg(e) } }));
    }
  };

  // ------------------------------------------------------------ groepsrit
  const currentShareCode = () =>
    selected
      ? encodeShare({
          name: routeName(plan, selected),
          mode: plan.mode,
          start: selected.route.start,
          end: selected.route.end,
          vias: selected.route.vias,
          prefs: plan.prefs,
        })
      : null;

  const joinGroup = (code: string, name: string, host: boolean, routeCode: string | null) => {
    groupRef.current?.leave();
    updateSettings({ riderName: name });
    const g = new GroupRide(code, name, host, routeCode, {
      onRiders: setRiders,
      onStatus: setGroupStatus,
      onMessage: (m) => {
        const q = QUICK[m.kind];
        setToast(`${q.icon} ${m.name}: ${q.text}`);
        speak(`${m.name} ${q.spoken}.`, true);
      },
      onRoute: (rc, from) => {
        const who = ridersRef.current.find((r) => r.id === from)?.name ?? 'Een groepsgenoot';
        setPendingRoute({ code: rc, from: who });
        setToast(`${who} heeft een nieuwe route gedeeld`);
      },
    });
    g.connect();
    groupRef.current = g;
    setGroup(g);
    setRiders([]);
    storeGroup({ code, host, routeCode, at: Date.now() });
  };

  const leaveGroup = () => {
    groupRef.current?.leave();
    groupRef.current = null;
    setGroup(null);
    setRiders([]);
    setGroupSheet(false);
    setPendingRoute(null);
    storeGroup(null);
  };

  const inviteGroup = async () => {
    if (!group) return;
    const url = groupInviteUrl(group.code, group.routeCode);
    const text = `Rij je mee? Groepsrit in MotoTrips (code ${group.code})`;
    try {
      if (navigator.share) await navigator.share({ title: 'Groepsrit', text, url });
      else {
        await navigator.clipboard.writeText(url);
        setInviteNotice('Link gekopieerd');
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        prompt('Kopieer deze uitnodiging:', url);
      }
    }
    setTimeout(() => setInviteNotice(null), 2500);
  };

  const sendQuick = (k: QuickKind) => {
    groupRef.current?.sendMessage(k);
    setToast(`${QUICK[k].icon} Verstuurd: ${QUICK[k].text}`);
  };

  // Na herladen automatisch terug in je groep
  useEffect(() => {
    const st = loadStoredGroup();
    const name = getSettings().riderName;
    if (st && name && groupRidesAvailable() && !groupCodeFromUrl()) joinGroup(st.code, name, st.host, st.routeCode);
    return () => groupRef.current?.leave() as unknown as void;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Eigen positie delen zolang je in de groep zit en niet navigeert (de navigatie stuurt zelf)
  useEffect(() => {
    if (!group || nav || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setMyLoc({ lat: p.coords.latitude, lon: p.coords.longitude });
        group.sendPosition(
          {
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            heading: p.coords.heading ?? 0,
            speedKmh: (p.coords.speed ?? 0) * 3.6,
            accuracy: p.coords.accuracy,
          },
          false,
        );
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [group, nav]);

  const riderInfos: RiderInfo[] = useMemo(() => {
    const me = navView?.position ?? myLoc;
    const r = selected?.route;
    let myAlong: number | null = null;
    if (me && r) {
      const pr = projectOnRoute(me, r.shape, r.cum);
      if (pr && pr.offset < 300) myAlong = pr.along;
    }
    return riders.map((rd) => {
      if (!rd.pos || !me) return { rider: rd, delta: null, straight: null };
      let delta: number | null = null;
      if (r && myAlong !== null) {
        const pr = projectOnRoute(rd.pos, r.shape, r.cum);
        if (pr && pr.offset < 300) delta = pr.along - myAlong;
      }
      return { rider: rd, delta, straight: Math.round(Math.hypot((rd.pos.lat - me.lat) * 111320, (rd.pos.lon - me.lon) * 111320 * Math.cos((me.lat * Math.PI) / 180))) };
    });
  }, [riders, navView, myLoc, selected]);

  const mapRiders = useMemo(
    () =>
      riders
        .filter((r) => r.pos)
        .map((r) => ({ id: r.id, name: r.name, color: r.color, lat: r.pos!.lat, lon: r.pos!.lon, heading: r.pos!.heading, stale: isStale(r) })),
    [riders],
  );

  // ------------------------------------------------------------ kaart
  const mapCandidates = useMemo(() => {
    if (tab === 'rides' && selectedRide) return [{ id: 'ride', shape: rideTrack(selectedRide), kind: 'ride' as const }];
    return showResults && tab === 'plan' ? candidates.map((c) => ({ id: c.id, shape: c.route.shape })) : [];
  }, [candidates, showResults, tab, selectedRide]);

  useEffect(() => {
    if (selectedRide) setFitKey(Date.now());
  }, [selectedRide]);

  const mapPois = useMemo(() => {
    if (!suggestions || !showResults || tab !== 'plan') return [];
    const seen = new Set<number>();
    return [...suggestions.fuelList, ...suggestions.pauseList].filter((p) => !seen.has(p.id) && seen.add(p.id));
  }, [suggestions, showResults, tab]);

  const padding = useMemo(() => {
    if (nav) return { top: 0, bottom: 110, left: 0, right: 0 };
    if (wide) return { top: 0, bottom: 0, left: 420, right: 0 };
    return { top: 0, bottom: sheetOpen ? Math.round(window.innerHeight * 0.55) : 80, left: 0, right: 0 };
  }, [nav, wide, sheetOpen]);

  const resultsMode = showResults && tab === 'plan' && !!selected;

  return (
    <div className={`app ${nav ? 'navigating' : ''} ${wide ? 'wide' : 'narrow'} map-${mapStyle}`}>
      <MapView
        styleName={mapStyle}
        candidates={mapCandidates}
        selectedId={tab === 'rides' ? 'ride' : selectedId}
        start={nav || tab === 'rides' ? null : plan.start}
        end={nav ? nav.route.end : tab === 'rides' ? null : plan.mode === 'ab' ? plan.end : null}
        vias={resultsMode ? selected.route.vias : []}
        editable={resultsMode && !busy}
        pois={mapPois}
        riders={mapRiders}
        fitKey={fitKey}
        centerOn={centerOn}
        nav={navView ? { ...navView, follow } : null}
        padding={padding}
        onMapClick={onMapClick}
        onCandidateClick={selectCandidate}
        onUserPan={() => {
          setMenu(null);
          if (nav) setFollow(false);
        }}
        onViaDrag={moveVia}
        onViaClick={(index, s) => setMenu({ kind: 'via', index, ...s })}
        onPoiClick={(poi, s) => setMenu({ kind: 'poi', poi, ...s })}
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
              <button className={tab === 'rides' ? 'on' : ''} onClick={() => (setTab('rides'), setSheetOpen(true))} title="Ritlogboek">
                <IconLog size={18} />
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
                  setSavedIds((cur) => new Set(cur).add(selected.id));
                }}
                savedNotice={!!selected && savedIds.has(selected.id)}
                onShare={share}
                shareNotice={shareNotice}
                onOffline={makeOffline}
                offline={(selected && offline[selected.id]) || { state: 'idle' }}
                onImportGpx={importGpx}
                inGroup={!!group}
                onGroup={() => {
                  if (!groupRidesAvailable()) {
                    setToast('Samen rijden is nog niet ingesteld (server ontbreekt).');
                    return;
                  }
                  if (group) {
                    const rc = currentShareCode();
                    if (rc) group.sendRoute(rc);
                    storeGroup({ code: group.code, host: group.host, routeCode: rc, at: Date.now() });
                    setGroupSheet(true);
                    setToast('Route gedeeld met de groep');
                  } else setNameDialog({ mode: 'start' });
                }}
                importing={importing}
                hasRides={rides.length > 0}
                details={
                  selected ? (
                    <RouteDetails
                      route={selected.route}
                      extras={selExtras}
                      departure={departure}
                      setDeparture={setDeparture}
                      fuelRangeKm={settings.fuelRangeKm}
                      sun={sunInfo}
                      onAddStop={addVia}
                      onFocus={(p) => setCenterOn({ p, key: Date.now() })}
                      onRetry={(what) => loadExtra(selected, what, departure)}
                    />
                  ) : null
                }
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
            {tab === 'rides' && (
              <Logbook
                rides={rides}
                selectedId={selectedRideId}
                onSelect={setSelectedRideId}
                onGpx={(r) => downloadRideGpx(r)}
                onDelete={(id) => {
                  deleteRide(id);
                  setRides(loadRides());
                  setSelectedRideId(null);
                }}
              />
            )}
            {tab === 'settings' && <Settings />}
          </div>
        </aside>
      )}

      {menu && !nav && (
        <div className="click-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.kind === 'map' && resultsMode && (
            <>
              <button onClick={() => addVia(menu.p)}>
                <span className="place-dot dot-via" /> Tussenpunt hier toevoegen
              </button>
              <button onClick={() => setMenu(null)}>Annuleren</button>
            </>
          )}
          {menu.kind === 'map' && !resultsMode && (
            <>
              <button onClick={() => setPoint('start', menu.p)}>
                <span className="place-dot dot-a">A</span> {plan.mode === 'loop' ? 'Start hier' : 'Vertrek hier'}
              </button>
              <button onClick={() => setPoint('end', menu.p)}>
                <span className="place-dot dot-b">B</span> Bestemming hier
              </button>
            </>
          )}
          {menu.kind === 'via' && (
            <>
              <button onClick={() => removeVia(menu.index)}>✕ Tussenpunt verwijderen</button>
              <button onClick={() => setMenu(null)}>Annuleren</button>
            </>
          )}
          {menu.kind === 'poi' && (
            <>
              <div className="menu-title">
                {menu.poi.kind === 'fuel' ? '⛽' : menu.poi.kind === 'cafe' ? '☕' : '🍽️'} {menu.poi.name}
                {menu.poi.opening && <small>{menu.poi.opening}</small>}
              </div>
              <button onClick={() => addVia(menu.poi)}>+ Als stop toevoegen</button>
              <button onClick={() => setMenu(null)}>Sluiten</button>
            </>
          )}
        </div>
      )}

      {group && !nav && <GroupChip count={riders.filter((r) => r.online).length} status={groupStatus} onClick={() => setGroupSheet(true)} />}

      {groupSheet && group && (
        <GroupSheet
          code={group.code}
          me={group.me.name}
          infos={riderInfos}
          status={groupStatus}
          pendingRoute={pendingRoute}
          canSendRoute={!!selected}
          onInvite={inviteGroup}
          inviteNotice={inviteNotice}
          onSendRoute={() => {
            const rc = currentShareCode();
            if (!rc) return;
            group.sendRoute(rc);
            storeGroup({ code: group.code, host: group.host, routeCode: rc, at: Date.now() });
            setToast('Route gedeeld met de groep');
          }}
          onLoadRoute={() => {
            const s = pendingRoute && decodeShare(pendingRoute.code);
            setPendingRoute(null);
            setGroupSheet(false);
            if (s) openShared(s);
          }}
          onQuick={sendQuick}
          onLeave={leaveGroup}
          onClose={() => setGroupSheet(false)}
        />
      )}

      {nameDialog && (
        <GroupNameDialog
          mode={nameDialog.mode}
          code={nameDialog.code}
          initialName={settings.riderName}
          onCancel={() => setNameDialog(null)}
          onConfirm={(name) => {
            const d = nameDialog;
            setNameDialog(null);
            if (d.mode === 'start') {
              joinGroup(newGroupCode(), name, true, currentShareCode());
              setGroupSheet(true);
            } else if (d.code) {
              joinGroup(d.code, name, false, d.routeCode ?? null);
              setToast(`Je rijdt mee in groep ${d.code}`);
            }
          }}
        />
      )}

      {busy && <div className="busy-toast">{busy}</div>}
      {toast && !busy && <div className="busy-toast info">{toast}</div>}

      {nav && (
        <NavigationView
          key={nav.route.lengthM + ':' + nav.demo}
          route={nav.route}
          name={nav.name}
          prefs={plan.prefs}
          demo={nav.demo}
          follow={follow}
          fuelStops={nav.fuel}
          setFollow={setFollow}
          onView={setNavView}
          riders={group ? riders : []}
          onQuick={group ? sendQuick : undefined}
          onFix={group ? (f) => group.sendPosition(f, true) : undefined}
          onExit={(ride) => {
            setNav(null);
            setNavView(null);
            setFitKey(Date.now());
            if (ride) {
              setRides(loadRides());
              setToast(`Rit opgeslagen in je logboek (${formatKm(ride.distanceM)})`);
            }
          }}
        />
      )}
    </div>
  );
}

function formatKm(m: number) {
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

function downloadRideGpx(r: RideRecord) {
  const track = rideTrack(r);
  const fake: Route = {
    shape: track,
    cum: [],
    maneuvers: [],
    lengthM: r.distanceM,
    timeS: r.movingS,
    hasHighway: false,
    hasToll: false,
    hasFerry: false,
    vias: [],
    start: track[0],
    end: track[track.length - 1],
  };
  const blob = new Blob([toGpx(fake, r.name).replace(/\s*<rte>[\s\S]*<\/rte>/, '')], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${r.name.replace(/[^\w\- ]+/g, '').trim() || 'rit'}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
