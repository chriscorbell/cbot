import { useEffect, useState, type ReactNode } from 'react';
import type { ProvidersResponse, SecretId, SecretState } from '@shared/contract';
import { configApi } from '../../lib/configApi';
import { CodeSignIn, useCodeSignIn } from '../CodeSignIn';
import { useToast } from '../Toast';
import { ConfirmButton, PageHead } from './ui';

const API_KEYS: { id: SecretId; name: string }[] = [
  { id: 'anthropic-api', name: 'Anthropic API' },
  { id: 'openai-api', name: 'OpenAI API' },
  { id: 'gemini', name: 'Google Gemini' },
  { id: 'xai', name: 'xAI' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'deepseek', name: 'DeepSeek' },
];

const TOKENS: { id: SecretId; name: string }[] = [
  { id: 'claude-token', name: 'Claude' },
  { id: 'copilot-token', name: 'GitHub Copilot' },
];

type Patch = Parameters<typeof configApi.setProviders>[0];
/** Saves one change; resolves to an error to show beside it, or null once saved. */
type Save = (patch: Patch) => Promise<string | null>;

const secretStatus = (s: SecretState) => (s.set ? (s.ending ? `Set · ends in ${s.ending}` : 'Set') : 'Not set');

/**
 * Settings > Providers: API keys, subscription tokens, the self-hosted model and SearXNG, for every
 * bot. Which provider a bot runs on is chosen in its own settings. Secrets are only ever sent here,
 * never shown again: a set one reads as "Set" and its last four characters. Copilot's token can also
 * come from signing in to GitHub with a code.
 */
export function ProvidersSection() {
  const [data, setData] = useState<ProvidersResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [toast, flash] = useToast();
  useEffect(() => { configApi.providers().then(setData).catch(() => setFailed(true)); }, []);

  const save: Save = async (patch) => {
    try {
      setData(await configApi.setProviders(patch));
      flash('Saved. Each bot’s agent restarts to use it.');
      return null;
    } catch (e) {
      return (e as Error).message || 'Couldn’t save that.';
    }
  };

  const signedIn = () => {
    configApi.providers().then(setData).catch(() => {});
    flash('Signed in to GitHub. Each bot’s agent restarts to use it.');
  };

  if (!data) {
    return (
      <>
        <PageHead title="Providers" />
        <div className="cfg-empty cfg-empty--flat">{failed ? 'Couldn’t load your providers.' : 'Loading…'}</div>
      </>
    );
  }

  const hosted = data.selfHosted;
  const hostedStatus = !hosted.url ? 'Not set' : hosted.error ?? `${hosted.url} · ${hosted.models.length === 1 ? `1 model: ${hosted.models[0]}` : `${hosted.models.length} models`}`;
  return (
    <>
      <PageHead title="Providers" />
      <section className="cfg-section">
        <div className="cfg-section__label">API keys</div>
        <div className="cfg-card">
          {API_KEYS.map((k) => (
            <EditRow key={k.id} title={k.name} on={data.secrets[k.id].set} status={secretStatus(data.secrets[k.id])} secret noun="key"
              onSave={(v) => save({ secrets: { [k.id]: v } })} />
          ))}
        </div>
        <div className="cfg-field__hint">Any bot can run on a provider whose key is here; choose one in the bot’s settings. DeepSeek also writes each voice call’s summary.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Subscription tokens</div>
        <div className="cfg-card">
          {TOKENS.map((k) => k.id === 'copilot-token' ? (
            <CopilotRow key={k.id} title={k.name} state={data.secrets[k.id]} onSave={(v) => save({ secrets: { [k.id]: v } })} onSignedIn={signedIn} />
          ) : (
            <EditRow key={k.id} title={k.name} on={data.secrets[k.id].set} status={secretStatus(data.secrets[k.id])} secret noun="token"
              onSave={(v) => save({ secrets: { [k.id]: v } })} />
          ))}
        </div>
        <div className="cfg-field__hint">Every bot uses these. Claude runs only on its token: run <code className="cfg-code">claude setup-token</code> on a computer with Claude Code and paste what it prints. For Copilot, sign in to GitHub, or paste a GitHub token with Copilot access.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Self-hosted model</div>
        <div className="cfg-card">
          <EditRow title="Address" on={!!hosted.url && !hosted.error} status={hostedStatus} warn={!!hosted.error} value={hosted.url} noun="address" placeholder="http://localhost:8000/v1"
            onSave={(v) => save({ selfHostedUrl: v })} />
          <EditRow title="API key" on={data.secrets['self-hosted-key'].set} status={data.secrets['self-hosted-key'].set ? secretStatus(data.secrets['self-hosted-key']) : 'None'} secret noun="key"
            onSave={(v) => save({ secrets: { 'self-hosted-key': v } })} />
        </div>
        <div className="cfg-field__hint">An OpenAI-compatible server, such as vLLM, llama.cpp or Ollama. Its address usually ends in /v1.</div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Web search</div>
        <div className="cfg-card">
          <EditRow title="SearXNG" on={!!data.searxngUrl} status={data.searxngUrl || 'Not set'} value={data.searxngUrl} noun="address" placeholder="https://searx.example.com"
            onSave={(v) => save({ searxngUrl: v })} />
        </div>
        <div className="cfg-field__hint">A SearXNG instance with JSON output gives the bots a web search tool. Without one, they search in Chrome.</div>
      </section>
      {toast}
    </>
  );
}

