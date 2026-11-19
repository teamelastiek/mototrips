import type { Candidate, TargetKind } from '../lib/generator';
import { curvinessStars } from '../lib/generator';
import { formatDistance, formatDuration, type LatLng } from '../lib/geo';
import type { RoutePrefs } from '../lib/valhalla';
import type { ReactNode } from 'react';
import { IconAB, IconBookmark, IconDownload, IconLoop, IconNav, IconRefresh, IconShare, IconSwap, IconUpload, IconOffline } from './Icons';
import { PlaceInput, type NamedPoint } from './PlaceInput';

export interface PlanSettings {
  mode: 'loop' | 'ab';
  start: NamedPoint | null;
  end: NamedPoint | null;
  targetKind: TargetKind;
  distanceKm: number;
  timeMin: number;
  prefs: RoutePrefs;
}

const CURVY = ['Rustig', 'Wat bochten', 'Bochtig', 'Max bochten'];
const CURVY_HINT = [
  'Vlot doorrijden, weinig gekronkel.',
  'Afwisselend, met hier en daar een mooie bocht.',
  'Kies de kronkelige wegen waar het kan.',
  'Zoveel mogelijk bochten, ook al duurt het langer.',
];

interface Props {
  plan: PlanSettings;
  setPlan: (p: PlanSettings) => void;
  near: LatLng | null;
  generating: boolean;
  progress: { done: number; total: number } | null;
  error: string | null;
  candidates: Candidate[];
  selectedId?: string;
  showResults: boolean;
  onGenerate: () => void;
  onBack: () => void;
  onSelect: (id: string) => void;
  onNavigate: () => void;
  onGpx: () => void;
  onSave: () => void;
  savedNotice: boolean;
  details: ReactNode;
  onShare: () => void;
  shareNotice: string | null;
  onOffline: () => void;
  offline: { state: 'idle' | 'loading' | 'done' | 'error'; text?: string };
  onImportGpx: () => void;
  importing: boolean;
  hasRides: boolean;
}

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.value)} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden />
    </label>
  );
}

