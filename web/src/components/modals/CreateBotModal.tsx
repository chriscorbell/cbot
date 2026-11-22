import { useCallback, useEffect, useState } from 'react';
import { AVATAR_SHAPES, type AvatarColor, type AvatarShape } from '@shared/types';
import { BotAvatar } from '../../avatar/BotAvatar';
import { api } from '../../lib/api';
import { COLOR_ORDER } from '../../lib/colors';
import { pickOther } from '../../lib/pick';
import { currentWorkspaceId, useStore } from '../../store';
import { AvatarPicker } from '../AvatarPicker';
import { Icon } from '../Icon';
import { Modal } from './Modal';

interface Look { shape: AvatarShape; color: AvatarColor }

/** The look the dialog last opened with, so the next opening starts on a different shape and color. */
let lastLook: Look | undefined;

export function CreateBotModal() {
  const setModal = useStore((s) => s.setModal);
  const [name, setName] = useState('');
  // Picked once per opening. It is recorded in an effect, not here, because StrictMode runs this
  // initialiser twice and the second run must still differ from the previous opening.
  const [start] = useState<Look>(() => ({ shape: pickOther(AVATAR_SHAPES, lastLook?.shape), color: pickOther(COLOR_ORDER, lastLook?.color) }));
  useEffect(() => { lastLook = start; }, [start]);
  const [shape, setShape] = useState<AvatarShape>(start.shape);
  const [color, setColor] = useState<AvatarColor>(start.color);
  const [preview, setPreview] = useState<{ shape?: AvatarShape; color?: AvatarColor } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setModal(null), [setModal]);
  const canCreate = name.trim().length > 0 && !busy;
  const shown = { shape: preview?.shape ?? shape, color: preview?.color ?? color };

  /** Never rejects: a failure shows in `error`. */
  const create = async () => {
    if (!canCreate) return;
    setBusy(true); setError(null);
    try {
      // It joins the workspace shown.
      const workspaceId = currentWorkspaceId(useStore.getState()) ?? undefined;
      const { bot } = await api.createBot({ name: name.trim(), avatarShape: shape, avatarColor: color, workspaceId });
      const st = useStore.getState();
      st.set({ bots: st.bots.some((b) => b.id === bot.id) ? st.bots : [...st.bots, bot] });
      st.selectBot(bot.id);
      close();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal onClose={close} className="create-modal" label="Create New Bot">
      <form onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <div className="modal__header">
          <div className="modal__title">Create New Bot</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="create-modal__body">
          <span className="create-modal__stage">
            <BotAvatar key={`${shown.shape}:${shown.color}`} shape={shown.shape} color={shown.color} size={74} className="create-modal__preview" />
          </span>
          <input
            className="create-modal__name"
            placeholder="Name your Bot"
            // A bot's name, not a person's: no contact AutoFill on phones.
            autoComplete="off"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            aria-label="Name"
          />
          <AvatarPicker shape={shape} color={color} onShape={setShape} onColor={setColor} onPreview={setPreview} />
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!canCreate}>{busy ? 'Creating…' : 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}
