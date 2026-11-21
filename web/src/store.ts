import { create } from 'zustand';
import type { Bot, ComputerState, LiveState, Routine, Row, UpdateState, User } from '@shared/types';
import { api, type RowPatch } from './lib/api';
import { configApi } from './lib/configApi';
import { onSignedOut } from './lib/http';
import { forgetSetupCode, reloadWithSetupCode } from './lib/setupCode';

export type ModalKind = 'create' | 'search' | 'group' | null;

interface Transcript { generation: number; bySeq: Record<number, Row>; loaded: boolean }

interface State {
  user: User | null;
  /** No account exists yet: the sign-in screen shows the first-run form. */
  needsAccount: boolean;
  /** Signed in, but the setup wizard that makes the first bot hasn't finished: it covers the app. */
  needsSetup: boolean;
  authChecked: boolean;

  bots: Bot[];
  live: Record<string, LiveState>;
  selectedBotId: string | null;
  /** The open bot the person marked unread: it is not marked read again until a bot is picked. */
  keptUnread: string | null;
  transcripts: Record<string, Transcript>;
  routines: Record<string, Routine[]>;
  computer: ComputerState | null;
  /** Updating Dispatch (server/src/updates.ts); null when it can't update itself. */
  update: UpdateState | null;
  /** The commit the server named when this page first connected. */
  serverVersion: string | null;
  sseConnected: boolean;

  detailsOpen: boolean;
  /** The rail opened into a full sidebar with names and previews (⌘B). */
  sidebarExpanded: boolean;
  /** Narrow screens: the sidebar slides over the chat as a drawer. */
  drawerOpen: boolean;
  /** Bots whose screen stream failed in this tab, so every status line can say so. */
  screenUnreachable: Record<string, boolean>;
  modal: ModalKind;
  viewerOpen: boolean;
  /** How the large computer view opens, and the mode it is in while open. */
  viewerMode: 'watch' | 'control';

  checkAuth(): Promise<void>;
  /** Settings > General > Reset Dispatch: erase everything, wait for the server to come back empty, and start the page over. */
  resetDispatch(): Promise<void>;
  /** Asks again whether this browser is signed in; only a clear "no" signs it out, never a failed request. */
  recheckAuth(): Promise<void>;
  /** The sign-in screen's form. Throws the server's message when it refuses. */
  signIn(username: string, password: string): Promise<void>;
  /** The first-run form: creates the one account and signs in. Throws the server's message when it refuses. */
  createAccount(username: string, password: string, code: string): Promise<void>;
  /** Ends the session and reloads, so nothing from it stays in memory. */
  signOut(): Promise<void>;
  /** The setup wizard's last step. `greet`: the first bot has a model, so it says hello now. */
  finishSetup(greet: boolean): Promise<void>;
  loadBots(): Promise<void>;
  /** Picking a bot (the rail, Search, a new bot) opens it and marks it read, as an inbox does. */
  selectBot(id: string): void;
  /** "Mark as Unread". On the open bot it stays unread until a bot is picked again, even as messages arrive. */
  markUnread(botId: string): void;
  loadRows(id: string): Promise<void>;
  /** After a reconnect: transcripts may have missed rows, so each one but the open one (refetched at once) is refetched when next opened. */
  markTranscriptsStale(): void;
  loadRoutines(id: string): Promise<void>;
  loadComputer(): Promise<void>;
  loadUpdate(): Promise<void>;
  applyUpdate(update: UpdateState | null): void;
  /** Each connection's `hello`. After an update this page saw start, a new commit means the server restarted on it: the page starts over on its web app. */
  serverHello(version: string | null): void;
  upsertRows(botId: string, generation: number, rows: Row[]): void;
  /** "New chat": the bot's transcript starts over at a new generation. */
  clearTranscript(botId: string, generation: number): void;
  applyLive(state: LiveState): void;
  applyBot(bot: Bot): void;
  /** Refetch a bot's routines if anything shows them. */
  routinesChanged(botId: string): void;
  /** Change a message's reaction here at once, then on the server; the server's `rows` event confirms it. */
  patchRow(botId: string, seq: number, p: RowPatch): Promise<void>;
  setModal(m: ModalKind): void;
  set(p: Partial<State>): void;
}

/** How long a reset waits for the server to come back before saying so. A restart takes seconds. */
const RESET_WAIT_MS = 120_000;
/** Set once a reset is erasing the server (resetDispatch). */
let resetting = false;
/**
 * An update was underway when last heard of. Kept apart from `update`, which the new server's idle
 * state replaces on reconnect, maybe before its `hello` arrives.
 */
let updateSeen = false;

const LS_SELECTED = 'dispatch.selectedBot';
const LS_DETAILS = 'dispatch.detailsOpen';
// The rail is always icons now; this hides it altogether (a new key, so the old "collapsed" setting doesn't hide it).
// A new key: the old one meant the rail was hidden, which no longer exists.
const LS_SIDEBAR = 'dispatch.sidebarExpanded';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };

