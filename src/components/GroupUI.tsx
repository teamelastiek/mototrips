import { useState } from 'react';
import { formatDistance } from '../lib/geo';
import { isStale, QUICK, type QuickKind, type Rider } from '../lib/group';
import { IconClose, IconShare } from './Icons';

/** Naam invullen bij starten of meedoen met een groepsrit. */
export function GroupNameDialog({
  mode,
  code,
  initialName,
  onConfirm,
  onCancel,
}: {
  mode: 'start' | 'join';
  code?: string;
  initialName: string;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const ok = name.trim().length >= 2;
  return (
    <div className="modal" role="dialog" aria-modal="true">
      <form
        className="modal-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm(name.trim().slice(0, 24));
        }}
      >
        <header className="modal-head">
          <h2>{mode === 'start' ? 'Samen rijden' : 'Groepsrit'}</h2>
          <button type="button" className="icon-btn ghost" onClick={onCancel} title="Sluiten">
            <IconClose size={20} />
          </button>
        </header>
        {mode === 'join' ? (
          <p>
            Je bent uitgenodigd voor groepsrit <b className="code">{code}</b>. Je ziet elkaar live op de kaart en kunt snelle berichten sturen.
          </p>
        ) : (
          <p>Start een groepsrit met deze route. Je krijgt een link om naar je maten te sturen; samen zien jullie elkaar live op de kaart.</p>
        )}
        <label className="place-label" htmlFor="rider-name">
          Je naam (zien je groepsgenoten)
        </label>
        <input id="rider-name" className="text-input" value={name} autoFocus maxLength={24} placeholder="Bijv. Sebas" onChange={(e) => setName(e.target.value)} />
        <p className="hint">Je locatie wordt alleen gedeeld met wie de link heeft, en alleen zolang je in de groep zit. Er wordt niets opgeslagen.</p>
        <button type="submit" className="primary big" disabled={!ok}>
          {mode === 'start' ? 'Start groepsrit' : 'Meedoen'}
        </button>
      </form>
    </div>
  );
}

export interface RiderInfo {
  rider: Rider;
  /** + = voor je, - = achter je (m), langs de route; null als niet op de route */
  delta: number | null;
  /** hemelsbrede afstand (m) */
  straight: number | null;
}

export function relLabel(i: RiderInfo): string {
  if (isStale(i.rider)) return i.rider.pos ? 'geen signaal' : 'wacht op locatie';
  if (i.delta !== null) {
    if (Math.abs(i.delta) < 150) return 'bij je';
    return i.delta > 0 ? `${formatDistance(i.delta)} voor je` : `${formatDistance(-i.delta)} achter je`;
  }
  return i.straight !== null ? `${formatDistance(i.straight)} verderop` : '';
}

/** Overzicht van de groep: wie rijdt mee, waar, uitnodigen, verlaten. */
export function GroupSheet({
  code,
  me,
  infos,
  status,
  pendingRoute,
  canSendRoute,
  onInvite,
  inviteNotice,
  onSendRoute,
  onLoadRoute,
  onQuick,
  onLeave,
  onClose,
}: {
  code: string;
  me: string;
  infos: RiderInfo[];
  status: 'connecting' | 'connected' | 'error';
  pendingRoute: { from: string } | null;
  canSendRoute: boolean;
  onInvite: () => void;
  inviteNotice: string | null;
  onSendRoute: () => void;
  onLoadRoute: () => void;
  onQuick: (k: QuickKind) => void;
  onLeave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-card group-sheet">
        <header className="modal-head">
          <h2>Groepsrit</h2>
          <button className="icon-btn ghost" onClick={onClose} title="Sluiten">
            <IconClose size={20} />
          </button>
        </header>
        <div className="group-code">
          <span>Code</span>
          <b className="code">{code}</b>
          <span className={`conn ${status}`}>{status === 'connected' ? '● verbonden' : status === 'connecting' ? '● verbinden…' : '● geen verbinding'}</span>
        </div>
        <button className="primary" onClick={onInvite}>
          <IconShare size={18} /> {inviteNotice ?? 'Maten uitnodigen'}
        </button>

        {pendingRoute && (
          <div className="notice info">
            {pendingRoute.from} heeft een nieuwe route gedeeld.{' '}
            <button className="link-btn" onClick={onLoadRoute}>
              Route laden
            </button>
          </div>
        )}

        <ul className="riders">
          <li className="rider me">
            <span className="rider-dot" style={{ background: 'var(--accent)' }} />
            <strong>{me} (jij)</strong>
          </li>
          {infos.map((i) => (
            <li key={i.rider.id} className={`rider ${isStale(i.rider) ? 'stale' : ''}`}>
              <span className="rider-dot" style={{ background: i.rider.color }} />
              <strong>{i.rider.name}</strong>
              <span className="rider-rel">{relLabel(i)}</span>
              {i.rider.pos && !isStale(i.rider) && <span className="rider-speed">{i.rider.pos.speedKmh} km/u</span>}
            </li>
          ))}
          {!infos.length && <li className="hint">Nog niemand anders. Stuur de uitnodiging naar je maten.</li>}
        </ul>

        <div className="quick-row">
          {(Object.keys(QUICK) as QuickKind[]).map((k) => (
            <button key={k} className="quick" onClick={() => onQuick(k)}>
              <span>{QUICK[k].icon}</span>
              {QUICK[k].text}
            </button>
          ))}
        </div>

        <div className="actions-row">
          {canSendRoute && (
            <button className="secondary" onClick={onSendRoute}>
              Huidige route delen
            </button>
          )}
          <button className="secondary danger" onClick={() => confirm('Groepsrit verlaten?') && onLeave()}>
            Groep verlaten
          </button>
        </div>
      </div>
    </div>
  );
}

/** Kleine knop op de kaart zolang je in een groep zit. */
export function GroupChip({ count, status, onClick }: { count: number; status: 'connecting' | 'connected' | 'error'; onClick: () => void }) {
  return (
    <button className={`group-chip ${status}`} onClick={onClick} title="Groepsrit">
      👥 <b>{count + 1}</b> <span>{count + 1 === 1 ? 'rijder' : 'rijders'}</span>
    </button>
  );
}
