import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Building2, Monitor, Plug, Settings, Shield } from 'lucide-react';
import { Modal } from '../modals/Modal';
import { ChangePasswordDialog } from '../modals/ChangePasswordDialog';
import { ConfirmDialog } from '../modals/ConfirmDialog';
import { Presence, useLastValue } from '../Presence';
import { BotAvatarFor } from '../../avatar/BotAvatar';
import { configApi, type ComputerDetails } from '../../lib/configApi';
import type { PermissionsResponse } from '@shared/contract';
import type { ApprovalMode } from '@shared/types';
import { relativeShort } from '../../lib/time';
import { useConfigUI, type AppSection, type Theme } from '../../configStore';
import { useStore } from '../../store';
import { notifyFailure } from '../../lib/uiEvents';
import { sendTest, turnOff, turnOn, usePush, type PushState } from '../../lib/notifications';
import { computerStatusText } from '../DetailsPanel';
import { Icon } from '../Icon';
import { ConfirmButton, PageHead, Segmented, Switch } from './ui';
import { ProvidersSection } from './ProvidersSection';
import { WorkspaceSection } from './WorkspaceSection';
import { Select } from '../Select';
import { useMics } from '../../voice/mics';
import { initials } from '../Sidebar';

const SECTIONS: { id: AppSection; label: string; icon: ReactNode }[] = [
  { id: 'general', label: 'General', icon: <Settings size={14} strokeWidth={1.75} aria-hidden /> },
  { id: 'workspace', label: 'Workspace', icon: <Building2 size={14} strokeWidth={1.75} aria-hidden /> },
  { id: 'providers', label: 'Providers', icon: <Plug size={14} strokeWidth={1.75} aria-hidden /> },
  { id: 'computer', label: 'Computer', icon: <Monitor size={14} strokeWidth={1.75} aria-hidden /> },
  { id: 'permissions', label: 'Permissions', icon: <Shield size={14} strokeWidth={1.75} aria-hidden /> },
];

