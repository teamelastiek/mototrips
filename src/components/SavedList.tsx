import { curvinessStars } from '../lib/generator';
import { formatDistance, formatDuration } from '../lib/geo';
import type { SavedRoute } from '../lib/storage';
import { IconAB, IconLoop, IconTrash } from './Icons';
import { Stars } from './Planner';

interface Props {
  items: SavedRoute[];
  onOpen: (s: SavedRoute) => void;
  onDelete: (id: string) => void;
  loadingId: string | null;
}

export function SavedList({ items, onOpen, onDelete, loadingId }: Props) {
  if (!items.length) {
    return (
      <div className="empty">
        <p>Nog geen bewaarde routes.</p>
        <p className="hint">Maak een route en tik op “Bewaar” om hem hier terug te vinden.</p>
      </div>
    );
  }
  return (
    <ul className="saved">
      {items.map((s) => (
        <li key={s.id}>
          <button className="saved-main" onClick={() => onOpen(s)} disabled={loadingId === s.id}>
            <span className="saved-icon">{s.mode === 'loop' ? <IconLoop size={18} /> : <IconAB size={18} />}</span>
            <span className="saved-text">
              <strong>{s.name}</strong>
              <span>
                {formatDistance(s.lengthM)} · {formatDuration(s.timeS)} · <Stars n={curvinessStars(s.curvature)} />
              </span>
              <small>{loadingId === s.id ? 'Route laden…' : new Date(s.createdAt).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' })}</small>
            </span>
          </button>
          <button className="icon-btn ghost" title="Verwijderen" onClick={() => confirm(`“${s.name}” verwijderen?`) && onDelete(s.id)}>
            <IconTrash size={18} />
          </button>
        </li>
      ))}
    </ul>
  );
}
