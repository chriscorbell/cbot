import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, EngineInfo, EngineProvider } from '@shared/types';
import { configApi } from '../lib/configApi';
import { useStore } from '../store';
import { Icon } from './Icon';
import { Select } from './Select';
import { modelForProvider, modelName } from '../lib/models';
import { guarded, PendingActions } from '../lib/guarded';
import { botSettingsOpenFor, useConfigUI } from '../configStore';
import { CodeSignIn, useCodeSignIn } from './CodeSignIn';

const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key', endpoint: 'Endpoint' };
const STATUS: Record<EngineInfo['status'], string> = { ready: 'Agent ready', starting: 'Agent starting…', error: 'Agent error' };

/** Connected providers first; otherwise the server's order. */
function sortProviders(list: EngineProvider[]): EngineProvider[] {
  return [...list].sort((a, b) => Number(b.connected) - Number(a.connected));
}

type Busy = 'save' | 'restart' | 'screen';

/** How long after a sign-in the agent gets to report the provider connected (Copilot's restarts every agent first). */
const CONFIRM_MS = 90_000;

/**
 * The "Thinking" section of Bot settings > Model & voice: which provider and model run this bot's
 * agent, signing in to a subscription, and the agent's status. Every call fails soft: if the engine
 * endpoints are missing or down, the section says so and the rest of the panel is unaffected.
 */
