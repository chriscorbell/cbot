import { useState } from 'react';
import { Modal } from './Modal';

/** A short yes/no question in the app's dialog shell. `focusCancel` starts on Cancel, so Enter alone can't confirm something that can't be undone. */
export function ConfirmDialog({ title, body, confirmLabel, busyLabel = 'Working…', danger, focusCancel, onConfirm, onClose }: {
  title: string; body: string; confirmLabel: string; busyLabel?: string; danger?: boolean; focusCancel?: boolean;
  onConfirm: () => Promise<unknown> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
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
        {error && <div className="form-error" role="alert">{error}</div>}
      </div>
      <div className="confirm-modal__actions">
        <button type="button" className="btn btn--ghost" onClick={dismiss} disabled={busy} data-autofocus={focusCancel || undefined}>Cancel</button>
        <button type="button" className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`} onClick={go} disabled={busy} data-autofocus={!focusCancel || undefined}>{busy ? busyLabel : confirmLabel}</button>
      </div>
    </Modal>
  );
}
