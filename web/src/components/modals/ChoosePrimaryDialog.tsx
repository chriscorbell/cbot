import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi } from '../../lib/configApi';
import { currentWorkspaceId, useStore } from '../../store';
import { Modal } from './Modal';

/** Picks which bot of the shown workspace is its primary one: it sits first in the rail, wears the star and is the main point of contact there. */
export function ChoosePrimaryDialog({ onClose }: { onClose: () => void }) {
  const bots = useStore((s) => s.bots);
  const workspaceId = useStore(currentWorkspaceId);
  const [q, setQ] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(() => {
    const n = q.trim().toLowerCase();
    return bots
      .filter((b) => !b.isPrimary && b.kind !== 'room' && b.workspaceId === workspaceId)
      .filter((b) => !n || `${b.name} ${b.label}`.toLowerCase().includes(n))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [bots, q, workspaceId]);
  const confirm = async () => {
    if (!pick) return;
    setBusy(true); setError(null);
    try { await configApi.makePrimary(pick); onClose(); } catch (e) { setError((e as Error).message || 'Couldn’t change the primary Bot'); setBusy(false); }
  };
  return (
    <Modal onClose={onClose} className="pick-modal" label="Choose a primary Bot">
      <div className="pick-modal__title">Choose a primary Bot</div>
      <label className="pick-modal__search">
        <Search size={13} strokeWidth={2} aria-hidden />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search Bots" autoFocus data-autofocus />
      </label>
      <div className="pick-modal__list" role="listbox" aria-label="Bots">
        {options.map((b) => (
          <button key={b.id} type="button" role="option" aria-selected={pick === b.id} className={`pick-modal__opt${pick === b.id ? ' is-on' : ''}`} onClick={() => setPick(b.id)} onDoubleClick={() => { setPick(b.id); }}>
            <BotAvatarFor bot={b} size={16} />
            <span>{b.name}</span>
          </button>
        ))}
        {!options.length && <div className="pick-modal__empty">{q ? 'No Bots match.' : 'Make another Bot first.'}</div>}
      </div>
      {error && <div className="form-error" role="alert" style={{ margin: '0 12px' }}>{error}</div>}
      <div className="pick-modal__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn--primary" onClick={confirm} disabled={!pick || busy}>{busy ? 'Saving…' : 'Confirm'}</button>
      </div>
    </Modal>
  );
}