/** Settings dialog, opened from the account menu. Same shell as a bot's settings. */
export function AppSettings() {
  const section = useLastValue(useConfigUI((s) => s.appSettings));
  const close = useConfigUI((s) => s.closeAppSettings);
  const open = useConfigUI((s) => s.openAppSettings);
  if (!section) return null;
  return (
    <Modal onClose={close} className="bot-settings app-settings" label="Settings">
      <button type="button" className="modal__close app-settings__close" onClick={close} aria-label="Close settings" title="Close (Esc)"><Icon name="close" size={14} /></button>
      <div className="bot-settings__body">
        <nav className="cfg-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={`cfg-nav__item${section === s.id ? ' is-active' : ''}`} onClick={() => open(s.id)} aria-current={section === s.id || undefined}>
              <span className="cfg-nav__main">{s.icon}{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="cfg-content">
          <div className="cfg-page" key={section}>
            {section === 'general' && <GeneralSection />}
            {section === 'workspace' && <WorkspaceSection />}
            {section === 'providers' && <ProvidersSection />}
            {section === 'computer' && <ComputerSection />}
            {section === 'permissions' && <PermissionsSection />}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

const THEMES: { value: Theme; label: string }[] = [
  { value: 'system', label: 'Follow System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function GeneralSection() {
  const theme = useConfigUI((s) => s.theme);
  const setTheme = useConfigUI((s) => s.setTheme);
  const spellcheck = useConfigUI((s) => s.spellcheck);
  const sendWithMod = useConfigUI((s) => s.sendWithMod);
  const micId = useConfigUI((s) => s.micId);
  const setPref = useConfigUI((s) => s.setPref);
  const user = useStore((s) => s.user);
  const mics = useMics();
  const [ownCertificate, setOwnCertificate] = useState(false);
  useEffect(() => {
    configApi.https().then((r) => setOwnCertificate(r.ownCertificate)).catch(() => notifyFailure('Couldn’t check Dispatch’s certificate, so it isn’t shown here.'));
  }, []);
  const [changing, setChanging] = useState(false);
  const [changed, setChanged] = useState(false);
  useEffect(() => { if (!changed) return; const t = setTimeout(() => setChanged(false), 4000); return () => clearTimeout(t); }, [changed]);
  const letters = initials(user?.username ?? '');
  const send = isMac ? '⌘↩' : 'Ctrl+↩';
  return (
    <>
      <PageHead title="General" />
      <section className="cfg-section">
        <div className="cfg-section__label">Account</div>
        <div className="cfg-card">
          <div className="cfg-row cfg-row--account">
            {user?.avatarUrl ? <img className="account__photo" src={user.avatarUrl} alt="" /> : <span className="account__initials">{letters}</span>}
            <div className="cfg-row__text">
              <div className="cfg-row__title">{user?.username}</div>
            </div>
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Password</div>
              {changed && <div className="cfg-row__sub account__changed" role="status"><Icon name="check" size={12} />Changed. Other browsers are signed out.</div>}
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setChanging(true)}>Change</button>
          </div>
        </div>
        <Presence show={changing}><ChangePasswordDialog onClose={() => setChanging(false)} onDone={() => setChanged(true)} /></Presence>
      </section>
      <section className="cfg-section">
        <div className="cfg-section__label">Appearance</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text"><div className="cfg-row__title">Theme</div></div>
            <Select label="Theme" value={theme} options={THEMES} onChange={setTheme} />
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text"><div className="cfg-row__title">Check Spelling While Typing</div></div>
            <Switch on={spellcheck} onChange={(v) => setPref({ spellcheck: v })} label="Check spelling while typing" />
          </div>
          <div className="cfg-row cfg-row--keyboard">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Send with {send}</div>
              <div className="cfg-row__sub">Press {send} to send your message. Enter starts a new line.</div>
            </div>
            <Switch on={sendWithMod} onChange={(v) => setPref({ sendWithMod: v })} label={`Send with ${send}`} />
          </div>
        </div>
      </section>
      <NotificationsSection />
      <section className="cfg-section">
        <div className="cfg-section__label">System</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text"><div className="cfg-row__title">Microphone</div></div>
            <Select
              label="Microphone"
              value={mics.some((m) => m.id === micId) ? micId : ''}
              options={[{ value: '', label: 'System Default' }, ...mics.map((m) => ({ value: m.id, label: m.label }))]}
              onChange={(v) => setPref({ micId: v })}
            />
          </div>
          {ownCertificate && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">Certificate</div>
                <div className="cfg-row__sub">Dispatch signs its own certificate for HTTPS, so browsers warn that the connection isn’t private. Install and trust it on a device to stop the warning there.</div>
              </div>
              {/* The server sends it as a download; iPhones and iPads offer to install it as a profile. */}
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => location.assign('/api/https/certificate')}>Download</button>
            </div>
          )}
        </div>
      </section>
      <UpdatesSection />
      <ResetSection />
    </>
  );
}

/** What the notifications row says for each state of this device (lib/notifications.ts). */
const PUSH_NOTE: Record<PushState, string> = {
  checking: 'Checking this browser…',
  on: 'When a bot writes, needs your approval or asks you something while its chat isn’t in front of you.',
  off: 'When a bot writes, needs your approval or asks you something while its chat isn’t in front of you.',
  unsupported: 'This browser can’t show notifications from Dispatch.',
  install: 'On an iPhone or iPad, add Dispatch to your Home Screen first (Share › Add to Home Screen), then turn them on there.',
  insecure: 'Notifications need HTTPS. Open Dispatch at its https:// address.',
  untrusted: 'This browser doesn’t trust Dispatch’s certificate, so it won’t run notifications. Install and trust the certificate below, or use the Tailscale address.',
  blocked: 'Notifications are blocked for Dispatch in this browser’s settings. Allow them there, then come back.',
};

/** Settings > General > Notifications: this device's switch and a test. */
function NotificationsSection() {
  const state = usePush((s) => s.state);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!tested) return; const t = setTimeout(() => setTested(false), 4000); return () => clearTimeout(t); }, [tested]);
  const toggle = (on: boolean) => {
    setBusy(true);
    setError(null);
    (on ? turnOn() : turnOff())
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : 'That didn’t work. Try again.'))
      .finally(() => setBusy(false));
  };
  const test = () => {
    setTesting(true);
    setError(null);
    sendTest()
      .then(() => setTested(true))
      .catch((e: unknown) => setError(e instanceof Error && e.message ? e.message : 'The test didn’t go.'))
      .finally(() => setTesting(false));
  };
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Notifications</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Notifications on This Device</div>
            <div className="cfg-row__sub cfg-fade" key={state === 'on' || state === 'off' ? 'switch' : state}>{PUSH_NOTE[state]}</div>
          </div>
          <Switch on={state === 'on'} onChange={toggle} label="Notifications on this device" disabled={busy || (state !== 'on' && state !== 'off')} />
        </div>
        {state === 'on' && (
          <div className="cfg-row cfg-fade">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Test</div>
              {tested && <div className="cfg-row__sub account__changed" role="status"><Icon name="check" size={12} />Sent. It shows in a moment.</div>}
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={test} disabled={testing}>{testing ? 'Sending…' : 'Send a Test'}</button>
          </div>
        )}
        {error && <div className="cfg-error cfg-error--inset" role="alert">{error}</div>}
      </div>
    </section>
  );
}

