import { useCallback, useState } from 'react';
import { AVATAR_SHAPES, type AvatarColor, type AvatarShape } from '@shared/types';
import { BotAvatar } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { COLOR_ORDER } from '../../lib/colors';
import { pickOther } from '../../lib/pick';
import { useStore } from '../../store';
import { AvatarPicker } from '../AvatarPicker';
import { Icon } from '../Icon';
import { initials } from '../Sidebar';
import { Modal } from './Modal';

type Step = 'name' | 'bot';

/**
 * A new workspace: its name, then its first bot, which becomes its primary bot. Both are made together
 * at the end, so cancelling makes nothing. The bot says hello in its chat, which opens on the new
 * workspace.
 */
export function CreateWorkspaceModal() {
  const setModal = useStore((s) => s.setModal);
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState('');
  const [botName, setBotName] = useState('');
  const [label, setLabel] = useState('');
  const [shape, setShape] = useState<AvatarShape>(() => pickOther(AVATAR_SHAPES));
  const [color, setColor] = useState<AvatarColor>(() => pickOther(COLOR_ORDER));
  const [preview, setPreview] = useState<{ shape?: AvatarShape; color?: AvatarColor } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const shown = { shape: preview?.shape ?? shape, color: preview?.color ?? color };

  /** Never rejects: a failure shows in `error`. */
  const create = async () => {
    if (busy || !name.trim() || !botName.trim()) return;
    setBusy(true); setError(null);
    try {
      const made = await api.createWorkspace(name.trim(), { name: botName.trim(), avatarShape: shape, avatarColor: color, label: label.trim() });
      const st = useStore.getState();
      st.set({
        workspaces: st.workspaces?.some((w) => w.id === made.workspace.id) ? st.workspaces : [...(st.workspaces ?? []), made.workspace],
        bots: st.bots.some((b) => b.id === made.bot.id) ? st.bots : [...st.bots, made.bot],
      });
      st.selectBot(made.bot.id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="create-modal ws-modal" label="New Workspace">
      {step === 'name' ? (
        <form key="name" className="ws-modal__step" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep('bot'); }}>
          <div className="modal__header">
            <div className="modal__title">New Workspace</div>
            <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
          </div>
          <div className="create-modal__body ws-modal__body">
            <span className="ws-mark ws-modal__mark" key={initials(name)} aria-hidden>{name.trim() ? initials(name) : ''}</span>
            <input
              className="create-modal__name"
              placeholder="Name your workspace"
              autoComplete="off"
              value={name}
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              aria-label="Workspace name"
            />
            <p className="ws-modal__sub">A separate team of bots, with its own board and check-ins. Bots here don’t see the bots in your other workspaces.</p>
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
            <button type="submit" className="btn btn--primary" disabled={!name.trim()}>Next</button>
          </div>
        </form>
      ) : (
        <form key="bot" className="ws-modal__step is-forward" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="modal__header">
            <div className="modal__title">First Bot in {name.trim()}</div>
            <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
          </div>
          <div className="create-modal__body">
            <span className="create-modal__stage">
              <BotAvatar key={`${shown.shape}:${shown.color}`} shape={shown.shape} color={shown.color} size={74} className="create-modal__preview" />
            </span>
            <input
              className="create-modal__name"
              placeholder="Name your Bot"
              autoComplete="off"
              value={botName}
              maxLength={60}
              onChange={(e) => setBotName(e.target.value)}
              autoFocus
              aria-label="Bot name"
            />
            <input
              className="text-input ws-modal__role"
              placeholder="Its role (optional)"
              autoComplete="off"
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
              aria-label="Role"
            />
            <AvatarPicker shape={shape} color={color} onShape={setShape} onColor={setColor} onPreview={setPreview} />
            <p className="ws-modal__sub">It becomes the workspace’s primary bot, your main point of contact there.</p>
            {error && <div className="form-error" role="alert">{error}</div>}
          </div>
          <div className="modal__footer">
            <button type="button" className="btn btn--ghost" onClick={() => { setError(null); setStep('name'); }} disabled={busy}>Back</button>
            <button type="submit" className="btn btn--primary" disabled={!botName.trim() || busy}>{busy ? 'Creating…' : 'Create Workspace'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
