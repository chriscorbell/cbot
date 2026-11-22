import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MessageSquareText, Settings, Volume2 } from 'lucide-react';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { botVars } from '../lib/colors';
import { useStore } from '../store';
import { callLevels, endCall, hasSpeakerChoice, setSpeaker, toggleMute, useVoice } from '../voice/call';
import { useConfigUI } from '../configStore';
import { Presence } from './Presence';
import { CallSettings } from './VoiceSettings';

function MicGlyph({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

function HangUpGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M12 9.5c-2.6 0-5.1.5-7.3 1.6-.7.3-1.2 1-1.2 1.8v2.3c0 .8.7 1.4 1.5 1.3l3-.4c.7-.1 1.2-.7 1.2-1.4v-1.6c1.8-.5 3.8-.5 5.6 0v1.6c0 .7.5 1.3 1.2 1.4l3 .4c.8.1 1.5-.5 1.5-1.3v-2.3c0-.8-.5-1.5-1.2-1.8-2.2-1.1-4.7-1.6-7.3-1.6Z" />
    </svg>
  );
}

const BARS = 14;

/**
 * The call, floating under the header: the bot, a live level meter, call settings, the transcript,
 * the loudspeaker (iPhone and iPad), mute and hang up. Shown while a call is connecting, live, or just failed.
 */
export function VoiceCallBar() {
  const v = useVoice();
  const bot = useStore((s) => s.bots.find((b) => b.id === v.botId));
  const [settings, setSettings] = useState(false);
  const [log, setLog] = useState(false);
  const avatarRef = useRef<HTMLSpanElement>(null);
  const meterRef = useRef<HTMLSpanElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const active = v.status === 'connecting' || v.status === 'live';
  const speakerChoice = hasSpeakerChoice();
  const closeSettings = useCallback(() => setSettings(false), []);
  // Remembered for this device's next call: someone who talks to a bot hands-free wants the loudspeaker every time.
  const toggleSpeaker = () => {
    const on = !useVoice.getState().speaker;
    useConfigUI.getState().setPref({ callSpeaker: on });
    setSpeaker(on);
  };

  // Drive the avatar and the meter from the audio levels without re-rendering React every frame.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let out = 0;
    let mic = 0;
    let last = 0;
    const history: { l: number; who: 'bot' | 'you' }[] = Array.from({ length: BARS }, () => ({ l: 0, who: 'bot' }));
    const tick = (t: number) => {
      const lv = callLevels();
      out = out * 0.7 + lv.out * 0.3;
      mic = mic * 0.7 + Math.min(1, lv.mic * 3) * 0.3;
      avatarRef.current?.style.setProperty('--out', out.toFixed(3));
      if (t - last > 70) {
        last = t;
        const bot = out >= mic;
        history.shift();
        history.push({ l: Math.min(1, (bot ? out : mic) * 1.4), who: bot ? 'bot' : 'you' });
        const bars = meterRef.current?.children;
        if (bars) for (let i = 0; i < bars.length; i++) {
          const el = bars[i] as HTMLElement;
          el.style.setProperty('--l', history[i].l.toFixed(3));
          el.dataset.who = history[i].who;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useLayoutEffect(() => {
    if (log && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, v.captions]);

  if (v.status === 'idle' || !bot) return null;

  const working = v.thinking && !v.speaking && !v.listening;
  const label = v.status === 'connecting' ? 'Connecting…' : v.status === 'error' ? v.error ?? 'Call ended' : null;
  const lines = v.captions.filter((c) => c.text.trim());

  return (
    <div className={`vcall-wrap${v.status === 'error' ? ' is-error' : ''}${log && active && !settings ? ' has-log' : ''}`} style={botVars(bot.avatarColor)}>
      <div
        className={`vcall glass is-${v.status}${v.speaking ? ' is-speaking' : ''}${v.listening ? ' is-listening' : ''}${working ? ' is-working' : ''}`}
        role="region"
        aria-label={`Voice call with ${bot.name}`}
      >
        <span className="vcall__avatar" ref={avatarRef}>
          <span className="vcall__halo" aria-hidden />
          <BotAvatarFor bot={bot} size={26} mood={working ? 'working' : 'idle'} />
        </span>
        {label ? (
          <span className="vcall__label" role="status">{label}</span>
        ) : (
          <span className={`vcall__meter${working ? ' is-working' : ''}`} ref={meterRef} aria-hidden>
            {Array.from({ length: BARS }, (_, i) => <i key={i} />)}
          </span>
        )}
        <span className="sr-only" aria-live="polite">{v.speaking ? `${bot.name} is speaking` : v.listening ? 'Listening' : working ? `${bot.name} is thinking` : ''}</span>
        {active && (
          <>
            <button type="button" className={`vcall__btn vcall__btn--settings${settings ? ' is-on' : ''}`} onClick={() => setSettings(!settings)} aria-expanded={settings} aria-label="Call settings" title="Call settings">
              <Settings size={16} strokeWidth={1.75} aria-hidden />
            </button>
            <button type="button" className={`vcall__btn${log ? ' is-on' : ''}`} onClick={() => setLog(!log)} aria-pressed={log} aria-label={log ? 'Hide transcript' : 'Show transcript'} title={log ? 'Hide transcript' : 'Show transcript'}>
              <MessageSquareText size={16} strokeWidth={1.75} aria-hidden />
            </button>
            {speakerChoice && (
              <button type="button" className={`vcall__btn${v.speaker ? ' is-on' : ''}`} onClick={toggleSpeaker} disabled={v.status !== 'live'} aria-pressed={v.speaker} aria-label="Speaker" title={v.speaker ? 'Speaker on' : 'Speaker'}>
                <Volume2 size={16} strokeWidth={1.75} aria-hidden />
              </button>
            )}
            <button type="button" className={`vcall__btn${v.muted ? ' is-muted' : ''}`} onClick={toggleMute} aria-pressed={v.muted} aria-label={v.muted ? 'Unmute' : 'Mute'} title={v.muted ? 'Unmute' : 'Mute'}>
              <MicGlyph off={v.muted} />
            </button>
            <button type="button" className="vcall__btn vcall__btn--end" onClick={endCall} aria-label="Hang up" title="Hang up">
              <HangUpGlyph />
            </button>
          </>
        )}
        {!active && (
          <button type="button" className="vcall__btn" onClick={() => useVoice.setState({ status: 'idle', botId: null, error: null })} aria-label="Dismiss">✕</button>
        )}
      </div>
      <Presence show={settings && active} ms={120}><CallSettings bot={bot} onClose={closeSettings} keepOpenFor=".vcall__btn--settings" /></Presence>
      {log && active && !settings && (
        <div className="vcall-log" ref={logRef}>
          {lines.length ? lines.map((c) => (
            <div key={c.id} className={`vcall-log__line is-${c.role}${c.final ? '' : ' is-partial'}`}>
              {c.text.trim().split(/\s+/).map((w, i) => <span key={i} className="word">{w} </span>)}
            </div>
          )) : <div className="vcall-log__line is-empty">{v.muted ? 'You’re muted.' : `Say hi to ${bot.name}.`}</div>}
        </div>
      )}
    </div>
  );
}