export const useStore = create<State>((set, get) => ({
  user: null,
  needsAccount: false,
  needsSetup: false,
  authChecked: false,
  bots: [],
  live: {},
  selectedBotId: lsGet(LS_SELECTED),
  keptUnread: null,
  transcripts: {},
  routines: {},
  computer: null,
  update: null,
  serverVersion: null,
  sseConnected: false,
  // Wide screens restore the panel; narrow ones start on the chat, where the panel would cover it.
  detailsOpen: lsGet(LS_DETAILS) !== '0' && (typeof window === 'undefined' || window.innerWidth > 700),
  sidebarExpanded: lsGet(LS_SIDEBAR) === '1',
  drawerOpen: false,
  screenUnreachable: {},
  modal: null,
  viewerOpen: false,
  viewerMode: 'watch',

  async checkAuth() {
    try {
      const { user, needsAccount, needsSetup } = await api.me();
      set({ user, needsAccount, needsSetup, authChecked: true });
    } catch {
      set({ user: null, authChecked: true });
    }
  },

  async recheckAuth() {
    const r = await api.me().catch(() => null);
    if (r && !r.user) set({ user: null, needsAccount: r.needsAccount });
  },

  async signIn(username, password) {
    const { user, needsSetup } = await api.login(username, password);
    // After a session ran out mid-use, what was loaded may be behind; the chat refetches what it shows.
    set({ user, needsAccount: false, needsSetup, transcripts: {}, routines: {} });
  },

  async createAccount(username, password, code) {
    const { user, needsSetup } = await api.setup(username, password, code);
    forgetSetupCode();
    set({ user, needsAccount: false, needsSetup });
  },

  async finishSetup(greet) {
    await api.finishSetup(greet);
    set({ needsSetup: false });
  },

  async resetDispatch() {
    const { setupCode } = await configApi.resetDispatch();
    // Every bot is down; the server now erases its data and restarts (server/src/reset.ts). Until the
    // new one asks for an account, a 401 is part of the reset, not a session running out.
    resetting = true;
    const giveUp = Date.now() + RESET_WAIT_MS;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      const r = await api.me().catch(() => null);
      if (r?.needsAccount) break;
      if (Date.now() > giveUp) { resetting = false; throw new Error('Dispatch hasn’t started again yet. Check that its service is running, then reload this page.'); }
    }
    // A fresh page: nothing loaded for the old bots stays behind. Until it goes, the dialog stays as it is.
    // It opens with the new install's setup code, so the first-run form needs nothing from the machine.
    reloadWithSetupCode(setupCode);
    return new Promise<void>(() => {});
  },

  async signOut() {
    // Reloading after a sign-out the server never got would come back signed in, as if it had worked:
    // a failure goes to the caller instead.
    await api.logout();
    location.reload();
  },

  async loadBots() {
    const { bots, live } = await api.bots();
    const liveMap: Record<string, LiveState> = {};
    for (const l of live) liveMap[l.botId] = l;
    const sel = get().selectedBotId;
    const selectedBotId = sel && bots.some((b) => b.id === sel) ? sel : (bots.find((b) => b.isPrimary) ?? bots[0])?.id ?? null;
    set({ bots, live: liveMap });
    if (selectedBotId !== get().selectedBotId || !get().transcripts[selectedBotId ?? '']) {
      if (selectedBotId) get().selectBot(selectedBotId);
    }
  },

  selectBot(id) {
    set({ selectedBotId: id, drawerOpen: false, keptUnread: null });
    lsSet(LS_SELECTED, id);
    const t = get().transcripts[id];
    if (!t?.loaded) get().loadRows(id).catch(console.error);
    get().loadRoutines(id).catch(console.error);
    const bot = get().bots.find((b) => b.id === id);
    if (bot?.unread) api.markRead(id).catch(() => {});
  },

  async loadRows(id) {
    const { generation, rows } = await api.rows(id);
    const bySeq: Record<number, Row> = {};
    for (const r of rows) bySeq[r.seq] = r;
    // Merge with anything that streamed in while we were fetching; a newer chat that started meanwhile wins.
    const prev = get().transcripts[id];
    if (prev && prev.generation > generation) return;
    if (prev && prev.generation === generation) {
      for (const r of Object.values(prev.bySeq)) if (!bySeq[r.seq] || bySeq[r.seq].updatedSeq < r.updatedSeq) bySeq[r.seq] = r;
    }
    set((s) => ({ transcripts: { ...s.transcripts, [id]: { generation, bySeq, loaded: true } } }));
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('fixtures')) {
      import('./dev/fixtures').then((m) => m.injectFixtures());
    }
  },

  markTranscriptsStale() {
    set((s) => ({ transcripts: Object.fromEntries(Object.entries(s.transcripts).map(([k, t]) => [k, k === s.selectedBotId ? t : { ...t, loaded: false }])) }));
  },

  async loadRoutines(id) {
    const { routines } = await api.routines(id);
    set((s) => ({ routines: { ...s.routines, [id]: routines } }));
  },

  async loadComputer() {
    const { computer } = await api.computer();
    set({ computer });
  },

  async loadUpdate() {
    const { update } = await configApi.update();
    get().applyUpdate(update);
  },

  applyUpdate(update) {
    if (update?.status === 'updating') updateSeen = true;
    else if (update?.status === 'failed') updateSeen = false;
    set({ update });
  },

  serverHello(version) {
    const { serverVersion } = get();
    if (serverVersion && version && version !== serverVersion && updateSeen) {
      window.location.reload();
      return;
    }
    set({ serverVersion: version });
  },

  upsertRows(botId, generation, rows) {
    set((s) => {
      const prev = s.transcripts[botId];
      if (prev && generation < prev.generation) return {};
      const base: Transcript = !prev || generation > prev.generation ? { generation, bySeq: {}, loaded: prev?.loaded ?? false } : prev;
      const bySeq = { ...base.bySeq };
      for (const r of rows) {
        const cur = bySeq[r.seq];
        if (!cur || r.updatedSeq >= cur.updatedSeq) bySeq[r.seq] = r;
      }
      return { transcripts: { ...s.transcripts, [botId]: { ...base, generation, bySeq } } };
    });
  },

  clearTranscript(botId, generation) {
    set((st) => {
      // A late "cleared" must not empty rows already fetched or streamed for that new chat.
      const prev = st.transcripts[botId];
      if (prev && prev.generation >= generation) return {};
      return { transcripts: { ...st.transcripts, [botId]: { generation, bySeq: {}, loaded: true } } };
    });
  },

  applyLive(state) {
    set((st) => ({ live: { ...st.live, [state.botId]: state } }));
  },

  markUnread(botId) {
    set((s) => ({
      bots: s.bots.map((b) => (b.id === botId ? { ...b, unread: Math.max(1, b.unread) } : b)),
      keptUnread: botId === s.selectedBotId ? botId : s.keptUnread,
    }));
    api.markUnread(botId).catch(() => { set({ keptUnread: null }); void get().loadBots().catch(() => {}); });
  },

  applyBot(bot) {
    const s = get();
    // The open bot stays read as messages arrive, unless the person marked it unread while it was open.
    if (bot.id === s.selectedBotId && bot.id !== s.keptUnread && bot.unread > 0 && document.visibilityState === 'visible') api.markRead(bot.id).catch(() => {});
    const exists = s.bots.some((b) => b.id === bot.id);
    set((st) => ({ bots: exists ? st.bots.map((b) => (b.id === bot.id ? bot : b)) : [...st.bots, bot] }));
  },

  async patchRow(botId, seq, p) {
    const before = get().transcripts[botId]?.bySeq[seq];
    if (!before) return api.patchRow(botId, seq, get().transcripts[botId]?.generation, p).then(() => {});
    const body: Record<string, unknown> = { ...before.body };
    for (const [k, v] of Object.entries(p)) { if (v === null) delete body[k]; else if (v !== undefined) body[k] = v; }
    const optimistic = { ...before, body: body as unknown as Row['body'] };
    const put = (row: Row) => set((s) => {
      const t = s.transcripts[botId];
      return t ? { transcripts: { ...s.transcripts, [botId]: { ...t, bySeq: { ...t.bySeq, [seq]: row } } } } : {};
    });
    put(optimistic);
    try {
      await api.patchRow(botId, seq, before.generation, p);
    } catch (e) {
      // Put the old row back if nothing replaced the change meanwhile. If something did (the server,
      // or another change still in flight that was built on this one), only the server knows what
      // the row is now: fetch it again.
      if (get().transcripts[botId]?.bySeq[seq] === optimistic) put(before);
      else void get().loadRows(botId).catch(() => {});
      throw e;
    }
  },

  routinesChanged(botId) {
    const s = get();
    if (s.routines[botId] || botId === s.selectedBotId) s.loadRoutines(botId).catch(console.error);
  },

  setModal(modal) { set({ modal }); },

  set(p) {
    if (p.detailsOpen !== undefined) lsSet(LS_DETAILS, p.detailsOpen ? '1' : '0');
    if (p.sidebarExpanded !== undefined) lsSet(LS_SIDEBAR, p.sidebarExpanded ? '1' : '0');
    set(p);
  },
}));

/** Rows for a bot, ordered by seq. */
export function sortedRows(t: Transcript | undefined): Row[] {
  if (!t) return [];
  return Object.values(t.bySeq).sort((a, b) => a.seq - b.seq);
}

export const displayName = (b: Pick<Bot, 'name' | 'label'>) => (b.label ? `${b.name} · ${b.label}` : b.name);

export function useSelectedBot(): Bot | undefined {
  return useStore((s) => s.bots.find((b) => b.id === s.selectedBotId));
}

// A 401 from any call means the session is gone: back to the sign-in screen, which unmounts the app.
// Asking again also tells it whether the account itself was reset (then it shows the first-run form).
onSignedOut(() => {
  if (resetting) return;
  useStore.setState({ user: null });
  void useStore.getState().recheckAuth();
});

// Dev builds expose the store so states can be staged in the browser while checking the UI.
if (import.meta.env.DEV) (globalThis as { __dispatchStore?: unknown }).__dispatchStore = useStore;
