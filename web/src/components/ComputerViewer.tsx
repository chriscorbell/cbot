import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type RFBType from '@novnc/novnc';
import type { Bot } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { computerStatusText, screenSize } from '../lib/computer';
import { configApi } from '../lib/configApi';
import { useSelectedBot, useStore } from '../store';
import { Icon } from './Icon';
import { createPortal } from 'react-dom';
import { Minimize2 } from 'lucide-react';
import { isTopLayer, useDialogFocus } from '../lib/focus';
import { useExiting } from './Presence';

export type ScreenMode = 'watch' | 'control';
type Conn = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';
type Phase = 'live' | 'switching' | 'opening' | 'idle' | 'paused' | 'error';

interface ScreenProps {
  bot: Bot;
  /** 'panel' is the small live view in the details panel; 'stage' is the large view. */
  variant: 'panel' | 'stage';
  initialMode?: ScreenMode;
  /** Stop streaming and show a placeholder (the large view has this screen). */
  paused?: boolean;
  /** Panel only: the person asked for the large view, in this mode. */
  onExpand?: (mode: ScreenMode) => void;
  /** Told when the stream fails or recovers, so the status line around the screen can agree with it. */
  onUnreachable?: (unreachable: boolean) => void;
  onModeChange?: (mode: ScreenMode) => void;
}

/** A name for one screen connection, so the relay can switch it between watching and control. */
const connId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A bot's screen on the shared computer: noVNC over our relay inside a rounded frame that keeps the
 * screen's aspect ratio. Watching is view-only. Taking control switches the open connection to
 * control (the relay stops dropping input) and shows a chin under the frame with the way back.
 */