/** Copilot's token: pasted, or signed in to GitHub for with a code (server/src/signin.ts), which saves it here. */
function CopilotRow({ title, state, onSave, onSignedIn }: { title: string; state: SecretState; onSave: (v: string) => Promise<string | null>; onSignedIn: () => void }) {
  const signin = useCodeSignIn(onSignedIn);
  return (
    <EditRow title={title} on={state.set} status={secretStatus(state)} secret noun="token" onSave={onSave}
      actions={!state.set && !signin.signIn && (
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void signin.start(configApi.copilotLogin)} disabled={signin.starting}>
          {signin.starting ? 'Getting a code…' : 'Sign in'}
        </button>
      )}>
      {signin.signIn && <div className="cfg-edit__signin"><CodeSignIn signIn={signin.signIn} onCancel={signin.cancel} /></div>}
      {signin.error && <div className="cfg-error cfg-error--inset cfg-fade" role="alert">{signin.error}</div>}
    </EditRow>
  );
}

/**
 * A setting that opens in place to change: a secret starts empty (it is never sent back), an address
 * starts from its current value. Remove clears it after asking. `actions` go beside Add, and `children` below.
 */
function EditRow({ title, status, on, warn, secret, value = '', noun, placeholder, onSave, actions, children }: {
  title: string; status: string; on: boolean; warn?: boolean; secret?: boolean; value?: string; noun: string; placeholder?: string;
  onSave: (v: string) => Promise<string | null>; actions?: ReactNode; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = secret ? on : !!value;

  const open = () => { setDraft(secret ? '' : value); setError(null); setEditing(true); };
  const close = () => { setEditing(false); setDraft(''); setError(null); };
  const submit = async (v: string) => {
    if (busy) return;
    setBusy(true);
    const err = await onSave(v);
    setBusy(false);
    if (err) setError(err); else close();
  };

  return (
    <div className="cfg-edit">
      <div className="cfg-row">
        <span className={`cfg-dot${on ? ' is-on' : ''}${warn ? ' is-warn' : ''}`} aria-hidden />
        <div className="cfg-row__text">
          <div className="cfg-row__title">{title}</div>
          <div className={`cfg-row__sub cfg-edit__status${warn ? ' is-warn' : ''}`} key={status}>{status}</div>
        </div>
        {!editing && set && (
          <ConfirmButton className="cfg-btn cfg-btn--secondary" confirmLabel={`Remove ${noun}`} onConfirm={async () => { const err = await onSave(''); if (err) setError(err); }}>Remove</ConfirmButton>
        )}
        {!editing && actions}
        {!editing && <button type="button" className="cfg-btn cfg-btn--secondary" onClick={open}>{set ? (secret ? 'Replace' : 'Change') : 'Add'}</button>}
      </div>
      {editing && (
        <form className="cfg-edit__form" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void submit(draft); }}>
          <input
            className="text-input"
            type={secret ? 'password' : 'url'}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
            placeholder={placeholder ?? `Paste the ${noun}`}
            aria-label={`${title} ${noun}`}
            aria-invalid={!!error || undefined}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
          <button type="button" className="cfg-btn cfg-btn--secondary" onClick={close}>Cancel</button>
          <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!draft.trim() || draft.trim() === value || busy}>{busy ? 'Saving…' : 'Save'}</button>
        </form>
      )}
      {error && <div className="cfg-error cfg-error--inset cfg-fade" role="alert">{error}</div>}
      {children}
    </div>
  );
}
