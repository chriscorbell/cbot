import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AVATAR_SHAPES, type AvatarColor, type AvatarShape, type Bot, type EngineInfo, type EngineProvider } from '@shared/types';
import type { SecretId } from '@shared/contract';
import { BotAvatar } from '../avatar/BotAvatar';
import { api } from '../lib/api';
import { configApi, type BotPatch } from '../lib/configApi';
import { COLOR_ORDER } from '../lib/colors';
import { modelForProvider, modelName } from '../lib/models';
import { pickOther } from '../lib/pick';
import { useStore } from '../store';
import { AvatarPicker } from './AvatarPicker';
import { CodeSignIn, useCodeSignIn } from './CodeSignIn';
import { Field } from './config/ui';
import { useExiting } from './Presence';
import { Select } from './Select';

type Step = 'name' | 'about' | 'model';
const STEPS: Step[] = ['name', 'about', 'model'];

type Draft = Pick<Bot, 'name' | 'avatarShape' | 'avatarColor' | 'label' | 'description' | 'instructions'>;
const draftOf = (b: Bot): Draft => ({ name: b.name, avatarShape: b.avatarShape, avatarColor: b.avatarColor, label: b.label, description: b.description, instructions: b.instructions });

const primaryOf = (bots: Bot[]) => bots.find((b) => b.isPrimary && b.kind !== 'room');

/** A capitalised name for the start of a sentence. */
const Cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * After the account is created, before the app: the user makes their first bot (its name and look,
 * its label, About and instructions, the model it thinks with), and it becomes the primary bot. It covers the app, which loads
 * underneath, and fades away into the bot's chat, where the bot says hello.
 *
 * The bot is made when the first step is done, so its computer and agent start while the user writes
 * the rest: connecting a model needs its agent. A bot that is already there (a reload partway through,
 * or an install from before the wizard) is the one the wizard edits, starting from what it has.
 */
