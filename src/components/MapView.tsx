import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { cumulative, type LatLng } from '../lib/geo';
import { poiIcon, type Poi } from '../lib/overpass';

// MapLibre zoekt zijn worker naast het eigen bestand; via Vite moet dat expliciet.
maplibregl.setWorkerUrl(new URL(workerUrl, window.location.href).href);

/** Eén navigatie-update (elke GPS-meting). */
export interface NavView {
  position: LatLng;
  heading: number;
  speedKmh: number;
  /** Afgelegde afstand langs de route (m) */
  along: number;
  offRoute: boolean;
  /** De volledige route (zelfde object zolang de route niet verandert) */
  shape: LatLng[];
  follow: boolean;
}

/** Wat de app rechtstreeks op de kaart mag aanroepen (zonder alles opnieuw op te bouwen). */
export interface MapHandle {
  updateNav(v: NavView | null): void;
  setFollow(f: boolean): void;
}

interface Props {
  ref?: Ref<MapHandle>;
  styleName: 'light' | 'dark';
  candidates: { id: string; shape: LatLng[]; kind?: 'route' | 'ride' }[];
  selectedId?: string;
  start?: LatLng | null;
  end?: LatLng | null;
  vias?: LatLng[];
  fitKey?: string | number;
  centerOn?: { p: LatLng; key: number } | null;
  /** Navigatie actief (de updates zelf komen via de handle) */
  navActive: boolean;
  padding: { top: number; bottom: number; left: number; right: number };
  onMapClick?: (p: LatLng, screen: { x: number; y: number }) => void;
  onCandidateClick?: (id: string) => void;
  onUserPan?: () => void;
  pois?: Poi[];
  /** Tussenpunten versleepbaar maken */
  editable?: boolean;
  onViaDrag?: (index: number, p: LatLng) => void;
  onViaClick?: (index: number, screen: { x: number; y: number }) => void;
  onPoiClick?: (poi: Poi, screen: { x: number; y: number }) => void;
  /** Groepsgenoten */
  riders?: { id: string; name: string; color: string; lat: number; lon: number; heading: number; stale: boolean }[];
}

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const ACCENT = '#ff6b1a';
const CASING = '#5a1f00';
const CLEAR = 'rgba(0,0,0,0)';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const line = (shape: LatLng[]): GeoJSON.LineString => ({ type: 'LineString', coordinates: shape.map((p) => [p.lon, p.lat]) });

/** Kleurverloop langs de route: het gereden stuk (tot `frac`) onzichtbaar, de rest in kleur. */
const progressGradient = (frac: number, color: string) =>
  (frac <= 0 ? ['step', ['line-progress'], color, 1, color] : ['step', ['line-progress'], CLEAR, Math.min(frac, 1), color]) as maplibregl.ExpressionSpecification;

/** Lengtes in kaartprojectie (zo meet MapLibre "line-progress"). */
function mercatorCumulative(shape: LatLng[]): number[] {
  const y = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const out = new Array<number>(shape.length);
  out[0] = 0;
  for (let i = 1; i < shape.length; i++) {
    const dx = ((shape[i].lon - shape[i - 1].lon) * Math.PI) / 180;
    const dy = y(shape[i].lat) - y(shape[i - 1].lat);
    out[i] = out[i - 1] + Math.hypot(dx, dy);
  }
  return out;
}

function markerEl(cls: string, label?: string) {
  // MapLibre zet zelf een transform op het buitenste element, dus de vorm zit erin.
  const el = document.createElement('div');
  el.className = 'pin-wrap';
  const pin = document.createElement('div');
  pin.className = `map-pin ${cls}`;
  if (label) {
    const s = document.createElement('span');
    s.textContent = label;
    pin.appendChild(s);
  }
  el.appendChild(pin);
  return el;
}

function userEl() {
  const el = document.createElement('div');
  el.className = 'user-arrow';
  el.innerHTML =
    '<svg viewBox="0 0 48 48" width="60" height="60"><circle cx="24" cy="24" r="21" fill="rgba(255,107,26,.18)"/><path d="M24 6l12 32-12-7-12 7z" fill="#ff6b1a" stroke="#fff" stroke-width="3" stroke-linejoin="round"/></svg>';
  return el;
}

