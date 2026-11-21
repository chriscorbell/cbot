import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { ProviderSignIn, SignInResponse } from '@shared/contract';
import { configApi } from '../lib/configApi';
import { ApiError } from '../lib/http';
import { notifyFailure } from '../lib/uiEvents';

/**
 * A subscription sign-in with a code (server/src/signin.ts). `start` asks the server for a link and a
 * code; while the user approves on their own device, the hook asks after the sign-in every two seconds
 * and calls `onDone` once it has finished. One that failed leaves `error`. `reset` forgets it here (the
 * panel moved on to another bot, say) but leaves it running on the server, so an approval still lands;
 * `cancel` stops it there too.
 */
export function useCodeSignIn(onDone: (signIn: ProviderSignIn) => void) {
  const [signIn, setSignIn] = useState<ProviderSignIn | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped whenever the sign-in shown is replaced, finished or forgotten: answers about an older one are dropped.
  const epoch = useRef(0);
  const done = useRef(onDone);
  useEffect(() => { done.current = onDone; });
  useEffect(() => () => { epoch.current++; }, []);

  const settle = useCallback((s: ProviderSignIn) => {
    epoch.current++;
    setSignIn(null);
    if (s.status === 'done') done.current(s);
    else if (s.status === 'failed') setError(s.error ?? 'The sign-in didn’t finish. Try again.');
  }, []);

  const start = useCallback(async (request: () => Promise<SignInResponse>) => {
    const mine = ++epoch.current;
    setStarting(true); setError(null); setSignIn(null);
    let s: ProviderSignIn;
    try {
      s = (await request()).signIn;
    } catch (e) {
      if (epoch.current === mine) { setStarting(false); setError((e as Error).message || 'Couldn’t start the sign-in.'); }
      return;
    }
    if (epoch.current !== mine) return;
    setStarting(false);
    if (s.status === 'waiting') setSignIn(s); else settle(s);
  }, [settle]);

  useEffect(() => {
    if (!signIn) return;
    const mine = epoch.current;
    const t = setInterval(() => {
      configApi.signIn(signIn.id).then(({ signIn: s }) => {
        if (epoch.current === mine && s.status !== 'waiting') settle(s);
      }, (e) => {
        // Gone: the server restarted meanwhile. Anything else is retried on the next tick.
        if (epoch.current === mine && e instanceof ApiError && e.status === 404) settle({ ...signIn, status: 'failed', error: 'The sign-in stopped. Start again.' });
      });
    }, 2000);
    return () => clearInterval(t);
  }, [signIn, settle]);

  const reset = useCallback(() => { epoch.current++; setSignIn(null); setStarting(false); setError(null); }, []);
  const cancel = useCallback(() => {
    // The server would otherwise keep waiting on the provider until the code runs out.
    if (signIn) configApi.cancelSignIn(signIn.id).catch(() => notifyFailure('Couldn’t cancel the sign-in. It stops by itself when its code runs out.'));
    reset();
  }, [signIn, reset]);

  return { signIn, starting, error, start, cancel, reset };
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return 'the sign-in page'; } };

/** The link to open and the code to enter there, with a wait that ends by itself. */
export function CodeSignIn({ signIn, onCancel }: { signIn: ProviderSignIn; onCancel: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => { navigator.clipboard.writeText(signIn.code).then(() => setCopied(true), () => {}); };

  return (
    <div className="code-signin">
      <div className="code-signin__row">
        <a className="btn btn--primary btn--sm code-signin__open" href={signIn.url} target="_blank" rel="noopener noreferrer">
          Open {hostOf(signIn.url)}
          <ExternalLink size={13} strokeWidth={2} aria-hidden />
        </a>
        <button type="button" className={`code-signin__code${copied ? ' is-copied' : ''}`} onClick={copy} aria-label={`Copy the code ${signIn.code}`}>
          <span>{signIn.code}</span>
          {copied ? <Check key="check" size={13} strokeWidth={2} aria-hidden /> : <Copy key="copy" size={13} strokeWidth={2} aria-hidden />}
        </button>
      </div>
      <div className="code-signin__wait" role="status">
        <span className="spinner" aria-hidden />
        <span className="code-signin__text">Waiting for you to enter the code there…</span>
        <button type="button" className="link-btn link-btn--small" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
