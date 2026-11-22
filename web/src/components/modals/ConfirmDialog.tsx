import { useState } from 'react';
import { Modal } from './Modal';

/**
 * A short yes/no question in the app's dialog shell. `focusCancel` starts on Cancel, so Enter alone can't
 * confirm something that can't be undone; `typeToConfirm` asks for that text to be typed first.
 */
export function ConfirmDialog({ title, body, confirmLabel, busyLabel = 'Working…', danger, focusCancel, typeToConfirm, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; busyLabel?: string; danger?: boolean; focusCancel?: boolean; typeToConfirm?: string;
  onConfirm: () => Promise<unknown> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const ready = !typeToConfirm || typed.trim() === typeToConfirm.trim();
  const [error, setError] = useState<string | null>(null);
  // Once the action is under way it can't be called back, so the dialog stays until it ends.
  const dismiss = () => { if (!busy) onClose(); };
  const go = async () => {
    setBusy(true); setError(null);
    try { await onConfirm(); onClose(); } catch (e) { setError((e as Error).message || 'Something went wrong'); setBusy(false); }
  };
  return (
    <Modal onClose={dismiss} className="confirm-modal" label={title}>
      <div className="confirm-modal__body">
        <div className="confirm-modal__title">{title}</div>
        <p className="confirm-modal__text">{body}</p>
        {typeToConfirm && (
          <label className="confirm-modal__type">
            <span>Type <strong>{typeToConfirm}</strong> to confirm</span>
            <input className="text-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-autofocus disabled={busy} />
          </label>
        )}
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="confirm-modal__actions">
        <button type="button" className="btn btn--ghost" onClick={dismiss} disabled={busy} data-autofocus={(focusCancel && !typeToConfirm) || undefined}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={go} disabled={busy || !ready} data-autofocus={(!focusCancel && !typeToConfirm) || undefined}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </Modal>
  );
}
