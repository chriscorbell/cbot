import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BookOpen, Brain, Clock, Cpu, SlidersHorizontal } from 'lucide-react';
import { AVATAR_SHAPES, type AvatarColor, type AvatarShape, type Bot, type Memory, type Routine, type Skill } from '@shared/types';
import { BotAvatar, BotAvatarFor } from '../../avatar/BotAvatar';
import { COLOR_ORDER, botVars, palette } from '../../lib/colors';
import { configApi, type BotSettingsBundle } from '../../lib/configApi';
import { useConfigUI, useVersion, type BotSettingsTab } from '../../configStore';
import { useStore } from '../../store';
import { notifyFailure } from '../../lib/uiEvents';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { Presence, useLastValue } from '../Presence';
import { ConfirmDialog } from '../modals/ConfirmDialog';
import { onRovingKeyDown, rovingTab } from '../../lib/roving';
import { EngineSettings } from '../EngineSettings';
import { VoiceSettings } from '../VoiceSettings';
import { Glyph } from './glyphs';
import { ConfirmButton, Field, Segmented, Switch, nextRunLabel } from './ui';

const EFFORTS: { value: Bot['effort']; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];

const EFFORT_HINT: Record<Bot['effort'], string> = {
  low: 'Fastest replies. Good for quick lookups and chit-chat.',
  medium: 'A good balance for most work.',
  high: 'Thinks longer before acting. Better for tricky, multi-step work.',
  xhigh: 'Thinks the longest. Slowest, for the hardest problems.',
};

/**
 * How hard the bot thinks, saved as soon as it is picked like the model and voice beside it. Each turn
 * reads it when it starts, so nothing restarts. The server's `bot` event confirms; a failed save rolls
 * back unless a later pick has replaced it.
 */
function EffortField({ bot }: { bot: Bot }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [bot.id]);
  const pick = async (effort: Bot['effort']) => {
    const prev = bot.effort;
    if (effort === prev) return;
    setError(null);
    const put = (from: Bot['effort'], to: Bot['effort']) =>
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === bot.id && b.effort === from ? { ...b, effort: to } : b)) }));
    put(prev, effort);
    try {
      await configApi.updateBot(bot.id, { effort });
    } catch (e) {
      put(effort, prev);
      setError(`Couldn’t save: ${(e as Error).message}`);
    }
  };
  return (
    <>
      <Field label="Effort" hint={EFFORT_HINT[bot.effort]}>
        <Segmented label="Thinking effort" value={bot.effort} options={EFFORTS} onChange={(v) => void pick(v)} />
      </Field>
      {error && <div className="cfg-error" role="alert">{error}</div>}
    </>
  );
}

