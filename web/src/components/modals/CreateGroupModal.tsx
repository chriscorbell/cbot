import { useCallback, useState } from 'react';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from './Modal';

/** New group chat: a name plus at least two Bots. */
export function CreateGroupModal() {
  const setModal = useStore((s) => s.setModal);
  const allBots = useStore((s) => s.bots);
  const bots = allBots.filter((b) => b.kind !== 'room');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const canCreate = name.trim().length > 0 && picked.length >= 2 && !busy;
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      const { id } = await api.createRoom(name.trim(), picked);
      const { bots: all } = await api.bots();
      const st = useStore.getState();
      st.set({ bots: all });
      st.selectBot(id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="create-modal" label="New group chat">
      <form onSubmit={(e) => { e.preventDefault(); create(); }}>
        <div className="modal__header">
          <div className="modal__title">New group chat</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="create-modal__body is-stretch">
          <input className="text-input create-modal__name" placeholder="Name your group" value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Group name" />
          <div className="field-label">Members <span className="field-label__hint">Pick at least two</span></div>
          <div className="group-pick">
            {bots.map((b) => (
              <button key={b.id} type="button" role="checkbox" aria-checked={picked.includes(b.id)} className={`group-pick__opt${picked.includes(b.id) ? ' is-active' : ''}`} onClick={() => toggle(b.id)}>
                <BotAvatarFor bot={b} size={24} life="lite" />
                <span className="group-pick__name">{b.name}{b.label && <span className="group-pick__label"> {b.label}</span>}</span>
                <span className={`checkbox${picked.includes(b.id) ? ' is-on' : ''}`} aria-hidden>{picked.includes(b.id) && <Icon name="check" size={12} strokeWidth={3} />}</span>
              </button>
            ))}
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create group'}</button>
        </div>
      </form>
    </Modal>
  );
}