export function SetupWizard() {
  const exiting = useExiting();
  const bot = useStore((s) => primaryOf(s.bots));
  const [step, setStep] = useState<Step>('name');
  const [back, setBack] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => ({ name: '', avatarShape: pickOther(AVATAR_SHAPES), avatarColor: pickOther(COLOR_ORDER), label: '', description: '', instructions: '' }));
  const [preview, setPreview] = useState<{ shape?: AvatarShape; color?: AvatarColor } | null>(null);
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);
  const stepRef = useRef<HTMLDivElement>(null);

  // A bot from before (see above) fills in the form, unless the user has started on it.
  const startedFrom = useRef<string | null>(null);
  useEffect(() => {
    if (!bot || startedFrom.current) return;
    startedFrom.current = bot.id;
    if (!touched.current) setDraft(draftOf(bot));
  }, [bot]);

  // Each step starts on its first field.
  useLayoutEffect(() => {
    const el = stepRef.current;
    (el?.querySelector<HTMLElement>('[data-autofocus]') ?? el?.querySelector<HTMLElement>('h1'))?.focus({ preventScroll: true });
  }, [step]);

  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => { touched.current = true; setError(null); setDraft((d) => ({ ...d, [k]: v })); };
  const go = (to: Step) => { setBack(STEPS.indexOf(to) < STEPS.indexOf(step)); setError(null); setStep(to); };

  /** Makes the bot from the draft, or saves the draft's `fields` that changed on the bot there is. */
  const save = async (fields: (keyof Draft)[]) => {
    const st = useStore.getState();
    // The app's first list of bots may still be on its way.
    const current = primaryOf(st.bots) ?? primaryOf((await api.bots()).bots);
    const clean = (k: keyof Draft) => (typeof draft[k] === 'string' ? (draft[k] as string).trim() : draft[k]);
    if (!current) {
      const { bot: made } = await api.createBot({ name: draft.name.trim(), avatarShape: draft.avatarShape, avatarColor: draft.avatarColor, label: draft.label.trim(), description: draft.description.trim(), instructions: draft.instructions.trim() });
      startedFrom.current = made.id;
      useStore.setState((s) => ({ bots: s.bots.some((b) => b.id === made.id) ? s.bots : [...s.bots, made] }));
      useStore.getState().selectBot(made.id);
      return;
    }
    const patch = Object.fromEntries(fields.filter((k) => clean(k) !== current[k]).map((k) => [k, clean(k)])) as BotPatch;
    if (Object.keys(patch).length) {
      const { bot: next } = await configApi.updateBot(current.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
    }
    if (useStore.getState().selectedBotId !== current.id) useStore.getState().selectBot(current.id);
  };

  const next = async (e: FormEvent, fields: (keyof Draft)[], to: Step) => {
    e.preventDefault();
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await save(fields);
      go(to);
    } catch (err) {
      setError((err as Error).message || 'Couldn’t save that. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const name = draft.name.trim();
  const shown = { shape: preview?.shape ?? draft.avatarShape, color: preview?.color ?? draft.avatarColor };
  const at = STEPS.indexOf(step);

  return (
    <div className={`setup${exiting ? ' is-exiting' : ''}`}>
      <div className="setup__card">
        <div className="setup__progress" role="img" aria-label={`Step ${at + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => <span key={s} className={`setup__dot${i < at ? ' is-done' : ''}${i === at ? ' is-current' : ''}`} />)}
        </div>
        <span className={`setup__stage${step === 'name' ? '' : ' is-small'}`}>
          <span className="setup__avatar">
            <BotAvatar
              key={step === 'name' ? `${shown.shape}:${shown.color}` : 'set'}
              shape={shown.shape}
              color={shown.color}
              size={76}
              mood={busy || working ? 'working' : 'idle'}
              seed={bot?.id ?? 'setup'}
              className={step === 'name' ? 'create-modal__preview' : undefined}
            />
          </span>
        </span>

        <div ref={stepRef} key={step} className={`setup__step${back ? ' is-back' : ''}`}>
          {step === 'name' && (
            <form className="setup__form" onSubmit={(e) => void next(e, ['name', 'avatarShape', 'avatarColor'], 'about')}>
              <Head title="Make your first bot" sub="It’s your main point of contact: it checks in with you and coordinates the bots you add later." />
              <input
                className="text-input setup__name"
                placeholder="Name your bot"
                value={draft.name}
                maxLength={60}
                onChange={(e) => put('name', e.target.value)}
                aria-label="Name"
                autoComplete="off"
                spellCheck={false}
                data-autofocus
              />
              <div className="setup__look">
                <AvatarPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} onPreview={setPreview} />
              </div>
              {error && <div className="form-error setup__error" role="alert">{error}</div>}
              <div className="setup__actions">
                <span />
                <button type="submit" className="btn btn--primary setup__next" disabled={!name || busy}>{busy ? 'Saving…' : 'Next'}</button>
              </div>
            </form>
          )}

          {step === 'about' && (
            <form className="setup__form" onSubmit={(e) => void next(e, ['label', 'description', 'instructions'], 'model')}>
              <Head title={`What does ${name} do?`} sub="All three are optional, and you can change them later in its settings." />
              {/* The same fields and hints as Bot settings > General. */}
              <Field label="Label" htmlFor="setup-label" hint="Its role in a word or two, like “Research” or “Inbox”. It’s shown next to the name, and it tells the bots who does what.">
                <input id="setup-label" className="text-input" value={draft.label} maxLength={60} placeholder="e.g. Front Desk" onChange={(e) => put('label', e.target.value)} aria-describedby="setup-label-hint" data-autofocus />
              </Field>
              <Field label="About" htmlFor="setup-about" hint={`What ${name} is for, in a sentence or two: the job it does and what it looks after. ${Cap(name)} reads this as its purpose, and it’s shown when the chat is empty.`}>
                <textarea id="setup-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder="e.g. Keeps an eye on my inbox, sorts what matters and drafts replies for me to send." onChange={(e) => put('description', e.target.value)} aria-describedby="setup-about-hint" />
              </Field>
              <Field label="Instructions" htmlFor="setup-instructions" hint={`Rules ${name} follows in every chat, call and routine: how to write, what matters most, and what to check with you first. Its job goes in About, and step-by-step how-tos go in Skills.`}>
                <textarea id="setup-instructions" className="text-input cfg-textarea setup__instructions" rows={4} value={draft.instructions} maxLength={8000} placeholder="e.g. Keep updates to three bullets. Never email anyone outside the team without asking." onChange={(e) => put('instructions', e.target.value)} aria-describedby="setup-instructions-hint" />
              </Field>
              {error && <div className="form-error setup__error" role="alert">{error}</div>}
              <div className="setup__actions">
                <button type="button" className="btn btn--ghost" onClick={() => go('name')} disabled={busy}>Back</button>
                <button type="submit" className="btn btn--primary setup__next" disabled={busy}>{busy ? 'Saving…' : 'Next'}</button>
              </div>
            </form>
          )}

          {step === 'model' && bot && <ModelStep bot={bot} onBack={() => go('about')} onWorking={setWorking} />}
        </div>
      </div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub: ReactNode }) {
  return (
    <div className="setup__head">
      <h1 className="setup__title" tabIndex={-1}>{title}</h1>
      <p className="setup__sub">{sub}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Where each provider's key or token is kept in Settings > Providers (server/src/settings.ts SECRETS). */
const SECRET_FOR: Record<string, SecretId> = {
  'anthropic-api': 'anthropic-api', 'openai-api': 'openai-api', gemini: 'gemini', xai: 'xai', openrouter: 'openrouter', deepseek: 'deepseek',
  anthropic: 'claude-token', copilot: 'copilot-token', 'self-hosted': 'self-hosted-key',
};
/** Subscriptions that take a token (Claude only takes one; Copilot also signs in with a code), and where the token comes from. */
const TOKEN_HINT: Record<string, ReactNode> = {
  anthropic: <>Run <code className="cfg-code">claude setup-token</code> on a computer with Claude Code and paste what it prints. Every bot you add uses it too.</>,
  copilot: 'A GitHub token with Copilot access.',
};
const GROUP: Record<EngineProvider['kind'], string> = { subscription: 'Subscriptions', api_key: 'API keys', endpoint: 'Your own server' };
const KIND: Record<EngineProvider['kind'], string> = { subscription: 'Subscription', api_key: 'API key', endpoint: 'Endpoint' };

/** How long the bot's agent gets to report a provider connected after a key or a sign-in: time for it to restart. */
const CONNECT_WAIT_MS = 90_000;

type Busy = 'connect' | 'finish' | 'restart';

/**
 * The last step: which provider and model the bot runs on. A key, token or address goes to Settings >
 * Providers, which restarts the agent to read it; Claude takes only its token. ChatGPT, Grok and Copilot
 * sign in with a link and a code, as in the bot's settings (EngineSettings.tsx). Either way the step
 * waits for the agent to report the provider connected. Finishing saves the choice and has the bot say
 * hello; "Set up later" finishes without one.
 */
function ModelStep({ bot, onBack, onWorking }: { bot: Bot; onBack: () => void; onWorking: (working: boolean) => void }) {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  /** The last answer from a running agent: its providers stay on screen while it restarts for a new key. */
  const [ready, setReady] = useState<EngineInfo | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [secret, setSecret] = useState('');
  const [address, setAddress] = useState('');
  const [withToken, setWithToken] = useState(false);
  const [busy, setBusy] = useState<Busy | null>(null);
  /** A provider just given a key or signed in to, until the agent reports it connected. */
  const [waiting, setWaiting] = useState<{ provider: string; since: number; signedIn?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signin = useCodeSignIn((s) => setWaiting({ provider: s.provider, since: Date.now(), signedIn: true }));
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { onWorking(!!busy || !!waiting || signin.starting); }, [busy, waiting, signin.starting, onWorking]);

  const load = useCallback(async () => {
    try {
      const r = await configApi.engine(bot.id);
      if (!mounted.current) return;
      setEngine(r.engine);
      if (r.engine.status === 'ready') setReady(r.engine);
      setUnreachable(false);
    } catch {
      if (mounted.current) setUnreachable(true);
    }
  }, [bot.id]);
  useEffect(() => { void load(); }, [load]);

  // Ask again while the agent starts, and while a new key or sign-in has yet to show.
  const polling = !engine || unreachable || engine.status === 'starting' || !!waiting;
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [polling, load]);

  const providers = ready?.providers ?? [];
  const selected = providers.find((p) => p.id === provider) ?? null;

  // Start on the provider the agent runs on, or else one already connected (a key set before, say).
  const chose = useRef(false);
  useEffect(() => {
    if (chose.current || !ready) return;
    chose.current = true;
    const first = ready.providers.find((p) => p.id === ready.provider && p.connected) ?? ready.providers.find((p) => p.connected);
    if (first) { setProvider(first.id); setModel(modelForProvider(first, ready.model ?? '', ready)); }
  }, [ready]);

  useEffect(() => {
    if (!waiting || !engine) return;
    const p = engine.providers.find((x) => x.id === waiting.provider);
    if (engine.status === 'ready' && p?.connected) {
      setWaiting(null);
      setSecret(''); setAddress(''); setWithToken(false);
      if (p.id === provider) setModel((m) => modelForProvider(p, m, engine));
    } else if (Date.now() - waiting.since > CONNECT_WAIT_MS) {
      setWaiting(null);
      setError(`${bot.name}’s agent still doesn’t show ${p?.name ?? 'that provider'} as connected. ${waiting.signedIn ? 'Try signing in again' : 'Check what you entered'}, or set it up later in Settings > Providers.`);
    }
  }, [engine, waiting, provider, bot.name]);

  const pick = (id: string) => {
    // A sign-in waiting for another provider stops; one for this provider stays on screen.
    if (!signin.signIn) signin.reset(); else if (signin.signIn.provider !== id) signin.cancel();
    setProvider(id);
    setError(null); setSecret(''); setAddress(''); setWithToken(false);
    const p = providers.find((x) => x.id === id);
    if (p && ready) setModel(modelForProvider(p, model, ready));
  };

  const run = async (kind: Busy, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (mounted.current) setError((e as Error).message || 'Something went wrong. Try again.');
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    void run('connect', async () => {
      if (selected.kind === 'endpoint') {
        const r = await configApi.setProviders({ selfHostedUrl: address.trim(), ...(secret.trim() ? { secrets: { 'self-hosted-key': secret.trim() } } : {}) });
        if (r.selfHosted.error) throw new Error(r.selfHosted.error);
      } else {
        const id = SECRET_FOR[selected.id];
        if (!id) throw new Error(`Add ${selected.name} in Settings > Providers, then pick it here.`);
        await configApi.setProviders({ secrets: { [id]: secret.trim() } });
      }
      setWaiting({ provider: selected.id, since: Date.now() });
    });
  };

  /** Gets a link and a code from the provider; the user approves on their own device. */
  const signIn = () => {
    if (!selected || busy || signin.starting) return;
    setError(null);
    const id = selected.id;
    void signin.start(() => configApi.engineLogin(bot.id, id));
  };

  const restart = () => void run('restart', async () => { setEngine((await configApi.restartEngine(bot.id)).engine); });

  const finish = () => {
    if (!selected?.connected) return;
    void run('finish', async () => {
      await configApi.setEngine(bot.id, { provider: selected.id, model: model || null });
      await useStore.getState().finishSetup(true);
    });
  };
  const later = () => void run('finish', () => useStore.getState().finishSetup(false));

  const connected = !!selected?.connected && !waiting;
  const pending = waiting?.provider === provider;
  const models = selected ? (model && !selected.models.includes(model) ? [model, ...selected.models] : selected.models) : [];
  const usesToken = selected?.kind === 'subscription' && !!TOKEN_HINT[selected.id];
  /** The key form: an API key, an address, or a token (Claude's always; Copilot's when asked for). */
  const keyForm = !!selected && (!selected.signIn || withToken);
  const token = !!selected && selected.kind === 'subscription';

  let body: ReactNode = null;
  if (engine?.status === 'error' && !pending) {
    body = (
      <div className="setup__trouble">
        <div className="cfg-error">{engine.error ?? `${bot.name}’s agent didn’t start.`}</div>
        <button type="button" className="btn btn--secondary btn--sm" onClick={restart} disabled={!!busy}>{busy === 'restart' ? 'Restarting…' : 'Try again'}</button>
      </div>
    );
  } else if (!ready) {
    body = <div className="setup__wait"><span className="spinner" aria-hidden />{unreachable ? 'Reconnecting…' : `Starting ${bot.name}’s computer…`}</div>;
  } else {
    body = (
      <div className="panel-card setup__engine">
        <div className="panel-row panel-row--setting engine__row">
          <span className="panel-row__text">
            <span className="panel-row__title">Provider</span>
            {selected && (
              <span className={`engine__conn${connected ? ' is-on' : ''}`} key={`${selected.id}:${connected}`}>
                <i aria-hidden />
                {connected ? 'Connected' : pending ? 'Connecting…' : 'Not connected'} · {KIND[selected.kind]}
              </span>
            )}
          </span>
          <Select
            label="Provider"
            className="engine__select"
            value={provider}
            display={selected?.name ?? 'Choose one'}
            options={providers.map((p) => ({ value: p.id, label: p.name, group: GROUP[p.kind], hint: p.connected ? 'Connected' : undefined }))}
            onChange={pick}
            disabled={!!busy || pending}
          />
        </div>

        {selected && !connected && !pending && (
          <div className="setup__connect" key={selected.id}>
            {!keyForm && (signin.signIn?.provider === selected.id ? (
              <div className="setup__code"><CodeSignIn signIn={signin.signIn} onCancel={signin.cancel} /></div>
            ) : (
              <>
                <button type="button" className="btn btn--secondary setup__wide" onClick={signIn} disabled={!!busy || signin.starting}>
                  {signin.starting ? 'Getting a code…' : `Sign in to ${selected.name}`}
                </button>
                {signin.error && <div className="cfg-error">{signin.error}</div>}
                {usesToken && (
                  <div className="cfg-field__hint">
                    <button type="button" className="setup__link" onClick={() => { signin.reset(); setWithToken(true); }}>Paste a token instead</button>
                  </div>
                )}
              </>
            ))}
            {keyForm && (
              <form className="setup__key" onSubmit={connect}>
                {selected.kind === 'endpoint' && (
                  <input className="text-input" type="url" value={address} onChange={(e) => { setAddress(e.target.value); setError(null); }} placeholder="http://localhost:8000/v1" aria-label="Server address" autoComplete="off" spellCheck={false} autoFocus />
                )}
                <div className="setup__key-row">
                  <input
                    className="text-input"
                    type="password"
                    value={secret}
                    onChange={(e) => { setSecret(e.target.value); setError(null); }}
                    placeholder={selected.kind === 'endpoint' ? 'API key, if it needs one' : token ? `Paste your ${selected.name} token` : `Paste your ${selected.name} key`}
                    aria-label={selected.kind === 'endpoint' ? 'API key' : token ? `${selected.name} token` : `${selected.name} key`}
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus={selected.kind !== 'endpoint'}
                  />
                  <button type="submit" className="btn btn--primary" disabled={!!busy || !(selected.kind === 'endpoint' ? address.trim() : secret.trim())}>{busy === 'connect' ? 'Saving…' : 'Connect'}</button>
                </div>
                <div className="cfg-field__hint">
                  {selected.kind === 'endpoint' ? 'An OpenAI-compatible server, such as vLLM, llama.cpp or Ollama. Its address usually ends in /v1.'
                    : token ? <>{TOKEN_HINT[selected.id]}{selected.signIn && <> <button type="button" className="setup__link" onClick={() => setWithToken(false)}>Sign in instead</button></>}</>
                    : 'Saved in Settings > Providers, where every bot can use it.'}
                </div>
              </form>
            )}
          </div>
        )}

        {pending && <div className="setup__wait setup__wait--inset"><span className="spinner" aria-hidden />{waiting?.signedIn && selected?.id !== 'copilot' ? `Checking ${selected?.name ?? ''}…` : `Restarting ${bot.name}’s agent to use it…`}</div>}

        {connected && (
          <div className="panel-row panel-row--setting engine__row setup__model">
            <span className="panel-row__title">Model</span>
            <Select
              label="Model"
              className="engine__select"
              value={model}
              disabled={!models.length || !!busy}
              display={model ? modelName(model) : 'Default'}
              options={[...(model ? [] : [{ value: '', label: 'Default' }]), ...models.map((m) => ({ value: m, label: modelName(m), title: m }))]}
              onChange={setModel}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="setup__form">
      <Head title={`Connect ${bot.name} to a model`} sub="Pick the provider it thinks with. Keys and tokens are shared with the bots you add later." />
      {body}
      {error && <div className="form-error setup__error" role="alert">{error}</div>}
      <div className="setup__actions">
        <button type="button" className="btn btn--ghost" onClick={onBack} disabled={!!busy}>Back</button>
        <span className="setup__end">
          <button type="button" className="setup__link" onClick={later} disabled={!!busy}>Set up later</button>
          <button type="button" className="btn btn--primary setup__next" onClick={finish} disabled={!connected || !!busy}>{busy === 'finish' ? 'Finishing…' : 'Finish'}</button>
        </span>
      </div>
    </div>
  );
}