export function EngineSettings({ bot }: { bot: Bot }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState<Busy | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** A provider just signed in to, until the agent reports it connected. */
  const [confirming, setConfirming] = useState<{ provider: string; name: string; since: number } | null>(null);
  const dirty = useRef(false);
  const botId = bot.id;
  // Requests aren't cancelled: an answer that comes back after the settings closed (even while the
  // dialog is still animating out), or moved on to another bot, must not change what is on screen,
  // and above all must not open a screen.
  const shownBot = useRef(botId);
  shownBot.current = botId;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const stillFor = useCallback((id: string) => mounted.current && shownBot.current === id && botSettingsOpenFor(id), []);
  // Actions still out, per bot: coming back to a bot shows its action busy instead of offering a second one.
  const pending = useRef(new PendingActions<Busy>());

  const apply = useCallback((e: EngineInfo, keepDraft = false) => {
    // An answer (a save, a sign-in, a restart) that comes back after switching bots is about the old one.
    if (!stillFor(e.botId)) return;
    setEngine(e); setPhase('ok');
    if (!keepDraft || !dirty.current) { dirty.current = false; setProvider(e.provider ?? ''); setModel(e.model ?? ''); }
    // Keep the bot's model label in step without waiting for the server's `bot` event.
    useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === e.botId && (b.model !== e.model || b.provider !== e.provider) ? { ...b, model: e.model, provider: e.provider } : b)) }));
  }, [stillFor]);

  /** Quiet refreshes keep what is on screen if the call fails. */
  const load = useCallback((quiet = false) => {
    let alive = true;
    if (!quiet) setPhase('loading');
    void guarded(() => alive && stillFor(botId), () => configApi.engine(botId), {
      done: (r) => { if (r?.engine) apply(r.engine, quiet); else if (!quiet) setPhase('unavailable'); },
      failed: () => { if (!quiet) setPhase('unavailable'); },
    });
    return () => { alive = false; };
  }, [botId, apply, stillFor]);

  // The sign-in shown is this bot's: another bot's panel forgets it here (it keeps running on the server).
  const signin = useCodeSignIn((s) => { setConfirming({ provider: s.provider, name: s.name, since: Date.now() }); load(true); });
  const { reset: resetSignIn } = signin;

  useEffect(() => {
    dirty.current = false; setEngine(null); setNote(null); setConfirming(null); resetSignIn();
    setBusy(pending.current.kindFor(botId));
    return load();
  }, [botId, load, resetSignIn]);

  // The agent takes a moment to come up after a change or a restart.
  const starting = engine?.status === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => load(true), 3000);
    return () => clearInterval(t);
  }, [starting, load]);

  // After a sign-in, ask the agent until it shows the provider connected.
  useEffect(() => {
    if (!confirming) return;
    const t = setInterval(() => {
      if (Date.now() - confirming.since < CONFIRM_MS) { load(true); return; }
      setConfirming(null);
      setNote(`${bot.name}’s agent still doesn’t show ${confirming.name} as connected. Try signing in again.`);
    }, 3000);
    return () => clearInterval(t);
  }, [confirming, load, bot.name]);
  useEffect(() => {
    if (confirming && engine?.status === 'ready' && engine.providers.some((p) => p.id === confirming.provider && p.connected)) setConfirming(null);
  }, [confirming, engine]);

  if (phase !== 'ok' || !engine) {
    return (
      <div className="panel-card">
        <div className="panel-empty engine__empty">
          {phase === 'loading' ? 'Checking…' : (
            <>
              <span>Engine unavailable</span>
              <button type="button" className="link-btn link-btn--small" onClick={() => load()}>Try again</button>
            </>
          )}
        </div>
      </div>
    );
  }

  const providers = sortProviders(engine.providers ?? []);
  const selected = providers.find((p) => p.id === provider) ?? null;
  const suggestions = selected?.models ?? [];
  const wantProvider = provider && provider !== (engine.provider ?? '') ? provider : undefined;
  // An emptied model is a change too: it goes back to the provider's default.
  const changed = !!wantProvider || model.trim() !== (engine.model ?? '');
  const signInTo = selected && selected.signIn && !selected.connected ? selected : null;
  const needsSetup = selected && !selected.signIn && !selected.connected ? selected : null;
  // The provider's models, with the current one first if the provider no longer lists it.
  const models = model && !suggestions.includes(model) ? [model, ...suggestions] : suggestions;

  /** One action at a time: shown as busy, its answer guarded, and its end clearing busy. */
  const run = async <T,>(kind: Busy, request: () => Promise<T>, on: { done?: (value: T) => void; failed?: (e: Error) => void }) => {
    setBusy(kind); setNote(null);
    const action = pending.current.start(botId, kind);
    await guarded(() => stillFor(botId), request, on);
    if (pending.current.end(botId, action) && stillFor(botId)) setBusy(null);
  };

  /**
   * Saves a provider and model as soon as they are picked; a provider that isn't connected waits for its sign-in or key.
   * Never rejects: `run` shows a failure in the panel's note.
   */
  const commit = async (nextProvider: string, nextModel: string, force = false) => {
    const p = providers.find((x) => x.id === nextProvider);
    if (p && !p.connected && !force) return;
    const body = {
      ...(nextProvider && nextProvider !== (engine.provider ?? '') ? { provider: nextProvider } : {}),
      // null clears the saved model, so the provider's own default runs instead of the old provider's model.
      ...(nextModel !== (engine.model ?? '') ? { model: nextModel || null } : {}),
    };
    if (!Object.keys(body).length || busy) return;
    await run('save', () => configApi.setEngine(botId, body), {
      done: (r) => { dirty.current = false; apply(r.engine); },
      failed: (e) => setNote(`Couldn’t save: ${e.message || 'the engine did not answer'}`),
    });
  };

  const pickProvider = (id: string) => {
    // A sign-in waiting for another provider stops; one for this provider stays on screen.
    if (!signin.signIn) signin.reset(); else if (signin.signIn.provider !== id) signin.cancel();
    dirty.current = true; setNote(null); setProvider(id);
    const m = modelForProvider(providers.find((p) => p.id === id), model.trim(), engine);
    setModel(m);
    void commit(id, m);
  };
  const pickModel = (m: string) => { dirty.current = true; setNote(null); setModel(m); void commit(provider, m); };

  const save = () => commit(provider, model.trim(), true);

  /** Gets a link and a code from the provider; the user approves on their own device. */
  const signIn = () => {
    if (!signInTo || signin.starting) return;
    setNote(null);
    const id = signInTo.id;
    void signin.start(() => configApi.engineLogin(botId, id));
  };

  const restart = async () => {
    if (busy) return;
    await run('restart', () => configApi.restartEngine(botId), {
      done: (r) => apply(r.engine, true),
      failed: (e) => setNote(`Couldn’t restart: ${e.message || 'the engine did not answer'}`),
    });
  };

  /** Keys and the self-hosted address live in app Settings, which open in place of this dialog. */
  const openProviders = () => {
    const ui = useConfigUI.getState();
    ui.closeBotSettings();
    ui.openAppSettings('providers');
  };

  const useThisScreen = async () => {
    if (busy) return;
    await run('screen', () => configApi.stopOwnScreen(botId), {
      done: (r) => apply(r.engine, true),
      failed: (e) => setNote(`Couldn’t switch screens: ${e.message || 'the engine did not answer'}`),
    });
  };

  return (
    <div className="panel-card engine">
      <div className="panel-row panel-row--setting engine__row">
        <span className="panel-row__text">
          <span className="panel-row__title">Provider</span>
          {selected && (
            <span className={`engine__conn${selected.connected ? ' is-on' : ''}`}>
              <i aria-hidden />
              {selected.connected ? 'Connected' : 'Not connected'} · {KIND[selected.kind]}
            </span>
          )}
        </span>
        <Select
          label="Provider"
          className="engine__select"
          value={provider}
          options={[
            ...(selected ? [] : [{ value: provider, label: provider || 'Default' }]),
            ...providers.map((p) => ({ value: p.id, label: p.name, hint: p.connected ? undefined : 'Not connected' })),
          ]}
          onChange={pickProvider}
        />
      </div>
      <div className="panel-row panel-row--setting engine__row">
        <span className="panel-row__title">Model</span>
        <Select
          label="Model"
          className="engine__select"
          value={model}
          disabled={!models.length}
          display={model ? modelName(model) : 'Default'}
          options={[
            ...(model ? [] : [{ value: '', label: 'Default' }]),
            ...models.map((m) => ({ value: m, label: modelName(m), title: m })),
          ]}
          onChange={pickModel}
        />
      </div>
      {changed && selected && !selected.connected && (
        <div className="engine__actions">
          <button type="button" className="link-btn" onClick={() => { dirty.current = false; setNote(null); setProvider(engine.provider ?? ''); setModel(engine.model ?? ''); }}>Undo</button>
          <button type="button" className="btn btn--sm btn--primary" onClick={save} disabled={busy === 'save'}>{busy === 'save' ? 'Saving…' : 'Save anyway'}</button>
        </div>
      )}
      {signInTo && !signin.signIn && (
        <button type="button" className="panel-row panel-row--action engine__signin" onClick={signIn} disabled={signin.starting || !!confirming}>
          <Icon name="login" size={14} />
          {signin.starting ? 'Getting a code…' : confirming ? 'Connecting…' : `Sign in to ${signInTo.name}…`}
        </button>
      )}
      {signin.signIn && <div className="engine__code"><CodeSignIn signIn={signin.signIn} onCancel={signin.cancel} /></div>}
      {needsSetup && (
        <div className="engine__notice">
          <span>{needsSetup.kind === 'endpoint' ? 'Add your self-hosted model’s address in Settings.' : needsSetup.kind === 'subscription' ? `Add your ${needsSetup.name} token in Settings.` : `Add an API key for ${needsSetup.name} in Settings.`}</span>
          <button type="button" className="link-btn link-btn--small" onClick={openProviders}>Open Settings</button>
        </div>
      )}
      {engine.ownScreen && (
        <div className="engine__notice">
          <span>{bot.name} also has a private screen of its own switched on. Desktop work it does there (clicking around apps) will not show on the screen here.</span>
          <button type="button" className="link-btn link-btn--small" onClick={useThisScreen} disabled={busy === 'screen'}>{busy === 'screen' ? 'Switching…' : 'Use this screen'}</button>
        </div>
      )}
      {note && <div className="voice-error" role="alert">{note}</div>}
      {signin.error && <div className="voice-error" role="alert">Couldn’t sign in: {signin.error}</div>}
      <div className="engine__meta">
        <span className={`engine__state is-${engine.status}`} title={`Hermes${engine.version ? ` ${engine.version}` : ''} · profile ${engine.profile}`}>
          <i aria-hidden />
          {STATUS[engine.status] ?? engine.status}
        </span>
        {engine.status === 'error' && (
          <button type="button" className="link-btn link-btn--small" onClick={restart} disabled={busy === 'restart'}>{busy === 'restart' ? 'Restarting…' : 'Restart agent'}</button>
        )}
      </div>
      {engine.status === 'error' && engine.error && <div className="engine__error">{engine.error}</div>}
    </div>
  );
}