export function BotSettingsModal() {
  const target = useLastValue(useConfigUI((s) => s.botSettings));
  const close = useConfigUI((s) => s.closeBotSettings);
  const setTab = (tab: BotSettingsTab) => target && useConfigUI.setState({ botSettings: { ...target, tab } });
  const bot = useStore((s) => s.bots.find((b) => b.id === target?.botId));
  const routines = useStore((s) => (target ? s.routines[target.botId] : undefined));
  const memVersion = useVersion(`memories:${target?.botId ?? ''}`);
  const [data, setData] = useState<BotSettingsBundle | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const onClose = useCallback(() => close(), [close]);

  const reload = useCallback(() => {
    if (!target) return;
    configApi.settings(target.botId).then((d) => { setData(d); setLoadError(null); }).catch((e) => setLoadError(e.message));
  }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reload(); }, [reload, memVersion]);
  useEffect(() => {
    if (target) useStore.getState().loadRoutines(target.botId).catch(() => notifyFailure('Couldn’t load the routines. Reopen settings to try again.'));
  }, [target?.botId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Bot deleted while open (or bad id): close.
  useEffect(() => { if (target && !bot && useStore.getState().bots.length) close(); }, [bot, target, close]);
  if (!target || !bot) return null;

  const ic = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;
  // A group chat has no turns, memory or schedule of its own: its members bring theirs.
  const tabs: { id: BotSettingsTab; label: string; icon: ReactNode; count?: number }[] = [
    { id: 'general', label: 'General', icon: <SlidersHorizontal {...ic} /> },
    ...(bot.kind === 'room' ? [] : [
      { id: 'engine' as const, label: 'Model & voice', icon: <Cpu {...ic} /> },
      { id: 'skills' as const, label: 'Skills', icon: <BookOpen {...ic} />, count: data?.skills.length },
      { id: 'memories' as const, label: 'Memories', icon: <Brain {...ic} />, count: data?.memories.length },
      { id: 'routines' as const, label: 'Routines', icon: <Clock {...ic} />, count: (routines ?? data?.routines)?.length },
    ]),
  ];
  const tab = tabs.some((t) => t.id === target.tab) ? target.tab : 'general';

  return (
    <Modal onClose={onClose} className="bot-settings" label={`${bot.name} settings`}>
      <div className="modal__header">
        <div className="bot-settings__title">
          <BotAvatarFor bot={bot} size={24} life="lite" />
          <span className="modal__title">{bot.name}</span>
        </div>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close"><Icon name="close" size={16} /></button>
      </div>
      <div className="bot-settings__body" style={botVars(bot.avatarColor)}>
        <nav className="cfg-nav" aria-label="Bot settings sections">
          {tabs.map((t) => (
            <button key={t.id} type="button" className={`cfg-nav__item${tab === t.id ? ' is-active' : ''}`} onClick={() => setTab(t.id)} aria-current={tab === t.id || undefined}>
              <span className="cfg-nav__main">{t.icon}{t.label}</span>
              {t.count ? <span className="cfg-nav__count">{t.count}</span> : null}
            </button>
          ))}
        </nav>
        <div className="cfg-content">
          {loadError && <div className="cfg-error">Couldn’t load settings: {loadError}</div>}
          {tab === 'general' && <GeneralTab bot={bot} onClose={onClose} />}
          {tab === 'engine' && (
            <div className="cfg-page">
              <div className="cfg-page__head">
                <div>
                  <div className="cfg-page__title">Model & voice</div>
                  <div className="cfg-page__sub">The model {bot.name} thinks with, and how it sounds on calls.</div>
                </div>
              </div>
              <section className="cfg-section">
                <div className="cfg-section__label">Thinking</div>
                <EngineSettings bot={bot} />
                <EffortField bot={bot} />
              </section>
              <section className="cfg-section">
                <div className="cfg-section__label">On calls</div>
                <VoiceSettings bot={bot} />
              </section>
            </div>
          )}
          {tab === 'skills' && <SkillsTab bot={bot} skills={data?.skills} onChange={reload} />}
          {tab === 'memories' && <MemoriesTab bot={bot} data={data} onChange={reload} />}
          {tab === 'routines' && <RoutinesTab bot={bot} routines={routines ?? data?.routines} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

type Draft = Pick<Bot, 'name' | 'label' | 'description' | 'instructions' | 'avatarShape' | 'avatarColor'>;
const draftOf = (b: Bot): Draft => ({ name: b.name, label: b.label, description: b.description, instructions: b.instructions, avatarShape: b.avatarShape, avatarColor: b.avatarColor });

function GeneralTab({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(bot));
  const [picker, setPicker] = useState(false);
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  useEffect(() => { setDraft(draftOf(bot)); }, [bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = draftOf(bot);
  const changed = (Object.keys(draft) as (keyof Draft)[]).filter((k) => draft[k] !== base[k]);
  const dirty = changed.length > 0;
  const nameOk = draft.name.trim().length > 0;
  // The hints name the bot as it's being typed.
  const it = draft.name.trim() || 'this bot';
  const It = it[0].toUpperCase() + it.slice(1);
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const flash = (text: string, tone: 'ok' | 'error' = 'ok') => { setNote({ text, tone }); setTimeout(() => setNote(null), 2400); };
  const room = bot.kind === 'room';

  const save = async () => {
    if (!dirty || !nameOk) return;
    setSaving(true);
    try {
      const patch: Partial<Draft> = {};
      for (const k of changed) (patch as Record<string, unknown>)[k] = k === 'name' ? draft.name.trim() : draft[k];
      const { bot: next } = await configApi.updateBot(bot.id, patch);
      useStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === next.id ? next : b)) }));
      flash('Saved');
    } catch (e) {
      flash((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">General</div>
          <div className="cfg-page__sub">Name, look and standing instructions.</div>
        </div>
      </div>
      <section className="cfg-section">
        <div className="cfg-look">
          <BotAvatar shape={draft.avatarShape} color={draft.avatarColor} size={72} />
          <div className="cfg-look__text">
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setPicker(!picker)} aria-expanded={picker}>
              {picker ? 'Done' : 'Change look'}
            </button>
          </div>
        </div>
        {picker && <LookPicker shape={draft.avatarShape} color={draft.avatarColor} onShape={(s) => put('avatarShape', s)} onColor={(c) => put('avatarColor', c)} />}
      </section>

      <section className="cfg-section cfg-grid">
        <Field label="Name" htmlFor="cfg-name">
          <input id="cfg-name" className="text-input" autoComplete="off" value={draft.name} maxLength={60} onChange={(e) => put('name', e.target.value)} aria-invalid={!nameOk} />
        </Field>
        {/* What each field is for, as prompt.ts and engine.ts use them: the label and About describe the bot to itself (and the label to the other bots too); Instructions are rules.
            A group's label is only shown; its About and Instructions go to each of its bots under the group's name. */}
        <Field label="Label" htmlFor="cfg-label" hint={room ? 'A word or two shown next to the group’s name.' : 'Its role in a word or two, like “Research” or “Inbox”. It’s shown next to the name, and it tells the bots who does what.'}>
          <input id="cfg-label" className="text-input" autoComplete="off" value={draft.label} maxLength={60} placeholder="Add a label" onChange={(e) => put('label', e.target.value)} aria-describedby="cfg-label-hint" />
        </Field>
      </section>

      <section className="cfg-section">
        <Field label="About" htmlFor="cfg-about" hint={room ? 'What the group is for, in a sentence or two. Its bots read this, and it’s shown when the chat is empty.' : `What ${it} is for, in a sentence or two: the job it does and what it looks after. ${It} reads this as its purpose, and it’s shown when the chat is empty.`}>
          <textarea id="cfg-about" className="text-input cfg-textarea" rows={2} value={draft.description} maxLength={500} placeholder={room ? 'e.g. A morning check-in on what everyone’s working on.' : 'e.g. Keeps an eye on my inbox, sorts what matters and drafts replies for me to send.'} onChange={(e) => put('description', e.target.value)} aria-describedby="cfg-about-hint" />
        </Field>
        <Field label="Instructions" htmlFor="cfg-instructions" hint={room ? 'Rules the bots follow when they post in this group, like who answers first or how long to write. Each bot’s own instructions still apply.' : `Rules ${it} follows in every chat, call and routine: how to write, what matters most, and what to check with you first. Its job goes in About, and step-by-step how-tos go in Skills.`}>
          <textarea id="cfg-instructions" className="text-input cfg-textarea cfg-textarea--tall" rows={7} value={draft.instructions} maxLength={8000} placeholder={room ? 'e.g. One line each. Only answer when you have something new.' : 'e.g. Keep updates to three bullets. Never email anyone outside the team without asking.'} onChange={(e) => put('instructions', e.target.value)} aria-describedby="cfg-instructions-hint" />
        </Field>
      </section>

      <div className={`cfg-savebar${dirty ? ' is-dirty' : ''}`}>
        <span className={`cfg-savebar__note${note?.tone === 'error' ? ' is-error' : ''}`} role="status">{note?.text ?? (dirty ? 'Unsaved changes' : '')}</span>
        <button type="button" className="cfg-btn cfg-btn--secondary" disabled={!dirty || saving} onClick={() => setDraft(draftOf(bot))}>Discard</button>
        <button type="button" className="cfg-btn cfg-btn--primary" disabled={!dirty || saving || !nameOk} onClick={save}>{saving ? 'Saving…' : 'Save changes'}</button>
      </div>

      <section className="cfg-section">
        <div className="cfg-section__label">Conversation</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">New conversation</div>
              <div className="cfg-row__sub">{room ? 'Clears the group chat. The bots’ own chats stay.' : 'Clears the chat. Memories, skills and routines stay.'}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => setConfirmFresh(true)}>Start new</button>
            <Presence show={confirmFresh}>
              <ConfirmDialog
                title="Start a new conversation?"
                body={room ? `This clears the ${bot.name} group chat. The bots’ own chats stay.` : `This clears the chat with ${bot.name}. Memories, skills and routines stay.`}
                confirmLabel="Start new"
                onConfirm={async () => { await configApi.fresh(bot.id); flash('Started a new conversation'); }}
                onClose={() => setConfirmFresh(false)}
              />
            </Presence>
          </div>
          {!bot.isPrimary && (
            <div className="cfg-row">
              <div className="cfg-row__text">
                <div className="cfg-row__title">Make primary</div>
                <div className="cfg-row__sub">Your go-to bot. It reaches out first and keeps the others on track.</div>
              </div>
              <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => configApi.makePrimary(bot.id).then(() => flash(`${bot.name} is now your primary bot`)).catch((e) => flash(e.message, 'error'))}>Make primary</button>
            </div>
          )}
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Danger zone</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete {bot.name}</div>
              <div className="cfg-row__sub">{bot.isPrimary ? 'Make another bot primary first.' : room ? 'Removes the group and its chat for good. The bots in it stay.' : 'Removes its chat, memories, skills and routines for good.'}</div>
            </div>
            <ConfirmButton
              disabled={bot.isPrimary}
              confirmLabel={`Delete ${bot.name}`}
              onConfirm={async () => {
                try {
                  await configApi.deleteBot(bot.id);
                  onClose();
                  const st = useStore.getState();
                  st.set({ bots: st.bots.filter((b) => b.id !== bot.id) });
                  // The roster is already right here; the server's events correct it if this reload fails.
                  st.loadBots().catch((e) => console.warn('[bots] reloading after a delete failed:', e));
                } catch (e) { flash((e as Error).message, 'error'); }
              }}
            >
              Delete…
            </ConfirmButton>
          </div>
        </div>
      </section>
    </div>
  );
}

const SHAPE_ROWS = [AVATAR_SHAPES.slice(0, 7), AVATAR_SHAPES.slice(7)];

function LookPicker({ shape, color, onShape, onColor }: { shape: AvatarShape; color: AvatarColor; onShape: (s: AvatarShape) => void; onColor: (c: AvatarColor) => void }) {
  return (
    <div className="cfg-picker">
      <div className="shape-grid" role="radiogroup" aria-label="Shape" onKeyDown={onRovingKeyDown}>
        {SHAPE_ROWS.map((row, i) => (
          <div key={i} className="shape-grid__row">
            {row.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={shape === s} tabIndex={rovingTab(shape === s)} aria-label={s} className="shape-cell" onClick={() => onShape(s)}>
                <BotAvatar shape={s} color={shape === s ? color : 'gray'} size={32} life="lite" seed={`pick:${s}`} />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="swatches" role="radiogroup" aria-label="Color" onKeyDown={onRovingKeyDown}>
        <div className="swatches__row">
          {COLOR_ORDER.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} tabIndex={rovingTab(color === c)} aria-label={c} className="swatch-cell" onClick={() => onColor(c)}>
              <span className={`swatch${color === c ? ' is-selected' : ''}`} style={{ background: palette(c).fill }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function SkillsTab({ bot, skills, onChange }: { bot: Bot; skills: Skill[] | undefined; onChange: () => void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const remove = async (s: Skill) => {
    setError(null);
    try { await configApi.deleteSkill(s.id); onChange(); } catch (e) { setError(`Couldn’t delete ${s.name}: ${(e as Error).message}`); }
  };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Skills</div>
          <div className="cfg-page__sub">Step-by-step how-tos for specific jobs. {bot.name} reads them all on every turn and uses one when the job fits, or when you ask for it by name.</div>
        </div>
        {editing !== 'new' && <button type="button" className="cfg-btn cfg-btn--primary" onClick={() => setEditing('new')}><Icon name="plus" size={12} /> New skill</button>}
      </div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {editing === 'new' && <SkillEditor botId={bot.id} onDone={() => { setEditing(null); onChange(); }} />}
      {!skills ? <div className="cfg-empty">Loading…</div> : skills.length === 0 && editing !== 'new' ? (
        <div className="cfg-empty">
          No skills yet. Write down how you like something done, like “Prep for a sales call”, and {bot.name} will follow it whenever that job comes up.
        </div>
      ) : (
        <div className="cfg-list">
          {skills.map((s) => editing === s.id ? (
            <SkillEditor key={s.id} botId={bot.id} skill={s} onDone={() => { setEditing(null); onChange(); }} />
          ) : (
            <div key={s.id} className="cfg-item">
              <span className="cfg-item__icon"><Glyph name="spark" size={14} /></span>
              <div className="cfg-item__text">
                <div className="cfg-item__title">{s.name}</div>
                <div className="cfg-item__sub">{s.description || s.body.split('\n')[0]}</div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => setEditing(s.id)} aria-label={`Edit ${s.name}`} title="Edit"><Icon name="edit" size={14} /></button>
                <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={() => remove(s)}><Glyph name="trash" size={14} /></ConfirmButton>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SkillEditor({ botId, skill, onDone }: { botId: string; skill?: Skill; onDone: () => void }) {
  const [name, setName] = useState(skill?.name ?? '');
  const [description, setDescription] = useState(skill?.description ?? '');
  const [body, setBody] = useState(skill?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const can = name.trim() && body.trim() && !busy;
  /** Never rejects: a failure shows in `error`. */
  const save = async () => {
    if (!can) return;
    setBusy(true); setError(null);
    try {
      if (skill) await configApi.updateSkill(skill.id, { name, description, body });
      else await configApi.createSkill(botId, { name, description, body });
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <form className="cfg-editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="text-input" placeholder="Skill name, e.g. Weekly report" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus aria-label="Skill name" />
      <input className="text-input" placeholder="When to use it, e.g. Before any call on my calendar (optional)" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} aria-label="Skill description" />
      <textarea className="text-input cfg-textarea cfg-textarea--tall" rows={8} placeholder={'Write the steps to follow:\n1. …\n2. …'} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Skill steps" />
      {error && <div className="cfg-error">{error}</div>}
      <div className="cfg-editor__actions">
        <button type="button" className="cfg-btn cfg-btn--secondary" onClick={onDone}>Cancel</button>
        <button type="submit" className="cfg-btn cfg-btn--primary" disabled={!can}>{busy ? 'Saving…' : skill ? 'Save skill' : 'Add skill'}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

function MemoriesTab({ bot, data, onChange }: { bot: Bot; data: BotSettingsBundle | null; onChange: () => void }) {
  const [q, setQ] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const memories = useMemo(() => (data?.memories ?? []).filter((m) => !hidden.has(m.id) && (!q || m.text.toLowerCase().includes(q.toLowerCase()))), [data, hidden, q]);
  const remove = async (m: Memory) => {
    setError(null);
    setHidden((h) => new Set(h).add(m.id));
    try {
      await configApi.deleteMemory(m.id);
    } catch (e) {
      setHidden((h) => { const n = new Set(h); n.delete(m.id); return n; });
      setError((e as Error).message);
    }
    onChange();
  };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Memories</div>
          <div className="cfg-page__sub">What {bot.name} knows about you, and notes it keeps for its own work. It saves things as you chat, and every ten or so messages it looks back over the chat for more. Anything you forget here is gone from the next conversation on.</div>
        </div>
      </div>
      {error && <div className="cfg-error" role="alert">{error}</div>}
      {(data?.memories.length ?? 0) > 6 && (
        <input className="text-input" placeholder="Search memories" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
      )}
      {!data ? <div className="cfg-empty">Loading…</div> : memories.length === 0 ? (
        <div className="cfg-empty">{q ? 'No memories match.' : `Nothing yet. Tell ${bot.name} about yourself, or just chat. It’ll pick things up.`}</div>
      ) : (
        <div className="cfg-list">
          {memories.map((m) => (
            <div key={m.id} className="cfg-item">
              <div className="cfg-item__text">
                <div className="cfg-item__body">{m.text}</div>
                <div className="cfg-item__meta">
                  {m.source === 'user' ? <span className="cfg-chip">About you</span> : <span className="cfg-chip cfg-chip--muted">Notes</span>}
                </div>
              </div>
              <div className="cfg-item__actions">
                <button type="button" className="cfg-icon-btn" onClick={() => remove(m)} aria-label="Forget this" title="Forget"><Glyph name="trash" size={14} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

type Say = (text: string, tone?: 'ok' | 'error') => void;

function RoutinesTab({ bot, routines }: { bot: Bot; routines: Routine[] | undefined }) {
  const [flash, setFlash] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const say: Say = (text, tone = 'ok') => { setFlash({ text, tone }); setTimeout(() => setFlash(null), tone === 'error' ? 4000 : 2200); };
  return (
    <div className="cfg-page">
      <div className="cfg-page__head">
        <div>
          <div className="cfg-page__title">Routines</div>
          <div className="cfg-page__sub">Recurring jobs {bot.name} runs on a schedule. To add or change one, ask in chat.</div>
        </div>
        {flash && <span className={`cfg-savebar__note${flash.tone === 'error' ? ' is-error' : ''}`} role="status">{flash.text}</span>}
      </div>
      {!routines ? <div className="cfg-empty">Loading…</div> : routines.length === 0 ? (
        <div className="cfg-empty">No routines yet. Try asking {bot.name}: “every Friday at 4pm, recap my week”.</div>
      ) : (
        <div className="cfg-list">
          {routines.map((r) => <RoutineItem key={r.id} r={r} onFlash={say} />)}
        </div>
      )}
    </div>
  );
}

function RoutineItem({ r, onFlash }: { r: Routine; onFlash: Say }) {
  const [enabled, setEnabled] = useState(r.enabled);
  useEffect(() => setEnabled(r.enabled), [r.enabled]);
  const toggle = async (v: boolean) => {
    setEnabled(v);
    try {
      await configApi.setRoutine(r.id, v);
      onFlash(v ? 'Resumed' : 'Paused');
    } catch (e) {
      setEnabled(!v);
      onFlash(`Couldn’t ${v ? 'resume' : 'pause'} it: ${(e as Error).message}`, 'error');
    }
  };
  return (
    <div className="cfg-item cfg-item--routine">
      <span className="cfg-item__icon"><Icon name="clock" size={14} /></span>
      <div className="cfg-item__text">
        <div className="cfg-item__title">{r.name}</div>
        <div className="cfg-item__sub">{enabled ? [r.description || r.schedule, nextRunLabel(r.nextRunAt, r.timezone)].filter(Boolean).join(' · ') : 'Paused'}</div>
        <div className="cfg-item__prompt">{r.prompt}</div>
      </div>
      <div className="cfg-item__actions">
        <button type="button" className="cfg-icon-btn" title="Run now" aria-label={`Run ${r.name} now`} onClick={() => configApi.runRoutine(r.id).then(() => onFlash('Running now')).catch((e) => onFlash(e.message, 'error'))}>
          <Glyph name="play" size={13} />
        </button>
        <ConfirmButton className="cfg-icon-btn" title="Delete" onConfirm={() => configApi.deleteRoutine(r.id).then(() => onFlash('Deleted'), (e: Error) => onFlash(`Couldn’t delete it: ${e.message}`, 'error'))}><Glyph name="trash" size={14} /></ConfirmButton>
        <Switch on={enabled} onChange={toggle} label={`${r.name} ${enabled ? 'on' : 'paused'}`} />
      </div>
    </div>
  );
}
