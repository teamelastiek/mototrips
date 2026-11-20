import { useEffect, useState } from 'react';
import { clearRidden, riddenCells } from '../lib/logbook';
import { clearOfflineMaps, offlineCacheSize } from '../lib/offline';
import { getSettings, updateSettings, type AppSettings } from '../lib/settings';
import { DEFAULT_SERVER, getServer, setServer } from '../lib/valhalla';
import { announce, isVoiceEnabled, setVoiceEnabled, speak, unlockVoice } from '../lib/voice';
import { MicTest } from './MicTest';

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

export function Settings() {
  const [s, setS] = useState<AppSettings>(getSettings());
  const [server, setServerState] = useState(getServer());
  const [voice, setVoice] = useState(isVoiceEnabled());
  const [offline, setOffline] = useState<number | null>(null);
  const [ridden, setRidden] = useState(riddenCells().size);
  const set = (p: Partial<AppSettings>) => {
    updateSettings(p);
    setS(getSettings());
  };

  const [micTest, setMicTest] = useState(false);

  useEffect(() => {
    offlineCacheSize().then((x) => setOffline(x.tiles));
  }, []);

  return (
    <div className="settings">
      {micTest && <MicTest onClose={() => setMicTest(false)} />}
      <section className="field">
        <h3>Helm-headset</h3>
        <button className="secondary" onClick={() => setMicTest(true)}>
          🎙️ Helm-microfoon testen
        </button>
        <p className="hint">Test of de microfoon van je helm-headset werkt via de app. Dit is de voorbereiding op praten met je maten tijdens een groepsrit.</p>
      </section>

      <section className="field">
        <h3>Kaart</h3>
        <div className="segmented">
          {(
            [
              ['auto', 'Automatisch'],
              ['light', 'Licht'],
              ['dark', 'Donker'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={s.mapStyle === v ? 'on' : ''} onClick={() => set({ mapStyle: v })}>
              {l}
            </button>
          ))}
        </div>
        <p className="hint">Automatisch: donkere kaart na zonsondergang, zodat je 's avonds niet verblind wordt.</p>
      </section>

      <section className="field">
        <h3>Tankbereik</h3>
        <div className="slider">
          <output>{s.fuelRangeKm} km</output>
          <input type="range" min={100} max={500} step={10} value={s.fuelRangeKm} onChange={(e) => set({ fuelRangeKm: +e.target.value })} />
        </div>
        <p className="hint">Hoe ver je met een volle tank komt. Bij langere routes stelt de app tankstops voor.</p>
      </section>

      <section className="field">
        <h3>Navigatie</h3>
        <div className="toggles">
          <Toggle
            label="Stem aan"
            checked={voice}
            onChange={(v) => {
              setVoice(v);
              setVoiceEnabled(v);
            }}
          />
          <Toggle label="Maximumsnelheid tonen" checked={s.showSpeedLimit} onChange={(v) => set({ showSpeedLimit: v })} />
          <Toggle label="Piep bij te hard rijden" checked={s.speedWarning} onChange={(v) => set({ speedWarning: v })} />
          <Toggle label="Ritten opnemen in logboek" checked={s.recordRides} onChange={(v) => set({ recordRides: v })} />
          <Toggle label="Groepsberichten voorlezen" checked={s.groupVoice} onChange={(v) => set({ groupVoice: v })} />
        </div>
        <button
          className="secondary"
          onClick={() => {
            unlockVoice();
            announce('Jan wil tanken.');
          }}
        >
          Test groepsmelding
        </button>
        <button
          className="secondary"
          onClick={() => {
            unlockVoice();
            speak('Over 400 meter, rechts afslaan naar de Amersfoortseweg.', true);
          }}
        >
          Test de stem
        </button>
        <p className="hint">Koppel je telefoon aan je helm-intercom via Bluetooth om de aanwijzingen te horen. Maximumsnelheden komen uit OpenStreetMap en zijn niet overal bekend.</p>
      </section>

      <section className="field">
        <h3>Opslag</h3>
        <div className="storage-row">
          <span>
            Offline kaarten: <b>{offline === null ? '…' : `${offline} bestanden`}</b>
          </span>
          <button
            className="link-btn"
            disabled={!offline}
            onClick={async () => {
              await clearOfflineMaps();
              setOffline(0);
            }}
          >
            Wissen
          </button>
        </div>
        <div className="storage-row">
          <span>
            Gereden wegen onthouden: <b>{ridden ? `${Math.round((ridden * 0.055) / 1)} km` : 'nog niets'}</b>
          </span>
          <button
            className="link-btn"
            disabled={!ridden}
            onClick={() => {
              if (!confirm('Alle gereden wegen vergeten? "Ontdek nieuwe wegen" begint dan opnieuw.')) return;
              clearRidden();
              setRidden(0);
            }}
          >
            Wissen
          </button>
        </div>
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
          Kaart © OpenStreetMap-bijdragers, OpenFreeMap. Routes, hoogtes en maximumsnelheden door Valhalla. Adressen via Photon. Tankstations en cafés via Overpass. Weer via
          Open-Meteo. Controleer onderweg altijd zelf de verkeersborden.
        </p>
      </section>
    </div>
  );
}
