import { useEffect, useRef, useState } from 'react';
import { reverseGeocode, searchPlaces, type Place } from '../lib/geocode';
import type { LatLng } from '../lib/geo';
import { IconClose, IconLocate } from './Icons';
import { LocationError, openLocationHelp, requestLocation } from '../lib/location';

export interface NamedPoint extends LatLng {
  name: string;
}

interface Props {
  label: string;
  marker: 'A' | 'B';
  value: NamedPoint | null;
  onChange: (p: NamedPoint | null) => void;
  near?: LatLng | null;
  placeholder?: string;
}

export function getCurrentPosition(): Promise<LatLng> {
  return requestLocation();
}

export function PlaceInput({ label, marker, value, onChange, near, placeholder }: Props) {
  const [text, setText] = useState(value?.name ?? '');
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setText(value?.name ?? '');
  }, [value]);

  useEffect(() => {
    if (!editing.current || text.trim().length < 3) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(text, near ?? undefined, ctrl.signal)
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => {});
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, near]);

  const useMyLocation = async () => {
    setBusy(true);
    setErr(null);
    setDenied(false);
    try {
      const p = await requestLocation();
      editing.current = false;
      onChange({ ...p, name: 'Mijn locatie' });
      reverseGeocode(p).then((name) => onChange({ ...p, name: `Mijn locatie · ${name}` }));
    } catch (e) {
      setErr((e as Error).message);
      if ((e as LocationError).denied) {
        setDenied(true);
        openLocationHelp();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="place">
      <label className="place-label">{label}</label>
      <div className="place-row">
        <span className={`place-dot ${marker === 'A' ? 'dot-a' : 'dot-b'}`}>{marker}</span>
        <input
          className="place-input"
          value={text}
          placeholder={placeholder ?? 'Zoek een plaats of tik op de kaart'}
          onChange={(e) => {
            editing.current = true;
            setText(e.target.value);
          }}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 200)}
          enterKeyHint="search"
        />
        {value && (
          <button
            className="icon-btn ghost"
            title="Wissen"
            onClick={() => {
              editing.current = false;
              setText('');
              onChange(null);
            }}
          >
            <IconClose size={18} />
          </button>
        )}
        <button className="icon-btn" title="Gebruik mijn locatie" onClick={useMyLocation} disabled={busy}>
          <IconLocate size={20} className={busy ? 'spin' : ''} />
        </button>
      </div>
      {err && (
        <div className="field-error">
          {err}
          {denied && (
            <>
              {' · '}
              <button type="button" className="link-btn" onClick={openLocationHelp}>
                Hoe zet ik dit aan?
              </button>
            </>
          )}
        </div>
      )}
      {open && results.length > 0 && (
        <ul className="place-results">
          {results.map((r, i) => (
            <li key={i}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  editing.current = false;
                  setOpen(false);
                  setResults([]);
                  onChange({ lat: r.lat, lon: r.lon, name: r.detail ? `${r.name}, ${r.detail.split(', ')[0]}` : r.name });
                }}
              >
                <strong>{r.name}</strong>
                <span>{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
