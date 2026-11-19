import { formatDistance, formatDuration } from '../lib/geo';
import type { RideRecord } from '../lib/logbook';
import { IconDownload, IconTrash } from './Icons';

interface Props {
  rides: RideRecord[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onGpx: (r: RideRecord) => void;
  onDelete: (id: string) => void;
}

export function Logbook({ rides, selectedId, onSelect, onGpx, onDelete }: Props) {
  if (!rides.length) {
    return (
      <div className="empty">
        <p>Nog geen ritten in je logboek.</p>
        <p className="hint">Start een navigatie: je rit wordt automatisch opgenomen met afstand, rijtijd, snelheid en hellingshoek.</p>
      </div>
    );
  }
  const totalKm = rides.reduce((s, r) => s + r.distanceM, 0) / 1000;
  const totalS = rides.reduce((s, r) => s + r.movingS, 0);
  const maxLean = Math.max(...rides.map((r) => Math.max(r.maxLeanLeft, r.maxLeanRight)));
  return (
    <div className="logbook">
      <div className="totals">
        <div>
          <b>{Math.round(totalKm).toLocaleString('nl-NL')}</b>
          <span>km totaal</span>
        </div>
        <div>
          <b>{rides.length}</b>
          <span>ritten</span>
        </div>
        <div>
          <b>{formatDuration(totalS)}</b>
          <span>op de motor</span>
        </div>
        <div>
          <b>{maxLean}°</b>
          <span>max helling</span>
        </div>
      </div>
      <ul className="rides">
        {rides.map((r) => {
          const on = r.id === selectedId;
          return (
            <li key={r.id} className={on ? 'on' : ''}>
              <button className="ride-main" onClick={() => onSelect(on ? null : r.id)}>
                <span className="ride-date">
                  {new Date(r.startedAt).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })}
                </span>
                <strong>{r.name}</strong>
                <span className="ride-stats">
                  <b>{formatDistance(r.distanceM)}</b>
                  <b>{formatDuration(r.movingS)}</b>
                  <span>gem. {Math.round(r.avgKmh)} km/u</span>
                </span>
              </button>
              {on && (
                <div className="ride-detail">
                  <div className="ride-grid">
                    <div>
                      <b>{Math.round(r.maxKmh)}</b>
                      <span>max km/u</span>
                    </div>
                    <div>
                      <b>{r.maxLeanLeft}°</b>
                      <span>helling links</span>
                    </div>
                    <div>
                      <b>{r.maxLeanRight}°</b>
                      <span>helling rechts</span>
                    </div>
                    <div>
                      <b>
                        {new Date(r.startedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}–
                        {new Date(r.endedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}
                      </b>
                      <span>tijd</span>
                    </div>
                  </div>
                  <p className="hint">Hellingshoek is geschat uit snelheid en bochtstraal via GPS; reken op een paar graden marge.</p>
                  <div className="actions-row">
                    <button className="secondary" onClick={() => onGpx(r)}>
                      <IconDownload size={18} /> GPX
                    </button>
                    <button className="secondary" onClick={() => confirm('Deze rit verwijderen?') && onDelete(r.id)}>
                      <IconTrash size={18} /> Verwijder
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
