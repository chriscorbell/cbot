import type { ServerEvent } from '@shared/types';
import { useConfigUI } from '../configStore';
import { useStore } from '../store';
import { notifyFailure } from './uiEvents';

/**
 * Where each server event goes. The switch is exhaustive: a new ServerEvent type in
 * server/src/types.ts does not compile until it is handled here.
 */
export function applyServerEvent(ev: ServerEvent) {
  const s = useStore.getState();
  switch (ev.type) {
    case 'hello': return s.serverHello(ev.version);
    case 'ping':
      return;
    case 'rows': return s.upsertRows(ev.botId, ev.generation, ev.rows);
    case 'cleared': return s.clearTranscript(ev.botId, ev.generation);
    case 'live': return s.applyLive(ev.state);
    case 'roster': return void s.loadBots().catch(console.error);
    case 'bot': return s.applyBot(ev.bot);
    case 'computer': return s.set({ computer: ev.state });
    case 'routines': return s.routinesChanged(ev.botId);
    case 'memories': return useConfigUI.getState().bump(`memories:${ev.botId}`);
    case 'update': return s.applyUpdate(ev.update);
    default: {
      const unhandled: never = ev;
      console.warn('unknown server event', unhandled);
    }
  }
}

/**
 * One EventSource for the whole app. EventSource retries on its own, but a server restart
 * can leave it CLOSED, so we also reconnect manually with backoff and resync on reconnect.
 */
export function startEvents(): () => void {
  let es: EventSource | null = null;
  let stopped = false;
  let retry = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let everConnected = false;

  // Events sent while disconnected are lost: refetch what is on screen, and mark every other
  // transcript stale so it is refetched when opened.
  // If a refetch fails, what is on screen may be out of date until the next reconnect, so say so once.
  const resync = () => {
    const st = useStore.getState();
    st.markTranscriptsStale();
    const loads: Promise<unknown>[] = [st.loadBots(), st.loadComputer(), st.loadUpdate()];
    if (st.selectedBotId) loads.push(st.loadRows(st.selectedBotId), st.loadRoutines(st.selectedBotId));
    void Promise.allSettled(loads).then((results) => {
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (!failed.length) return;
      console.warn('[events] refreshing after the reconnect failed:', failed.map((r) => r.reason));
      notifyFailure('Reconnected, but couldn’t catch up on everything. Reload the page if something looks out of date.');
    });
  };

  const open = () => {
    if (stopped) return;
    es = new EventSource('/api/events', { withCredentials: true });
    es.onopen = () => {
      retry = 1000;
      useStore.getState().set({ sseConnected: true });
      if (everConnected) resync();
      everConnected = true;
    };
    es.onmessage = (m) => {
      try { applyServerEvent(JSON.parse(m.data) as ServerEvent); } catch (e) { console.warn('bad event', e); }
    };
    es.onerror = () => {
      useStore.getState().set({ sseConnected: false });
      if (es?.readyState === EventSource.CLOSED) {
        es = null;
        // A closed stream may mean the session ran out (or the account was reset): ask, and sign out if so.
        void useStore.getState().recheckAuth();
        timer = setTimeout(open, retry);
        retry = Math.min(retry * 2, 15_000);
      }
    };
  };
  open();
  return () => { stopped = true; clearTimeout(timer); es?.close(); };
}
