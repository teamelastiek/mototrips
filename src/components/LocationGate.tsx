import { useEffect, useState } from 'react';
import type { LatLng } from '../lib/geo';
import { detectPlatform, isInstalledApp, LocationError, locationState, locationSteps, requestLocation } from '../lib/location';
import { IconClose, IconLocate } from './Icons';

export type GateMode = 'ask' | 'denied';

interface Props {
  mode: GateMode;
  onLocated: (p: LatLng) => void;
  onClose: () => void;
}

const PLATFORM_NAME = { ios: 'iPhone / iPad', android: 'Android', samsung: 'Samsung Internet', desktop: 'computer' };

export function LocationGate({ mode: initial, onLocated, onClose }: Props) {
  const [mode, setMode] = useState<GateMode>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  const platform = detectPlatform();

  useEffect(() => setMode(initial), [initial]);

  // Terug uit de instellingen? Dan meteen opnieuw kijken.
  useEffect(() => {
    if (mode !== 'denied') return;
    const on = () => {
      if (document.visibilityState !== 'visible') return;
      locationState().then((s) => {
        if (s === 'granted') ask();
      });
    };
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function ask() {
    setBusy(true);
    setMsg(null);
    try {
      const p = await requestLocation();
      window.dispatchEvent(new Event('mototrips-location-granted'));
      onLocated(p);
    } catch (e) {
      const err = e as LocationError;
      setTries((t) => t + 1);
      if (err.denied) setMode('denied');
      setMsg(err.denied ? (mode === 'denied' ? 'Nog steeds geen toestemming.' : null) : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="loc-title">
      <div className="modal-card loc-card">
        <div className="modal-head">
          <h2 id="loc-title">{mode === 'ask' ? 'Locatie' : 'Locatie staat uit'}</h2>
          <button className="icon-btn ghost" onClick={onClose} title="Sluiten">
            <IconClose />
          </button>
        </div>

        {mode === 'ask' ? (
          <>
            <div className="loc-hero">
              <IconLocate size={34} />
            </div>
            <p className="loc-text">
              MotoTrips heeft je locatie nodig om routes vanaf jouw plek te maken en je onderweg de weg te wijzen.
              Je locatie wordt alleen gebruikt om routes te berekenen en nergens bewaard. Rijd je met een groep, dan zien
              alleen je medereizigers waar je bent.
            </p>
            <p className="loc-text muted">Je telefoon vraagt zo om toestemming. Kies dan "Toestaan".</p>
            <button className="primary big" onClick={ask} disabled={busy}>
              {busy ? 'Even wachten…' : 'Locatie toestaan'}
            </button>
          </>
        ) : (
          <>
            <p className="loc-text">
              Je telefoon geeft MotoTrips geen toegang tot je locatie. De app kan het niet opnieuw vragen, dus zet je het
              zelf aan. Zo doe je dat op je {PLATFORM_NAME[platform]}:
            </p>
            <ol className="steps">
              {locationSteps(platform, isInstalledApp()).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <button className="primary big" onClick={ask} disabled={busy}>
              {busy ? 'Even wachten…' : 'Opnieuw proberen'}
            </button>
            {tries > 1 && (
              <button className="secondary" onClick={() => location.reload()}>
                Lukt het niet? App opnieuw laden
              </button>
            )}
          </>
        )}

        {msg && <div className="field-error">{msg}</div>}
        <p className="loc-foot">Zonder locatie kun je wel routes plannen: typ dan zelf een startpunt in.</p>
        <button className="link-btn" onClick={onClose}>
          Later
        </button>
      </div>
    </div>
  );
}