const ago = (ts: number) => { const r = relativeShort(ts); return r === 'now' ? 'just now' : /^\d/.test(r) ? `${r} ago` : r; };

/** Settings > General > Updates (server/src/updates.ts), on a machine the installer set up. The sidebar's "Update available" opens it. */
function UpdatesSection() {
  const update = useStore((s) => s.update);
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!update) return null;
  const check = () => {
    setChecking(true);
    setError(null);
    configApi.checkUpdate()
      .then((r) => useStore.getState().applyUpdate(r.update))
      .catch((e: Error) => setError(e.message || 'Couldn’t check for updates.'))
      .finally(() => setChecking(false));
  };
  const version = <code className="cfg-code">{update.current}</code>;
  const whatsNew = update.available && (
    <a className="cfg-link" href={update.available.url} target="_blank" rel="noreferrer">What’s new<ArrowUpRight size={12} strokeWidth={2} aria-hidden /></a>
  );
  let title: ReactNode;
  let sub: ReactNode;
  let action: ReactNode = null;
  switch (update.status) {
    case 'updating':
      title = <span className="cfg-update__busy"><span className="spinner" aria-hidden />Updating…</span>;
      sub = `${update.step ?? 'Starting'}. Dispatch restarts when it’s done, and this page reloads.`;
      break;
    case 'failed':
      title = 'The update didn’t finish';
      sub = update.error;
      action = <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setConfirming(true)}>Try Again</button>;
      break;
    case 'idle':
      if (update.available) {
        title = 'Update available';
        sub = <>Version <code className="cfg-code">{update.available.version}</code> is out, and this is {version}. {whatsNew}</>;
        action = <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setConfirming(true)}>Update</button>;
      } else {
        title = 'Dispatch is up to date';
        sub = update.error ?? <>Version {version}{update.checkedAt ? ` · checked ${ago(update.checkedAt)}` : ''}</>;
        action = <button type="button" className="cfg-btn cfg-btn--secondary" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check Now'}</button>;
      }
      break;
    default: {
      const unhandled: never = update;
      return unhandled;
    }
  }
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Updates</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title cfg-fade" key={update.status}>{title}</div>
            <div className="cfg-row__sub cfg-fade" key={`${update.status}:${update.status === 'updating' ? update.step : ''}`}>{sub}</div>
          </div>
          {action}
        </div>
        {error && <div className="cfg-error cfg-error--inset" role="alert">{error}</div>}
      </div>
      <Presence show={confirming}>
        <ConfirmDialog
          title="Update Dispatch?"
          body="Dispatch downloads and builds the new version, then restarts on it. That takes a few minutes, and bots, chats and settings stay as they are."
          confirmLabel="Update"
          busyLabel="Starting…"
          onConfirm={async () => useStore.getState().applyUpdate((await configApi.startUpdate()).update)}
          onClose={() => setConfirming(false)}
        />
      </Presence>
    </section>
  );
}