export function MapView(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const markers = useRef<{ start?: maplibregl.Marker; end?: maplibregl.Marker; vias: maplibregl.Marker[]; pois: maplibregl.Marker[]; user?: maplibregl.Marker }>({ vias: [], pois: [] });
  const styleRef = useRef(props.styleName);
  const riderMarkers = useRef(new Map<string, { m: maplibregl.Marker; el: HTMLDivElement; heading: number }>());

  // Navigatietoestand: de route staat één keer op de kaart, daarna schuift alleen het "gereden" deel op
  const navRef = useRef<{
    shape: LatLng[] | null;
    geoCum: number[];
    mercCum: number[];
    frac: number;
    last: NavView | null;
    follow: boolean;
  }>({ shape: null, geoCum: [], mercCum: [], frac: 0, last: null, follow: true });

  // 3D-gebouwen kosten veel rekenkracht; tijdens navigeren heb je ze niet nodig
  function setBuildings3d(on: boolean) {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    for (const l of map.getStyle().layers) {
      if (l.type === 'fill-extrusion') map.setLayoutProperty(l.id, 'visibility', on ? 'visible' : 'none');
    }
  }

  function applyNavLine() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const n = navRef.current;
    (map.getSource('nav') as maplibregl.GeoJSONSource | undefined)?.setData(
      n.shape && n.shape.length > 1 ? { type: 'Feature', properties: {}, geometry: line(n.shape) } : EMPTY,
    );
    applyProgress(true);
  }

  function applyProgress(force = false) {
    const map = mapRef.current;
    if (!map || !ready.current || !map.getLayer('nav-line')) return;
    const n = navRef.current;
    const v = n.last;
    let frac = 0;
    if (v && n.shape && !v.offRoute && n.geoCum.length > 1) {
      // afstand langs de route → positie in kaartprojectie
      const along = Math.max(0, Math.min(v.along, n.geoCum[n.geoCum.length - 1]));
      let lo = 0;
      let hi = n.geoCum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (n.geoCum[mid] <= along) lo = mid;
        else hi = mid;
      }
      const seg = n.geoCum[hi] - n.geoCum[lo];
      const t = seg > 0 ? (along - n.geoCum[lo]) / seg : 0;
      const merc = n.mercCum[lo] + (n.mercCum[hi] - n.mercCum[lo]) * t;
      const total = n.mercCum[n.mercCum.length - 1];
      frac = total > 0 ? merc / total : 0;
    }
    // Alleen bijwerken als het zichtbaar verschilt (± een paar meter)
    if (!force && Math.abs(frac - n.frac) < 0.00005) return;
    n.frac = frac;
    map.setPaintProperty('nav-line', 'line-gradient', progressGradient(frac, ACCENT));
    map.setPaintProperty('nav-casing', 'line-gradient', progressGradient(frac, CASING));
  }

  function applyCamera() {
    const map = mapRef.current;
    const nav = navRef.current.last;
    if (!map || !nav) return;
    const m = markers.current;
    if (!m.user) {
      m.user = new maplibregl.Marker({ element: userEl(), rotationAlignment: 'map', pitchAlignment: 'map' }).setLngLat([nav.position.lon, nav.position.lat]).addTo(map);
    }
    m.user.setLngLat([nav.position.lon, nav.position.lat]).setRotation(nav.heading);
    if (navRef.current.follow) {
      const h = map.getContainer().clientHeight;
      // Sneller rijden = verder vooruit kijken
      const zoom = nav.speedKmh > 90 ? 15.2 : nav.speedKmh > 60 ? 15.8 : nav.speedKmh > 30 ? 16.4 : 17;
      map.easeTo({
        center: [nav.position.lon, nav.position.lat],
        bearing: nav.heading,
        pitch: 55,
        zoom,
        padding: { top: Math.round(h * 0.42), bottom: propsRef.current.padding.bottom, left: 0, right: 0 },
        duration: 950,
        easing: (t) => t,
      });
    }
  }

  useImperativeHandle(props.ref, () => ({
    updateNav(v) {
      const map = mapRef.current;
      const n = navRef.current;
      if (!v) {
        n.last = null;
        n.shape = null;
        applyNavLine();
        setBuildings3d(true);
        const m = markers.current;
        if (m.user && map) {
          m.user.remove();
          m.user = undefined;
          map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
        }
        return;
      }
      n.last = v;
      n.follow = v.follow;
      if (v.shape !== n.shape) {
        // Nieuwe (of herberekende) route: één keer op de kaart zetten
        n.shape = v.shape;
        n.geoCum = cumulative(v.shape);
        n.mercCum = mercatorCumulative(v.shape);
        n.frac = -1;
        applyNavLine();
        setBuildings3d(false);
      }
      applyProgress();
      applyCamera();
    },
    setFollow(f) {
      navRef.current.follow = f;
      if (f) applyCamera(); // meteen terug naar je positie
    },
  }));

  // Kaart één keer aanmaken
  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLES[props.styleName],
      center: [5.6, 52.2],
      zoom: 7,
      attributionControl: { compact: true },
      maxPitch: 70,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    const setup = () => {
      // Plaatsnamen lokaal, land- en regionamen in het Nederlands
      for (const layer of map.getStyle().layers) {
        if (layer.type !== 'symbol' || !layer.layout?.['text-field']) continue;
        const json = JSON.stringify(layer.layout['text-field']);
        if (!/name/.test(json)) continue;
        const nl = /country|state|continent/.test(layer.id);
        map.setLayoutProperty(layer.id, 'text-field', nl ? ['coalesce', ['get', 'name:nl'], ['get', 'name']] : ['get', 'name']);
      }
      if (!map.getSource('cands')) {
        map.addSource('cands', { type: 'geojson', data: EMPTY });
        // lineMetrics: nodig om het gereden stuk weg te laten zonder de lijn opnieuw te sturen
        map.addSource('nav', { type: 'geojson', data: EMPTY, lineMetrics: true });
        map.addLayer({
          id: 'cands-alt',
          type: 'line',
          source: 'cands',
          filter: ['!=', ['get', 'selected'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#7c8794', 'line-width': 5, 'line-opacity': 0.75 },
        });
        map.addLayer({
          id: 'cands-casing',
          type: 'line',
          source: 'cands',
          filter: ['==', ['get', 'selected'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'ride'], '#0b2a4d', CASING], 'line-width': 10 },
        });
        map.addLayer({
          id: 'cands-sel',
          type: 'line',
          source: 'cands',
          filter: ['==', ['get', 'selected'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['case', ['==', ['get', 'kind'], 'ride'], '#3d9bff', ACCENT], 'line-width': 6 },
        });
        map.addLayer({
          id: 'nav-casing',
          type: 'line',
          source: 'nav',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-gradient': progressGradient(0, CASING), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 18, 22] },
        });
        map.addLayer({
          id: 'nav-line',
          type: 'line',
          source: 'nav',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-gradient': progressGradient(0, ACCENT), 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 18, 16] },
        });
      }
      ready.current = true;
      syncData();
      // Na wisselen van kaartstijl (bijv. nachtmodus) de navigatielijn herstellen
      if (navRef.current.shape) {
        applyNavLine();
        setBuildings3d(false);
      }
    };
    map.on('style.load', setup);

    map.on('click', (e) => {
      const feats = map.queryRenderedFeatures(
        [
          [e.point.x - 8, e.point.y - 8],
          [e.point.x + 8, e.point.y + 8],
        ],
        { layers: ['cands-alt'] },
      );
      if (feats.length && propsRef.current.onCandidateClick) {
        propsRef.current.onCandidateClick(String(feats[0].properties.id));
        return;
      }
      propsRef.current.onMapClick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }, { x: e.point.x, y: e.point.y });
    });
    map.on('mouseenter', 'cands-alt', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'cands-alt', () => (map.getCanvas().style.cursor = ''));
    map.on('dragstart', () => propsRef.current.onUserPan?.());
    // Pijlen van groepsgenoten meedraaien met de kaart (alleen als de kaart draait)
    map.on('rotate', () => {
      const b = map.getBearing();
      for (const e of riderMarkers.current.values()) {
        (e.el.firstElementChild as HTMLDivElement).style.transform = `rotate(${e.heading - b}deg)`;
      }
    });

    return () => {
      ready.current = false;
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kaartstijl wisselen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || styleRef.current === props.styleName) return;
    styleRef.current = props.styleName;
    ready.current = false;
    map.setStyle(STYLES[props.styleName]);
  }, [props.styleName]);

  function syncData() {
    const map = mapRef.current;
    if (!map || !ready.current) return;
    const p = propsRef.current;
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: p.candidates
        .map((c) => ({
          type: 'Feature' as const,
          properties: { id: c.id, selected: c.id === p.selectedId, kind: c.kind ?? 'route' },
          geometry: line(c.shape),
        }))
        // geselecteerde route bovenop tekenen
        .sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected)),
    };
    (map.getSource('cands') as maplibregl.GeoJSONSource | undefined)?.setData(p.navActive ? EMPTY : fc);
  }

  // Routes bijwerken (alleen bij echte veranderingen, niet bij elke GPS-meting)
  useEffect(syncData, [props.candidates, props.selectedId, props.navActive]);

  // Markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const m = markers.current;
    const place = (key: 'start' | 'end', p: LatLng | null | undefined, cls: string, label: string) => {
      if (!p) {
        m[key]?.remove();
        m[key] = undefined;
        return;
      }
      if (!m[key]) m[key] = new maplibregl.Marker({ element: markerEl(cls, label), anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(map);
      else m[key]!.setLngLat([p.lon, p.lat]);
    };
    const sameAsStart = props.start && props.end && Math.abs(props.start.lat - props.end.lat) < 1e-6 && Math.abs(props.start.lon - props.end.lon) < 1e-6;
    place('start', props.start, 'pin-start', 'A');
    place('end', sameAsStart ? null : props.end, 'pin-end', 'B');
    m.vias.forEach((v) => v.remove());
    m.vias = (props.navActive ? [] : props.vias ?? []).map((v, i) => {
      const el = markerEl(props.editable ? 'pin-via editable' : 'pin-via');
      const mk = new maplibregl.Marker({ element: el, draggable: !!props.editable }).setLngLat([v.lon, v.lat]).addTo(map);
      if (props.editable) {
        let dragged = false;
        mk.on('dragstart', () => (dragged = true));
        mk.on('dragend', () => {
          const ll = mk.getLngLat();
          propsRef.current.onViaDrag?.(i, { lat: ll.lat, lon: ll.lng });
          setTimeout(() => (dragged = false), 50);
        });
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (dragged) return;
          const r = map.getContainer().getBoundingClientRect();
          propsRef.current.onViaClick?.(i, { x: ev.clientX - r.left, y: ev.clientY - r.top });
        });
      }
      return mk;
    });
  }, [props.start, props.end, props.vias, props.navActive, props.editable]);

  // Groepsgenoten
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const seen = new Set<string>();
    for (const r of props.riders ?? []) {
      seen.add(r.id);
      let entry = riderMarkers.current.get(r.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'rider-pin';
        el.innerHTML = '<div class="rider-arrow"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M12 2l8 19-8-4-8 4z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div><span class="rider-name"></span>';
        // Midden van de pijl op de positie; naam eronder
        entry = { el, heading: r.heading, m: new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, -15] }).setLngLat([r.lon, r.lat]).addTo(map) };
        riderMarkers.current.set(r.id, entry);
      }
      entry.heading = r.heading;
      entry.m.setLngLat([r.lon, r.lat]);
      const arrow = entry.el.querySelector('.rider-arrow') as HTMLDivElement;
      arrow.style.transform = `rotate(${r.heading - map.getBearing()}deg)`;
      (arrow.querySelector('path') as SVGPathElement).setAttribute('fill', r.color);
      (entry.el.querySelector('.rider-name') as HTMLSpanElement).textContent = r.name;
      entry.el.classList.toggle('stale', r.stale);
    }
    for (const [id, e] of riderMarkers.current) {
      if (!seen.has(id)) {
        e.m.remove();
        riderMarkers.current.delete(id);
      }
    }
  }, [props.riders]);

  // Tankstations en cafés langs de route
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const m = markers.current;
    m.pois.forEach((x) => x.remove());
    m.pois = (props.navActive ? [] : props.pois ?? []).map((poi) => {
      const el = document.createElement('button');
      el.className = `poi-pin ${poi.kind}`;
      el.textContent = poiIcon(poi.kind);
      el.title = poi.name;
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const r = map.getContainer().getBoundingClientRect();
        propsRef.current.onPoiClick?.(poi, { x: ev.clientX - r.left, y: ev.clientY - r.top });
      });
      return new maplibregl.Marker({ element: el }).setLngLat([poi.lon, poi.lat]).addTo(map);
    });
  }, [props.pois, props.navActive]);

  // Inzoomen op routes
  useEffect(() => {
    const map = mapRef.current;
    const p = propsRef.current;
    if (!map || p.fitKey === undefined) return;
    const sel = p.candidates.find((c) => c.id === p.selectedId);
    const pts = sel ? sel.shape : p.candidates.flatMap((c) => c.shape);
    if (pts.length < 2) return;
    const b = new maplibregl.LngLatBounds();
    pts.forEach((q) => b.extend([q.lon, q.lat]));
    map.fitBounds(b, { padding: { top: p.padding.top + 40, bottom: p.padding.bottom + 40, left: p.padding.left + 40, right: p.padding.right + 40 }, duration: 800, pitch: 0, bearing: 0 });
  }, [props.fitKey]);

  // Naar een punt vliegen
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !props.centerOn) return;
    const pad = propsRef.current.padding;
    map.flyTo({ center: [props.centerOn.p.lon, props.centerOn.p.lat], zoom: Math.max(map.getZoom(), 11), duration: 900, padding: pad });
  }, [props.centerOn]);

  return <div ref={container} className="map" />;
}
