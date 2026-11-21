import { useRef, useState, type Ref } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { BotAvatar } from '../avatar/BotAvatar';
import { ApiError } from '../lib/api';
import { useStore } from '../store';
import { useExiting } from './Presence';

/** The server's rules for a new account (server/src/routes-auth.ts), checked here so its terse 400s never show. */
export const MIN_PASSWORD = 8;
export function newPasswordProblem(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for the password.`;
  if (password !== confirm) return 'The passwords don’t match.';
  return null;
}
function userNameProblem(name: string): string | null {
  if (name.length > 64) return 'Keep the user name under 64 characters.';
  if (/[\s:]/.test(name)) return 'Use a user name without spaces or colons.';
  return null;
}

/** A fetch that never reached the server throws a TypeError, not an ApiError. */
export const messageOf = (e: unknown) => (e instanceof ApiError ? e.message : 'Couldn’t reach Dispatch. Check the connection and try again.');

export function PasswordField({ id, label, value, onChange, autoComplete, inputRef, invalid, describedBy, hint }: {
  id: string; label: string; value: string; onChange: (v: string) => void; autoComplete: string;
  inputRef?: Ref<HTMLInputElement>; invalid?: boolean; describedBy?: string; hint?: string;
}) {
  const [reveal, setReveal] = useState(false);
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="signin__field">
      <label className="signin__label" htmlFor={id}>{label}</label>
      <div className="signin__password">
        <input
          ref={inputRef}
          id={id}
          className="text-input"
          name={id}
          type={reveal ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={[hintId, describedBy].filter(Boolean).join(' ') || undefined}
        />
        <button type="button" className="signin__reveal" onClick={() => setReveal(!reveal)} aria-label={reveal ? 'Hide password' : 'Show password'} aria-pressed={reveal}>
          {reveal ? <EyeOff size={15} strokeWidth={1.75} aria-hidden /> : <Eye size={15} strokeWidth={1.75} aria-hidden />}
        </button>
      </div>
      {hint && <div id={hintId} className="signin__hint">{hint}</div>}
    </div>
  );
}

/**
 * The screen before the app: the first-run form while no account exists, then the sign-in form.
 * It sits over the app and fades out once signed in, so the chat appears underneath it.
 */
export function SignIn() {
  const exiting = useExiting();
  const firstRun = useStore((s) => s.needsAccount);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shaking, setShaking] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const name = username.trim();
  const ready = !!name && !!password && (!firstRun || !!confirm) && !busy;

  const refuse = (message: string) => {
    setError(message);
    setShaking(true);
    passwordRef.current?.focus();
  };

  const submit = async () => {
    if (!ready) return;
    if (firstRun) {
      const problem = userNameProblem(name) ?? newPasswordProblem(password, confirm);
      if (problem) return refuse(problem);
    }
    setBusy(true);
    setError(null);
    try {
      const st = useStore.getState();
      await (firstRun ? st.createAccount(name, password) : st.signIn(name, password));
    } catch (e) {
      // Someone else created the account first, or it was reset meanwhile: switch forms and say why.
      if (e instanceof ApiError && e.status === 409) useStore.setState({ needsAccount: !firstRun });
      setPassword('');
      setConfirm('');
      setBusy(false);
      refuse(messageOf(e));
    }
  };

  return (
    <div className={`signin${exiting ? ' is-exiting' : ''}`}>
      <form
        className={`signin__card${shaking ? ' is-shaking' : ''}`}
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        onAnimationEnd={(e) => { if (e.animationName === 'signin-shake') setShaking(false); }}
        aria-labelledby="signin-title"
      >
        <span className="signin__avatar"><BotAvatar shape="blob" color="black" size={52} mood={busy ? 'working' : 'idle'} seed="dispatch" /></span>
        <div className="signin__head" key={firstRun ? 'setup' : 'signin'}>
          <h1 id="signin-title" className="signin__title">{firstRun ? 'Create your account' : 'Sign in to Dispatch'}</h1>
          {firstRun && <p className="signin__sub">Choose the user name and password you’ll sign in with.</p>}
        </div>
        <div className="signin__field">
          <label className="signin__label" htmlFor="signin-user">User name</label>
          <input
            id="signin-user"
            className="text-input"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </div>
        <PasswordField
          id="signin-password"
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete={firstRun ? 'new-password' : 'current-password'}
          inputRef={passwordRef}
          invalid={!!error}
          describedBy={error ? 'signin-error' : undefined}
          hint={firstRun ? `At least ${MIN_PASSWORD} characters` : undefined}
        />
        {firstRun && (
          <div className="signin__reveal-in">
            <PasswordField id="signin-confirm" label="Confirm password" value={confirm} onChange={setConfirm} autoComplete="new-password" />
          </div>
        )}
        {error && <div id="signin-error" className="form-error signin__error" role="alert">{error}</div>}
        <button type="submit" className="btn btn--primary signin__submit" disabled={!ready}>
          {busy
            ? <><span className="spinner signin__spinner" aria-hidden />{firstRun ? 'Creating account…' : 'Signing in…'}</>
            : firstRun ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