/** Reset Dispatch (server/src/reset.ts), behind two confirmations: the second can't be reached by Enter alone. */
function ResetSection() {
  const resetDispatch = useStore((s) => s.resetDispatch);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  return (
    <section className="cfg-section">
      <div className="cfg-section__label">Reset</div>
      <div className="cfg-card">
        <div className="cfg-row">
          <div className="cfg-row__text">
            <div className="cfg-row__title">Reset Dispatch</div>
            <div className="cfg-row__sub">Erases every bot, chat and file, your provider keys and your account, so Dispatch starts over as if just installed. Programs the bots installed on the computer stay.</div>
          </div>
          <button type="button" className="cfg-btn cfg-btn--danger" onClick={() => setStep(1)}>Reset</button>
        </div>
      </div>
      <Presence show={step === 1}>
        <ConfirmDialog
          title="Reset Dispatch?"
          body="Every bot is deleted with its chats, memory, routines, files and sign-ins, along with your provider keys, your settings and your account. Dispatch then starts over like a new install."
          confirmLabel="Reset"
          danger
          focusCancel
          onConfirm={() => setStep(2)}
          onClose={() => setStep((s) => (s === 1 ? 0 : s))}
        />
      </Presence>
      <Presence show={step === 2}>
        <ConfirmDialog
          title="Are you absolutely sure?"
          body="This can’t be undone. Everything in Dispatch is erased for good, and you’ll create a new account next."
          confirmLabel="Erase everything"
          busyLabel="Resetting…"
          danger
          focusCancel
          onConfirm={resetDispatch}
          onClose={() => setStep(0)}
        />
      </Presence>
    </section>
  );
}

// ---------------------------------------------------------------------------

const screenLabel = (id: string) => (id === 'default' ? 'Main screen' : `Screen ${Number(id.replace('screen-', '')) - 98 || id}`);

function ComputerSection() {
  const computer = useStore((s) => s.computer);
  const bots = useStore((s) => s.bots);
  const unreachable = useStore((s) => s.screenUnreachable);
  const [details, setDetails] = useState<ComputerDetails | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { configApi.computerDetails().then(setDetails).catch(() => setNote('Couldn’t load the screens’ details.')); }, []);
  useEffect(() => { load(); }, [load, computer?.status, computer?.screens.length]);

  const state = computer ?? details?.computer ?? null;
  const byId = new Map(bots.map((b) => [b.id, b]));

  return (
    <>
      <PageHead title="Computer" />
      <section className="cfg-section">
        <div className="cfg-section__label">Bot’s computer</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <span className={`computer-status-dot is-${state?.status === 'running' ? 'on' : state ? 'off' : 'busy'}`} aria-hidden />
            <div className="cfg-row__text">
              <div className="cfg-row__title">Computer · {computerStatusText(state)}</div>
              <div className="cfg-row__sub">A bot’s screen starts the first time it works or you open it, and stays up until the bot is removed.</div>
            </div>
          </div>
          {state?.status === 'error' && state.error && <div className="cfg-error cfg-error--inset">{state.error}</div>}
          {note && <div className="cfg-error cfg-error--inset">{note}</div>}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Screens in use{details ? ` · ${details.screens.length}` : ''}</div>
        <div className="cfg-card">
          {!details ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : details.screens.length === 0 ? (
            <div className="cfg-empty cfg-empty--flat">No bot has used the computer yet.</div>
          ) : details.screens.map((s) => {
            const bot = byId.get(s.botId);
            return (
              <div key={s.botId} className="cfg-row">
                {bot ? <BotAvatarFor bot={bot} size={28} life="lite" /> : <span className="cfg-row__ph" />}
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{bot?.name ?? 'Removed bot'}</div>
                  <div className="cfg-row__sub">{unreachable[s.botId] && <span className="cfg-row__warn">Not responding · </span>}{screenLabel(s.screenId)} · used {relativeShort(s.lastUsedAt) === 'now' ? 'just now' : `${relativeShort(s.lastUsedAt)}${/^\d/.test(relativeShort(s.lastUsedAt)) ? ' ago' : ''}`}</div>
                </div>
                <ConfirmButton
                  className="cfg-btn cfg-btn--danger"
                  confirmLabel="Reset screen"
                  title="Closes everything open on this screen"
                  onConfirm={async () => { try { await configApi.resetScreen(s.botId); setNote(null); load(); } catch (e) { setNote((e as Error).message); } }}
                >
                  Reset
                </ConfirmButton>
              </div>
            );
          })}
        </div>
        <div className="cfg-field__hint">Reset closes every window on that bot’s screen, so it starts clean next time.</div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------

const MODES: { value: ApprovalMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'smart', label: 'Smart' },
  { value: 'manual', label: 'Ask' },
];

const MODE_SUB: Record<ApprovalMode, string> = {
  off: 'Your Bots never stop to ask. Commands that match Never Allow are still refused.',
  smart: 'Your Bots ask before a risky command or change, unless their model judges it low-risk.',
  manual: 'Your Bots ask before every command or change that is flagged as risky.',
};