export function ComputerScreen({ bot, variant, initialMode = 'watch', paused = false, onExpand, onModeChange, onUnreachable }: ScreenProps) {
  const computer = useStore((s) => s.computer);
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFBType | null>(null);
  /** The open connection's name and the mode last asked of the relay for it. */
  const connRef = useRef<{ id: string; mode: ScreenMode } | null>(null);
  const hadFrame = useRef(false);

  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [conn, setConn] = useState<Conn>('idle');
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const [opened, setOpened] = useState(variant === 'stage');
  const [resetAsk, setResetAsk] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const hasScreen = !!computer?.screens.some((s) => s.botId === bot.id);
  const { width, height } = screenSize(computer, bot.id);
  const driving = mode === 'control';
  const large = variant === 'stage' || fullscreen;
  // The small panel view only streams a screen that already exists, so browsing bots never uses up screens.
  const wantLive = !!computer && !paused && (variant === 'stage' || visible) && (opened || hasScreen);

  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!frameRef.current && document.fullscreenElement === frameRef.current);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  useEffect(() => {
    if (!wantLive || !canvasRef.current) { setConn('idle'); return; }
    let disposed = false;
    let closed = false;
    let rfb: RFBType | null = null;
    setConn('connecting');
    (async () => {
      const { default: RFB } = await import('@novnc/novnc');
      if (disposed || !canvasRef.current) return;
      // Opened in the mode wanted now; later changes switch this connection (the effect below).
      const m = modeRef.current;
      const id = connId();
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const url = `${proto}://${location.host}/api/bots/${bot.id}/screen?mode=${m}&conn=${id}`;
      rfb = new RFB(canvasRef.current, url, { shared: true });
      rfb.viewOnly = m === 'watch';
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = 'transparent';
      rfb.focusOnClick = m === 'control';
      rfb.addEventListener('connect', () => { if (!disposed) { hadFrame.current = true; setConn('connected'); if (connRef.current?.mode === 'control') rfb?.focus(); } });
      rfb.addEventListener('disconnect', (e) => { closed = true; if (!disposed) setConn((e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'disconnected' : 'error'); });
      rfb.addEventListener('securityfailure', () => { if (!disposed) setConn('error'); });
      rfbRef.current = rfb;
      connRef.current = { id, mode: m };
    })().catch(() => { if (!disposed) setConn('error'); });
    const el = canvasRef.current;
    return () => {
      disposed = true;
      // noVNC logs an error when told to disconnect a connection that has already closed.
      if (!closed) { try { rfb?.disconnect(); } catch { /* already closed */ } }
      rfbRef.current = null;
      connRef.current = null;
      el.innerHTML = '';
    };
  }, [bot.id, wantLive, attempt]);

  // Taking control or handing back switches the open connection. Watching stops input here at once;
  // control waits for the relay to pass input on. If the relay has lost the connection, reconnect.
  useEffect(() => {
    const c = connRef.current;
    const rfb = rfbRef.current;
    if (!c || !rfb || c.mode === mode) return;
    c.mode = mode;
    if (mode === 'watch') { rfb.viewOnly = true; rfb.focusOnClick = false; }
    let stale = false;
    configApi.screenMode(bot.id, c.id, mode)
      .then(() => {
        if (stale || connRef.current !== c || mode !== 'control') return;
        rfb.viewOnly = false; rfb.focusOnClick = true; rfb.focus();
      })
      .catch(() => { if (!stale && connRef.current === c) setAttempt((n) => n + 1); });
    return () => { stale = true; };
  }, [mode, bot.id]);

  // The parent hears about a mode change in the same event, so its Escape handling is never a step behind.
  const changeMode = useCallback((m: ScreenMode) => { setMode(m); onModeChange?.(m); }, [onModeChange]);

  const handBack = useCallback(() => {
    changeMode('watch');
    // The bot carries on either way; this only tells it sooner.
    configApi.handback(bot.id).catch(() => {});
  }, [bot.id, changeMode]);

  // The panel view is too small to drive: control there only exists in full screen, and ends with it.
  useEffect(() => {
    if (variant === 'panel' && !fullscreen && modeRef.current === 'control') handBack();
  }, [variant, fullscreen, handBack]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  useEffect(() => {
    if (!resetAsk) return;
    const t = setTimeout(() => setResetAsk(false), 6000);
    return () => clearTimeout(t);
  }, [resetAsk]);

  let phase: Phase;
  if (paused) phase = 'paused';
  else if (!opened && !hasScreen) phase = 'idle';
  else if (conn === 'error' || conn === 'disconnected') phase = 'error';
  else if (conn === 'connected') phase = 'live';
  else phase = hadFrame.current ? 'switching' : 'opening';
  useEffect(() => {
    const bad = phase === 'error';
    onUnreachable?.(bad);
    const st = useStore.getState();
    if (!!st.screenUnreachable[bot.id] !== bad) st.set({ screenUnreachable: { ...st.screenUnreachable, [bot.id]: bad } });
  }, [phase === 'error', bot.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const takeControl = () => {
    if (variant === 'panel' && !fullscreen) onExpand?.('control');
    else changeMode('control');
  };
  const retry = () => {
    useStore.getState().loadComputer().catch(() => {});
    setAttempt((n) => n + 1);
  };
  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else frameRef.current?.requestFullscreen().catch(() => setNote('Full screen isn’t available here.'));
  };
  const reset = async () => {
    setResetting(true);
    try { await configApi.resetScreen(bot.id); setAttempt((n) => n + 1); }
    catch { setNote('Couldn’t reset the screen.'); }
    finally { setResetting(false); setResetAsk(false); }
  };

  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  const expandable = variant === 'panel' && !fullscreen && phase === 'live';
  const mascot = large ? 64 : 40;
  const style = { ...botVars(bot.avatarColor), ['--screen-ratio' as string]: String(width / height) } as CSSProperties;

  return (
    <div
      ref={frameRef}
      className={`screen screen--${variant} is-${phase}${driving ? ' is-driving' : ''}${fullscreen ? ' is-fullscreen' : ''}`}
      style={style}
    >
      <div className="screen__body">
        <div className="screen__view" style={{ aspectRatio: `${width} / ${height}` }}>
          <div ref={canvasRef} className="screen__canvas" />
          {/* noVNC swallows clicks on its canvas, so the way into the large view is a button laid over it. */}
          {expandable && <button type="button" className="screen__expand" onClick={() => onExpand?.('watch')} aria-label={`Open ${bot.name}’s computer in the large view`} title="Open the large view" />}

          {phase === 'live' && !driving && !large && (
            <span className="screen__badge" aria-hidden>
              <BotAvatarFor bot={bot} size={16} />
              <span>Live</span>
              <i className="screen__live-dot" />
            </span>
          )}

          {phase === 'opening' && large && (
            <div className="screen__state is-loading" role="status">
              <span className="dots-loader" aria-hidden><BotAvatarFor bot={{ ...bot, avatarColor: 'black' }} size={13} /><i /><i /><i /></span>
              <span className="screen__label">{hasScreen ? 'Connecting' : 'Starting desktop'}</span>
            </div>
          )}
          {phase === 'opening' && !large && (
            <div className="screen__state is-waking" role="status">
              <span className="screen__sweep" aria-hidden />
              <span className="screen__mascot is-bobbing"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__label">Opening {bot.name}’s screen…</span>
            </div>
          )}
          {phase === 'switching' && (
            <div className="screen__state" role="status">
              <span className="screen__text">One moment…</span>
            </div>
          )}
          {phase === 'idle' && (
            <div className="screen__state">
              <span className="screen__mascot"><BotAvatarFor bot={bot} size={mascot} /></span>
              <span className="screen__text">{bot.name} hasn’t opened a screen yet</span>
              <button type="button" className="screen__action" onClick={() => setOpened(true)}>Open its screen</button>
            </div>
          )}
          {phase === 'paused' && (
            <div className="screen__state">
              <span className="screen__text">Open in the large view</span>
            </div>
          )}
          {phase === 'error' && (
            <div className="screen__state" role="alert">
              <span className="screen__text">{conn === 'disconnected' ? 'The screen disconnected' : `Couldn’t reach ${bot.name}’s screen`}</span>
              {computer?.status === 'error' && computer.error && <span className="screen__sub">{computer.error}</span>}
              <button type="button" className="screen__action" onClick={retry}>Retry</button>
            </div>
          )}

        </div>

        {variant === 'stage' && (phase === 'live' || phase === 'opening' || phase === 'switching') && (
          <div className="viewer-pill" role="toolbar" aria-label="Who is using the screen">
            {driving ? (
              <>
                <span className="viewer-pill__state"><Icon name="pointer" size={13} /><span>You’re in control</span></span>
                <button key="stop" type="button" className="viewer-pill__btn" onClick={handBack}>Stop</button>
              </>
            ) : (
              <>
                <span className="viewer-pill__state"><Icon name="eye" size={13} /><span>Watching</span></span>
                <button key="take" type="button" className="viewer-pill__btn is-primary" onClick={takeControl} disabled={phase !== 'live'}>Take control</button>
              </>
            )}
          </div>
        )}

          {phase === 'live' && !driving && variant === 'panel' && (
          <div className={`screen__pill${resetAsk || note ? ' is-pinned' : ''}`} role="toolbar" aria-label="Screen controls">
            {note ? <span className="screen__pill-text" role="status">{note}</span> : resetAsk ? (
              <>
                <span className="screen__pill-text">Close all windows?</span>
                <button type="button" className="screen__pill-btn is-danger" onClick={reset} disabled={resetting}>{resetting ? 'Resetting…' : 'Reset'}</button>
                <button type="button" className="screen__pill-btn" onClick={() => setResetAsk(false)} disabled={resetting}>Cancel</button>
              </>
            ) : (
              <>
                <div className="screen__seg" role="group" aria-label="Who is using the screen">
                  <button type="button" className="screen__seg-btn is-active" aria-pressed="true">{large && <Icon name="eye" size={14} />}Watch</button>
                  <button type="button" className="screen__seg-btn" aria-pressed="false" onClick={takeControl}>{large && <Icon name="pointer" size={14} />}Take control</button>
                </div>
                <span className="screen__pill-rule" aria-hidden />
                {canFullscreen && (
                  <button type="button" className="screen__pill-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                    <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                  </button>
                )}
                <button type="button" className="screen__pill-icon" onClick={() => setResetAsk(true)} aria-label="Reset screen" title="Reset: close everything on this screen">
                  <Icon name="refresh" size={15} />
                </button>
              </>
            )}
          </div>
        )}

        {driving && variant === 'panel' && (
          <div className="screen__chin">
            <span className="screen__chin-text" role="status">
              <i className="screen__ping" aria-hidden />
              <span>You’re driving</span>
            </span>
            <span className="screen__chin-actions">
              {canFullscreen && (
                <button type="button" className="screen__chin-icon" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
                  <Icon name={fullscreen ? 'shrink' : 'expand'} size={15} />
                </button>
              )}
              <button type="button" className="screen__handback" onClick={handBack}>
                <BotAvatarFor bot={bot} size={18} />
                <span>Hand back to {bot.name}</span>
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** The large computer view: the bot's screen on a dimmed stage, opened from the chat menu or the details panel. */
export function ComputerViewer() {
  const bot = useSelectedBot();
  const computer = useStore((s) => s.computer);
  const initialMode = useStore((s) => s.viewerMode);
  const set = useStore((s) => s.set);
  const [mode, setMode] = useState<ScreenMode>(initialMode);
  const [unreachable, setUnreachable] = useState(false);
  const botId = bot?.id;
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useExiting();

  const modeRef = useRef(mode);
  const close = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (modeRef.current === 'control' && botId) configApi.handback(botId).catch(() => {});
    set({ viewerOpen: false, viewerMode: 'watch' });
  }, [botId, set]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      // While driving, Escape belongs to the remote desktop. In full screen the browser uses it to leave.
      if (e.key === 'Escape' && modeRef.current === 'watch' && !document.fullscreenElement && isTopLayer(ref.current)) { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);

  const onModeChange = useCallback((m: ScreenMode) => {
    modeRef.current = m;
    setMode(m);
    set({ viewerMode: m });
  }, [set]);

  useDialogFocus(ref, { trap: mode === 'watch' });
  if (!bot) return null;

  return createPortal(
    <div ref={ref} className={`viewer${exiting ? ' is-exiting' : ''}`} role="dialog" aria-modal="true" aria-label={`${bot.name}’s computer`} style={botVars(bot.avatarColor)}>
      <div className="viewer__scrim" />
      <button type="button" className="viewer__collapse" onClick={close} aria-label={`Close ${bot.name}’s computer`} title={`${bot.name}’s computer · ${unreachable ? 'Not responding' : computerStatusText(computer)}`}>
        <Minimize2 size={15} strokeWidth={1.75} aria-hidden />
      </button>
      <div className="viewer__stage">
        <ComputerScreen key={bot.id} bot={bot} variant="stage" initialMode={initialMode} onModeChange={onModeChange} onUnreachable={setUnreachable} />
      </div>
    </div>,
    document.body,
  );
}
