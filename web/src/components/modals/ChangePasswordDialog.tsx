import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import { MIN_PASSWORD, messageOf, newPasswordProblem, PasswordField } from '../SignIn';
import { Modal } from './Modal';

/** Settings → Account → Change password. The server signs out every other browser; this one stays. */
export function ChangePasswordDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef<HTMLInputElement>(null);
  const ready = !!current && !!next && !!confirm && !busy;

  const save = async () => {
    if (!ready) return;
    const problem = newPasswordProblem(next, confirm);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      onDone();
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setCurrent('');
      setBusy(false);
      currentRef.current?.focus();
    }
  };

  return (
    <Modal onClose={onClose} className="confirm-modal password-modal" label="Change password">
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="confirm-modal__body">
          <div className="confirm-modal__title">Change password</div>
          <p className="confirm-modal__text">Every other browser signed in to Dispatch is signed out.</p>
          <input type="text" name="username" autoComplete="username" hidden readOnly />
          <div className="password-modal__fields">
            <PasswordField id="pw-current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" inputRef={currentRef} invalid={!!error} />
            <PasswordField id="pw-next" label="New password" value={next} onChange={setNext} autoComplete="new-password" hint={`At least ${MIN_PASSWORD} characters`} />
            <PasswordField id="pw-confirm" label="Confirm new password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="confirm-modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!ready}>{busy ? 'Changing…' : 'Change password'}</button>
        </div>
      </form>
    </Modal>
  );
}
