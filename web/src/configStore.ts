import { create } from 'zustand';

/** UI state for bot settings, app settings and the theme. Kept apart from store.ts on purpose. */

export type Theme = 'system' | 'light' | 'dark';

/**
 * Where a search result asked to go, waiting for the view that shows it: the chat scrolls to a
 * message, the Library opens the folder that holds a file. That view makes it glow, then clears it.
 */
export type Jump = { kind: 'row'; botId: string; generation: number; seq: number } | { kind: 'file'; botId: string; path: string };
export type BotSettingsTab = 'general' | 'engine' | 'skills' | 'memories' | 'routines';
export type AppSection = 'general' | 'providers' | 'computer' | 'permissions';
/** What the task editor opened on: a task on the board, or a new one (for a bot, or nobody yet). */
export type TaskEditorTarget = { kind: 'edit'; taskId: string } | { kind: 'new'; ownerId: string | null };

interface ConfigUI {
  botSettings: { botId: string; tab: BotSettingsTab } | null;
  appSettings: AppSection | null;
  /** The task editor, opened from a bot's details or the board. */
  taskEditor: TaskEditorTarget | null;
  theme: Theme;
  /** The browser's spell check in the composer. */
  spellcheck: boolean;
  /** ⌘↩ (Ctrl+Enter elsewhere) sends; Enter starts a new line. */
  sendWithMod: boolean;
  /** The microphone for calls and dictation; '' is the system default. */
  micId: string;
  jump: Jump | null;
  jumpTo(j: Jump): void;
  /** Done with this jump; a newer one stays. */
  clearJump(j: Jump): void;
  /** Bumped by server events (memories) so open views refetch. Keys: 'memories:<botId>'. */
  versions: Record<string, number>;
  openBotSettings(botId: string, tab?: BotSettingsTab): void;
  closeBotSettings(): void;
  openAppSettings(section?: AppSection): void;
  closeAppSettings(): void;
  openTaskEditor(t: TaskEditorTarget): void;
  closeTaskEditor(): void;
  setTheme(t: Theme): void;
  setPref(p: Partial<Pick<ConfigUI, 'spellcheck' | 'sendWithMod' | 'micId'>>): void;
  bump(key: string): void;
}

const LS_THEME = 'dispatch.theme';
const readTheme = (): Theme => {
  try { const t = localStorage.getItem(LS_THEME); return t === 'light' || t === 'dark' ? t : 'system'; } catch { return 'system'; }
};

const LS_PREFS = 'dispatch.prefs';
const readPrefs = (): Pick<ConfigUI, 'spellcheck' | 'sendWithMod' | 'micId'> => {
  const d = { spellcheck: true, sendWithMod: false, micId: '' };
  try { return { ...d, ...JSON.parse(localStorage.getItem(LS_PREFS) ?? '{}') }; } catch { return d; }
};

const darkQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function applyTheme(t: Theme) {
  const resolved = t === 'system' ? (darkQuery?.matches ? 'dark' : 'light') : t;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  // Phone browsers tint their toolbars and the status bar with this; index.html picks by the OS's
  // scheme, which is wrong when Dispatch's own setting differs from it.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => { m.content = resolved === 'dark' ? '#111111' : '#FFFFFF'; });
}

export const useConfigUI = create<ConfigUI>((set, get) => ({
  botSettings: null,
  appSettings: null,
  taskEditor: null,
  theme: readTheme(),
  ...readPrefs(),
  versions: {},
  jump: null,
  jumpTo: (jump) => set({ jump }),
  clearJump: (j) => { if (get().jump === j) set({ jump: null }); },
  openBotSettings: (botId, tab = 'general') => set({ botSettings: { botId, tab } }),
  closeBotSettings: () => set({ botSettings: null }),
  openAppSettings: (section = 'general') => set({ appSettings: section }),
  closeAppSettings: () => set({ appSettings: null }),
  openTaskEditor: (taskEditor) => set({ taskEditor }),
  closeTaskEditor: () => set({ taskEditor: null }),
  setTheme: (theme) => {
    try { localStorage.setItem(LS_THEME, theme); } catch { /* ignore */ }
    applyTheme(theme);
    set({ theme });
  },
  setPref: (p) => {
    set(p);
    const { spellcheck, sendWithMod, micId } = get();
    try { localStorage.setItem(LS_PREFS, JSON.stringify({ spellcheck, sendWithMod, micId })); } catch { /* ignore */ }
  },
  bump: (key) => set({ versions: { ...get().versions, [key]: (get().versions[key] ?? 0) + 1 } }),
}));

// Apply the saved theme as early as possible, and follow the OS while on "system".
applyTheme(readTheme());
darkQuery?.addEventListener?.('change', () => { if (useConfigUI.getState().theme === 'system') applyTheme('system'); });

export const useVersion = (key: string) => useConfigUI((s) => s.versions[key] ?? 0);

/** Bot settings are open on this bot. False the moment they close, even while the dialog is still animating out. */
export const botSettingsOpenFor = (botId: string) => useConfigUI.getState().botSettings?.botId === botId;
