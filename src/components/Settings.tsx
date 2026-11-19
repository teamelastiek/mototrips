import { useState } from 'react';
import { DEFAULT_SERVER, getServer, setServer } from '../lib/valhalla';
import { isVoiceEnabled, setVoiceEnabled, speak, unlockVoice } from '../lib/voice';

interface Props {
  mapStyle: 'light' | 'dark';
  setMapStyle: (s: 'light' | 'dark') => void;
}

export function Settings({ mapStyle, setMapStyle }: Props) {
  const [server, setServerState] = useState(getServer());
  const [voice, setVoice] = useState(isVoiceEnabled());

  return (
    <div className="settings">
      <section className="field">
        <h3>Kaart</h3>
        <div className="segmented">
          <button className={mapStyle === 'light' ? 'on' : ''} onClick={() => setMapStyle('light')}>
            Licht
          </button>
          <button className={mapStyle === 'dark' ? 'on' : ''} onClick={() => setMapStyle('dark')}>
            Donker
          </button>
        </div>
      </section>

      <section className="field">
        <h3>Gesproken aanwijzingen</h3>
        <label className="toggle">
          <span>Stem aan</span>
          <input
            type="checkbox"
            checked={voice}
            onChange={(e) => {
              setVoice(e.target.checked);
              setVoiceEnabled(e.target.checked);
            }}
          />
          <i aria-hidden />
        </label>
        <button
          className="secondary"
          onClick={() => {
            unlockVoice();
            speak('Over 400 meter, rechts afslaan naar de Amersfoortseweg.', true);
          }}
        >
          Test de stem
        </button>
        <p className="hint">Koppel je telefoon aan je helm-intercom via Bluetooth om de aanwijzingen te horen.</p>
      </section>

      <section className="field">
        <h3>Routeserver</h3>
        <input className="text-input" value={server} onChange={(e) => setServerState(e.target.value)} onBlur={() => setServer(server)} spellCheck={false} />
        <p className="hint">
          Standaard de gratis Valhalla-server van FOSSGIS (OpenStreetMap). Gebruik je veel routes, draai dan je eigen Valhalla-server en vul die hier in.
          {server !== DEFAULT_SERVER && (
            <>
              {' '}
              <button className="link-btn" onClick={() => (setServerState(DEFAULT_SERVER), setServer(DEFAULT_SERVER))}>
                Herstel standaard
              </button>
            </>
          )}
        </p>
      </section>

      <section className="field about">
        <h3>Over</h3>
        <p className="hint">
          Kaart © OpenStreetMap-bijdragers, OpenFreeMap. Routes door Valhalla. Adressen via Photon. Controleer onderweg altijd zelf de verkeersborden.
        </p>
      </section>
    </div>
  );
}