export function Stars({ n }: { n: number }) {
  return (
    <span className="stars" aria-label={`${n} van 5 bochtsterren`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
    </span>
  );
}

export function Planner(props: Props) {
  const { plan, setPlan } = props;
  const prefs = plan.prefs;
  const setPrefs = (p: Partial<RoutePrefs>) => setPlan({ ...plan, prefs: { ...prefs, ...p } });
  const canGenerate = !!plan.start && (plan.mode === 'loop' || !!plan.end) && !props.generating;

  if (props.showResults && props.candidates.length) {
    const sel = props.candidates.find((c) => c.id === props.selectedId) ?? props.candidates[0];
    return (
      <div className="planner">
        <div className="results-head">
          <button className="link-btn" onClick={props.onBack}>
            ← Instellingen
          </button>
          <button className="link-btn" onClick={props.onGenerate} disabled={props.generating}>
            <IconRefresh size={16} className={props.generating ? 'spin' : ''} /> Nieuwe varianten
          </button>
        </div>
        <ol className="cands">
          {props.candidates.map((c, i) => (
            <li key={c.id}>
              <button className={`cand ${c.id === sel.id ? 'on' : ''}`} onClick={() => props.onSelect(c.id)}>
                <span className="cand-rank">{i + 1}</span>
                <span className="cand-main">
                  <span className="cand-title">{c.label}</span>
                  <span className="cand-stats">
                    <b>{formatDistance(c.route.lengthM)}</b>
                    <b>{formatDuration(c.route.timeS)}</b>
                    <Stars n={curvinessStars(c.stats.curvature)} />
                  </span>
                  <span className="cand-tags">
                    {c.route.hasHighway && <em className="tag warn">snelweg</em>}
                    {c.route.hasToll && <em className="tag warn">tol</em>}
                    {c.route.hasFerry && <em className="tag">pont</em>}
                    {c.stats.overlap > 0.08 && <em className="tag">deels heen en terug</em>}
                    {c.stats.cityShare > 0.08 && <em className="tag warn">{Math.round(c.stats.cityShare * 100)}% door stad</em>}
                    {c.stats.newShare !== null && <em className={`tag ${c.stats.newShare > 0.6 ? 'good' : ''}`}>{Math.round(c.stats.newShare * 100)}% nieuw</em>}
                    {i === 0 && props.candidates.length > 1 && <em className="tag good">beste keus</em>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ol>
        <div className="actions">
          <button className="primary big" onClick={props.onNavigate}>
            <IconNav size={20} /> Start navigatie
          </button>
          <div className="actions-row">
            <button className="secondary" onClick={props.onSave} disabled={props.savedNotice}>
              <IconBookmark size={18} /> {props.savedNotice ? 'Bewaard' : 'Bewaar'}
            </button>
            <button className="secondary" onClick={props.onShare}>
              <IconShare size={18} /> {props.shareNotice ?? 'Deel'}
            </button>
          </div>
          <div className="actions-row">
            <button className="secondary" onClick={props.onGpx}>
              <IconDownload size={18} /> GPX
            </button>
            <button className="secondary" onClick={props.onOffline} disabled={props.offline.state === 'loading' || props.offline.state === 'done'}>
              <IconOffline size={18} />{' '}
              {props.offline.state === 'loading' ? props.offline.text : props.offline.state === 'done' ? 'Offline klaar' : props.offline.state === 'error' ? 'Opnieuw' : 'Offline kaart'}
            </button>
          </div>
          {props.offline.state === 'done' && props.offline.text && <p className="hint">{props.offline.text}</p>}
          {props.offline.state === 'error' && props.offline.text && <p className="field-error">{props.offline.text}</p>}
        </div>
        {props.details}
      </div>
    );
  }

  return (
    <div className="planner">
      <Segmented
        value={plan.mode}
        onChange={(mode) => mode !== plan.mode && setPlan({ ...plan, mode, targetKind: mode === 'loop' ? (plan.targetKind === 'none' ? 'distance' : plan.targetKind) : 'none' })}
        options={[
          { value: 'loop', label: <><IconLoop size={18} /> Rondje</> },
          { value: 'ab', label: <><IconAB size={18} /> Van A naar B</> },
        ]}
      />

      <div className="places">
        <PlaceInput label={plan.mode === 'loop' ? 'Start en finish' : 'Vertrek'} marker="A" value={plan.start} near={props.near} onChange={(start) => setPlan({ ...plan, start })} />
        {plan.mode === 'ab' && (
          <>
            <button
              className="swap"
              title="Omdraaien"
              onClick={() => setPlan({ ...plan, start: plan.end, end: plan.start })}
              disabled={!plan.start && !plan.end}
            >
              <IconSwap size={18} />
            </button>
            <PlaceInput label="Bestemming" marker="B" value={plan.end} near={plan.start ?? props.near} onChange={(end) => setPlan({ ...plan, end })} />
          </>
        )}
      </div>

      <section className="field">
        <div className="field-head">
          <h3>{plan.mode === 'loop' ? 'Hoe lang?' : 'Omrijden?'}</h3>
          <Segmented
            value={plan.targetKind}
            onChange={(targetKind) => setPlan({ ...plan, targetKind })}
            options={[
              ...(plan.mode === 'ab' ? [{ value: 'none' as TargetKind, label: 'Nee' }] : []),
              { value: 'distance' as TargetKind, label: 'Afstand' },
              { value: 'time' as TargetKind, label: 'Tijd' },
            ]}
          />
        </div>
        {plan.targetKind === 'distance' && (
          <div className="slider">
            <output>{plan.distanceKm} km</output>
            <input type="range" min={20} max={500} step={5} value={plan.distanceKm} onChange={(e) => setPlan({ ...plan, distanceKm: +e.target.value })} />
          </div>
        )}
        {plan.targetKind === 'time' && (
          <div className="slider">
            <output>{formatDuration(plan.timeMin * 60)}</output>
            <input type="range" min={30} max={600} step={15} value={plan.timeMin} onChange={(e) => setPlan({ ...plan, timeMin: +e.target.value })} />
          </div>
        )}
        {plan.targetKind === 'none' && <p className="hint">De beste route naar je bestemming, met zoveel bochten als je hieronder kiest.</p>}
      </section>

      <section className="field">
        <h3>Bochten</h3>
        <Segmented value={prefs.curviness} onChange={(curviness) => setPrefs({ curviness })} options={CURVY.map((label, i) => ({ value: i, label }))} />
        <p className="hint">{CURVY_HINT[prefs.curviness]}</p>
      </section>

      <section className="field">
        <h3>Soort wegen</h3>
        <div className="slider dual">
          <input type="range" min={0} max={1} step={0.05} value={prefs.roadType} onChange={(e) => setPrefs({ roadType: +e.target.value })} />
          <div className="slider-labels">
            <span>Binnenweggetjes</span>
            <span>80-wegen</span>
          </div>
        </div>
        <div className="toggles">
          <Toggle label="Snelwegen vermijden" checked={prefs.avoidHighways} onChange={(avoidHighways) => setPrefs({ avoidHighways })} />
          <Toggle label="Tolwegen vermijden" checked={prefs.avoidTolls} onChange={(avoidTolls) => setPrefs({ avoidTolls })} />
          <Toggle label="Veerponten vermijden" checked={prefs.avoidFerries} onChange={(avoidFerries) => setPrefs({ avoidFerries })} />
          <Toggle label="Onverharde wegen toestaan" checked={prefs.allowUnpaved} onChange={(allowUnpaved) => setPrefs({ allowUnpaved })} />
          <Toggle label="Steden en grote dorpen vermijden" checked={prefs.avoidCities} onChange={(avoidCities) => setPrefs({ avoidCities })} />
          <Toggle label="Ontdek nieuwe wegen" checked={prefs.preferNew} onChange={(preferNew) => setPrefs({ preferNew })} />
        </div>
      </section>

      {prefs.preferNew && !props.hasRides && (
        <p className="hint">“Ontdek nieuwe wegen” werkt zodra je ritten hebt gereden met navigatie: de app onthoudt dan welke wegen je al kent.</p>
      )}

      <button className="secondary import-btn" onClick={props.onImportGpx} disabled={props.importing}>
        <IconUpload size={18} /> {props.importing ? 'GPX inlezen…' : 'GPX-bestand openen'}
      </button>

      {props.error && <div className="error">{props.error}</div>}

      <div className="actions sticky">
        <button className="primary big" disabled={!canGenerate} onClick={props.onGenerate}>
          {props.generating ? (
            <>
              <IconRefresh size={18} className="spin" /> Routes zoeken
              {props.progress ? ` ${props.progress.done}/${props.progress.total}` : '…'}
            </>
          ) : !plan.start ? (
            'Kies eerst een startpunt'
          ) : plan.mode === 'ab' && !plan.end ? (
            'Kies een bestemming'
          ) : (
            'Maak mijn route'
          )}
        </button>
      </div>
    </div>
  );
}
