import { useEffect, useRef } from 'react';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { LatLng } from '../lib/geo';

// MapLibre zoekt zijn worker naast het eigen bestand; via Vite moet dat expliciet.
maplibregl.setWorkerUrl(new URL(workerUrl, window.location.href).href);

export interface NavView {
  position: LatLng;
  heading: number;
  speedKmh: number;
  remaining: LatLng[];
  follow: boolean;
}

interface Props {
  styleName: 'light' | 'dark';
  candidates: { id: string; shape: LatLng[] }[];
  selectedId?: string;
  start?: LatLng | null;
  end?: LatLng | null;
  vias?: LatLng[];
  fitKey?: string | number;
  centerOn?: { p: LatLng; key: number } | null;
  nav?: NavView | null;
  padding: { top: number; bottom: number; left: number; right: number };
  onMapClick?: (p: LatLng, screen: { x: number; y: number }) => void;
  onCandidateClick?: (id: string) => void;
  onUserPan?: () => void;
}

const STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const ACCENT = '#ff6b1a';
const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const line = (shape: LatLng[]): GeoJSON.LineString => ({ type: 'LineString', coordinates: shape.map((p) => [p.lon, p.lat]) });

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
  const markers = useRef<{ start?: maplibregl.Marker; end?: maplibregl.Marker; vias: maplibregl.Marker[]; user?: maplibregl.Marker }>({ vias: [] });
  const styleRef = useRef(props.styleName);

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
        map.addSource('nav', { type: 'geojson', data: EMPTY });
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
          paint: { 'line-color': '#5a1f00', 'line-width': 10 },
        });
        map.addLayer({
          id: 'cands-sel',
          type: 'line',
          source: 'cands',
          filter: ['==', ['get', 'selected'], true],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ACCENT, 'line-width': 6 },
        });
        map.addLayer({
          id: 'nav-casing',
          type: 'line',
          source: 'nav',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#5a1f00', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 18, 22] },
        });
        map.addLayer({
          id: 'nav-line',
          type: 'line',
          source: 'nav',
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ACCENT, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 18, 16] },
        });
      }
      ready.current = true;
      syncData();
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
          properties: { id: c.id, selected: c.id === p.selectedId },
          geometry: line(c.shape),
        }))
        // geselecteerde route bovenop tekenen
        .sort((a, b) => Number(a.properties.selected) - Number(b.properties.selected)),
    };
    (map.getSource('cands') as maplibregl.GeoJSONSource | undefined)?.setData(p.nav ? EMPTY : fc);
    (map.getSource('nav') as maplibregl.GeoJSONSource | undefined)?.setData(
      p.nav && p.nav.remaining.length > 1 ? { type: 'Feature', properties: {}, geometry: line(p.nav.remaining) } : EMPTY,
    );
  }

  // Routes bijwerken
  useEffect(syncData, [props.candidates, props.selectedId, props.nav]);

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
    m.vias = (props.nav ? [] : props.vias ?? []).map((v) =>
      new maplibregl.Marker({ element: markerEl('pin-via') }).setLngLat([v.lon, v.lat]).addTo(map),
    );
  }, [props.start, props.end, props.vias, props.nav]);

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

  // Navigatie: gebruikerspijl + camera volgen
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const m = markers.current;
    const nav = props.nav;
    if (!nav) {
      if (m.user) {
        m.user.remove();
        m.user = undefined;
        map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
      }
      return;
    }
    if (!m.user) {
      m.user = new maplibregl.Marker({ element: userEl(), rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat([nav.position.lon, nav.position.lat])
        .addTo(map);
    }
    m.user.setLngLat([nav.position.lon, nav.position.lat]).setRotation(nav.heading);
    if (nav.follow) {
      const h = map.getContainer().clientHeight;
      // Sneller rijden = verder vooruit kijken
      const zoom = nav.speedKmh > 90 ? 15.2 : nav.speedKmh > 60 ? 15.8 : nav.speedKmh > 30 ? 16.4 : 17;
      map.easeTo({
        center: [nav.position.lon, nav.position.lat],
        bearing: nav.heading,
        pitch: 55,
        zoom,
        padding: { top: Math.round(h * 0.42), bottom: props.padding.bottom, left: 0, right: 0 },
        duration: 950,
        easing: (t) => t,
      });
    }
  }, [props.nav]);

  return <div ref={container} className="map" />;
}
