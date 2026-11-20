import { useEffect, useRef, useState } from 'react';
import type { Bot, LiveState, Row } from '@shared/types';
import { BotAvatarFor } from '../avatar/BotAvatar';
import { activityPhrase, isWaitingForYou } from '../lib/phrases';

const CAPTION_FADE_MS = 320;

/** One line of live reasoning. When the text changes, the old line fades out under the new one. */
function Caption({ text }: { text: string }) {
  const last = useRef(text);
  const [leaving, setLeaving] = useState<string | null>(null);
  useEffect(() => {
    const old = last.current;
    last.current = text;
    if (old === text) return;
    setLeaving(old);
    const t = setTimeout(() => setLeaving(null), CAPTION_FADE_MS);
    return () => clearTimeout(t);
  }, [text]);
  return (
    <span className="thinking__caption-stack">
      <span key={text} className="thinking__caption-line is-in">{text}</span>
      {leaving !== null && leaving !== text && <span key={`out:${leaving}`} className="thinking__caption-line is-out" aria-hidden>{leaving}</span>}
    </span>
  );
}

interface Props {
  bot: Bot;
  live: LiveState;
  rows: Row[];
}

/** The label of the step running right now in this turn, e.g. "Searching the web". */
function runningStep(rows: Row[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const b = rows[i].body;
    if (b.type === 'message' && b.role === 'user') return null;
    if (b.type === 'tool-call' && b.status === 'running') return b.label || null;
  }
  return null;
}

/**
 * The live line at the end of the transcript while a turn runs: the bot's moving avatar and one
 * shimmering line saying what it is doing. When the bot is waiting for the person it reads "Needs you"
 * in the warning color and stops moving.
 */
export function ThinkingBlock({ bot, live, rows }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const waiting = isWaitingForYou(live);
  const since = live.startedAt ?? now;
  const tick = Math.floor((now - (live.activity?.since ?? since)) / 6000);
  const caption = waiting
    ? 'Needs you'
    : runningStep(rows) || live.caption?.trim() || activityPhrase(live, rows, tick);

  return (
    <div className={`thinking${waiting ? ' is-waiting' : ''}`} role="status" aria-live="polite">
      <span className="thinking__mascot"><BotAvatarFor bot={bot} size={18} mood={waiting ? 'waiting' : 'working'} /></span>
      <div className="thinking__line">
        <span className="thinking__caption"><Caption text={caption} /></span>
      </div>
    </div>
  );
}

/** Kept for existing importers: the activity line is now the thinking block. */
export const ActivityLine = ThinkingBlock;