/** Hermes names an allowed action by its description ("delete in root path") or a key of its own. */
const ALLOWED_NAMES: Record<string, string> = { ssh_config_write: 'Write to the SSH config' };
const allowedName = (entry: string) => {
  const t = ALLOWED_NAMES[entry] ?? entry.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function PermissionsSection() {
  const [perms, setPerms] = useState<PermissionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pattern, setPattern] = useState('');
  useEffect(() => { configApi.permissions().then(setPerms).catch(() => setError('Couldn’t load your permissions.')); }, []);

  // Shown at once; rolled back if the server refuses and nothing newer replaced it.
  const save = (change: () => Promise<PermissionsResponse>, optimistic: Partial<PermissionsResponse>) => {
    const before = perms;
    const next = before ? { ...before, ...optimistic } : null;
    if (next) setPerms(next);
    setError(null);
    return change().then(setPerms).catch((e: Error) => {
      setPerms((now) => (now === next ? before : now));
      setError(e.message || 'Couldn’t save that.');
    });
  };
  const addPattern = () => {
    const p = pattern.trim();
    if (!p || !perms) return;
    setPattern('');
    void save(() => configApi.setPermissions({ deny: [...perms.deny, p] }), { deny: [...perms.deny, p] });
  };

  const mode = perms?.mode ?? 'off';
  return (
    <>
      <PageHead title="Permissions" />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Approvals</div>
              <div className="cfg-row__sub cfg-fade" key={mode}>{MODE_SUB[mode]}</div>
            </div>
            {perms && <Segmented label="Approvals" value={mode} options={MODES} onChange={(m) => void save(() => configApi.setPermissions({ mode: m }), { mode: m })} />}
          </div>
        </div>
        {error && <div className="cfg-error cfg-error--small" role="alert">{error}</div>}
      </section>
      <section className="cfg-section">
        <div className="cfg-rule-head">
          <div className="cfg-row__title">Allow without Asking</div>
          <div className="cfg-row__sub">Your Bots go ahead when an action matches one of these</div>
        </div>
        {perms === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : perms.allowed.length === 0 ? (
          <div className="cfg-rule-empty">Choose “Always allow” on a request to add one.</div>
        ) : (
          <div className="cfg-card">
            {perms.allowed.map((entry) => (
              <div key={entry} className="cfg-row cfg-fade">
                <div className="cfg-row__text">
                  <div className="cfg-row__title">{allowedName(entry)}</div>
                  {allowedName(entry).toLowerCase() !== entry.toLowerCase() && <div className="cfg-row__sub"><code className="cfg-code">{entry}</code></div>}
                </div>
                <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void save(() => configApi.forgetAllowed(entry), { allowed: perms.allowed.filter((e) => e !== entry) })}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="cfg-section">
        <div className="cfg-rule-head">
          <div className="cfg-row__title">Never Allow</div>
          <div className="cfg-row__sub">Your Bots refuse commands that match these patterns, even with approvals off</div>
        </div>
        {perms === null ? <div className="cfg-empty cfg-empty--flat">Loading…</div> : (
          <>
            {perms.deny.length === 0 ? <div className="cfg-rule-empty">None yet.</div> : (
              <div className="cfg-card">
                {perms.deny.map((p) => (
                  <div key={p} className="cfg-row cfg-fade">
                    <div className="cfg-row__text"><code className="cfg-pattern">{p}</code></div>
                    <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void save(() => configApi.setPermissions({ deny: perms.deny.filter((x) => x !== p) }), { deny: perms.deny.filter((x) => x !== p) })}>Remove</button>
                  </div>
                ))}
              </div>
            )}
            <form className="cfg-rule-add" onSubmit={(e) => { e.preventDefault(); addPattern(); }}>
              <input className="text-input" value={pattern} maxLength={300} onChange={(e) => setPattern(e.target.value)} placeholder="A command pattern, e.g. git push --force*" aria-label="Command pattern to refuse" spellCheck={false} />
              <button type="submit" className="cfg-btn cfg-btn--secondary" disabled={!pattern.trim() || perms.deny.includes(pattern.trim())}>Add</button>
            </form>
          </>
        )}
      </section>
    </>
  );
}
