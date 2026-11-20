import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { AvatarColor, AvatarShape, Bot } from '@shared/types';
import { palette } from '../lib/colors';
import { Icon } from '../components/Icon';
import { SHAPES, type ShapeDef } from './shapes.gen';
import { geometryOf, type Pill } from './geometry';
import { Creature, type CreatureEls, type Detail, type Mood } from './life';

/** A name with no artwork (bad data) draws as the blob. */
const shapeName = (shape: AvatarShape | string): string => (SHAPES[shape] ? String(shape) : 'blob');

/** Each shape's path is the body outline followed by the two eyes; split them so the eyes can move. */
const EYES = new Map<string, string>();
function eyesOf(def: ShapeDef): string {
  let e = EYES.get(def.d);
  if (e === undefined) {
    e = def.d.startsWith(def.outline) ? def.d.slice(def.outline.length).trim() : '';
    EYES.set(def.d, e);
  }
  return e;
}

interface Props {
  shape: AvatarShape | string;
  color: AvatarColor | string;
  /** Slot size in px. The drawing overflows the slot by the design's 1.533x ratio. */
  size: number;
  star?: boolean;
  /** Selected-shape ring following the silhouette. */
  ring?: boolean;
  /** The bot is working (same as mood="working"). */
  alive?: boolean;
  /** What the bot is up to; it sets the pace and the habits of its idle life. */
  mood?: Mood;
  /** Hatches the first time it shows, for a bot that was just made. */
  born?: boolean;
  /** Seeds the personality, so the same bot always moves the same way. Defaults to the shape and color. */
  seed?: string;
  /** How much life: full motion, a lighter version for small or crowded spots, or none. Defaults by size. */
  life?: Detail | 'off';
  className?: string;
  title?: string;
}

const OVERDRAW = 55.2 / 36;

/**
 * The expressions' shapes, drawn around an eye's centre: a thick little "◠" for a smile and a
 * "◡" for closed eyes, each a bit wider than the eye but never wider than its share of the gap,
 * so the two never run together.
 */
const arcHalf = (p: Pill, gap: number) => Math.min(p.wid * 0.95, gap * 0.27);
const arcStroke = (p: Pill, gap: number) => Math.min(p.wid * 0.9, gap * 0.21);
const smileArc = (p: Pill, gap: number) => { const a = arcHalf(p, gap); return `M${-a} ${a * 0.35}A${a} ${a * 0.9} 0 0 1 ${a} ${a * 0.35}`; };
const shutArc = (p: Pill, gap: number) => { const a = arcHalf(p, gap); return `M${-a} ${-a * 0.2}A${a} ${a * 0.65} 0 0 0 ${a} ${-a * 0.2}`; };

export function BotAvatar({ shape, color, size, star, ring, alive, mood, born, seed, life, className, title }: Props) {
  const key = shapeName(shape);
  const def = SHAPES[key];
  const draw = size * OVERDRAW;
  const off = (draw - size) / 2;
  // "Black" follows the theme's ink: black on light, near-white on dark.
  const fill = color === 'black' || !color ? 'var(--avatar-ink)' : palette(color).fill;
  const vbw = Number(def.viewBox.split(/\s+/)[2]);
  const px = vbw / draw;
  const eyes = eyesOf(def);
  const geo = useMemo(() => (typeof document === 'undefined' || !eyes ? null : geometryOf(key, def, eyes)), [key, def, eyes]);
  const detail: Detail | 'off' = life ?? (size < 14 ? 'off' : size < 22 ? 'lite' : 'full');
  const m: Mood = mood ?? (alive ? 'working' : 'idle');

  const host = useRef<HTMLSpanElement>(null);
  const root = useRef<SVGGElement>(null);
  const body = useRef<SVGGElement>(null);
  const face = useRef<SVGGElement>(null);
  const ball = useRef<SVGGElement>(null);
  const eyeRefs = useRef<CreatureEls['eyes']>([]);
  const orbRefs = useRef<SVGCircleElement[]>([]);
  const sparkRefs = useRef<SVGCircleElement[]>([]);
  const coreRef = useRef<SVGCircleElement>(null);
  const creature = useRef<Creature | null>(null);
  const bornRef = useRef(born);

  useLayoutEffect(() => {
    if (detail === 'off' || !geo || !host.current || !root.current || !body.current || !face.current || !ball.current || !coreRef.current) return;
    const c = new Creature(
      { host: host.current, root: root.current, body: body.current, face: face.current, eyes: eyeRefs.current.slice(0, geo.eyes.length), ball: ball.current, core: coreRef.current, orbs: orbRefs.current.slice(0, 2), sparks: sparkRefs.current.slice(0, 6) },
      geo,
      { seed: seed ?? `${shape}:${color}`, mood: m, detail, born: bornRef.current },
    );
    bornRef.current = false;
    creature.current = c;
    c.attach();
    return () => { c.detach(); creature.current = null; };
    // A new shape or level of detail means new elements; mood changes go through setMood below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, detail, seed]);
  useEffect(() => { creature.current?.setMood(m); }, [m]);
  // Hatching again later (the first time is handled when the creature is made).
  const sawBorn = useRef(born);
  useEffect(() => {
    if (born && !sawBorn.current && creature.current) creature.current.hatch(performance.now() / 1000);
    sawBorn.current = born;
  }, [born]);

  const R = geo ? Math.min(geo.body.w, geo.body.h) * 0.5 : 0;
  return (
    <span ref={host} className={`bot-avatar${detail !== 'off' && geo ? ' is-living' : ''} ${className ?? ''}`} style={{ width: size, height: size }} title={title} role="img" aria-label={title}>
      <svg width={draw} height={draw} viewBox={def.viewBox} style={{ position: 'absolute', left: -off, top: -off, overflow: 'visible' }} aria-hidden>
        {ring && <path d={def.outline} fill="none" stroke="var(--color-text-tertiary)" strokeWidth={px * 2 * 3.2} strokeLinejoin="round" />}
        {ring && <path d={def.outline} fill="none" stroke="var(--ring-gap, var(--color-bg-elevated))" strokeWidth={px * 2 * 2} strokeLinejoin="round" />}
        <g ref={root}>
          <g ref={body}>
            <path className="bot-avatar__body" d={def.outline} fill={fill} />
            <g ref={face}>
              {geo && detail !== 'off' ? geo.eyes.map((e, i) => (
                <g key={i} transform={`translate(${geo.face.cx + (i ? 1 : -1) * geo.gap / 2} ${geo.face.cy})`} ref={(g) => { if (g) eyeRefs.current[i] = { ...(eyeRefs.current[i] ?? {}), g } as CreatureEls['eyes'][number]; }}>
                  <rect ref={(el) => { if (el) (eyeRefs.current[i] ??= {} as CreatureEls['eyes'][number]).open = el; }} x={-e.wid / 2} y={-e.len / 2} width={e.wid} height={e.len} rx={e.wid / 2} fill="var(--avatar-eye)" />
                  <path ref={(el) => { if (el) (eyeRefs.current[i] ??= {} as CreatureEls['eyes'][number]).happy = el; }} d={smileArc(e, geo.gap)} fill="none" stroke="var(--avatar-eye)" strokeWidth={arcStroke(e, geo.gap)} strokeLinecap="round" opacity={0} />
                  <circle ref={(el) => { if (el) (eyeRefs.current[i] ??= {} as CreatureEls['eyes'][number]).dot = el; }} r={e.wid * 0.6} fill="var(--avatar-eye)" opacity={0} />
                  <path ref={(el) => { if (el) (eyeRefs.current[i] ??= {} as CreatureEls['eyes'][number]).shut = el; }} d={shutArc(e, geo.gap)} fill="none" stroke="var(--avatar-eye)" strokeWidth={arcStroke(e, geo.gap) * 0.85} strokeLinecap="round" opacity={0} />
                </g>
              )) : eyes && <path className="bot-avatar__eyes" d={eyes} fill="var(--avatar-eye)" />}
            </g>
          </g>
          {geo && detail !== 'off' && (
            <g ref={ball} opacity={0}>
              {[0, 1, 2, 3, 4, 5].map((i) => <circle key={`s${i}`} ref={(el) => { if (el) sparkRefs.current[i] = el; }} r={0} fill={fill} opacity={0} />)}
              <circle ref={coreRef} cx={geo.body.cx} cy={geo.body.cy} r={R * 0.6} fill={fill} />
              {[0, 1].map((i) => <circle key={`o${i}`} ref={(el) => { if (el) orbRefs.current[i] = el; }} r={0} fill={fill} />)}
            </g>
          )}
        </g>
      </svg>
      {star && (
        <span className="bot-avatar__star" style={{ width: Math.max(12, size * 0.36), height: Math.max(12, size * 0.36) }}>
          <Icon name="star" size={Math.max(7, size * 0.2)} strokeWidth={0} />
        </span>
      )}
    </span>
  );
}

export function BotAvatarFor({ bot, size, star, alive, mood, born, life, className }: { bot: Pick<Bot, 'avatarShape' | 'avatarColor' | 'name'> & { id?: string; isPrimary?: boolean }; size: number; star?: boolean; alive?: boolean; mood?: Mood; born?: boolean; life?: Detail | 'off'; className?: string }) {
  return <BotAvatar shape={bot.avatarShape} color={bot.avatarColor} size={size} star={star} alive={alive} mood={mood} born={born} life={life} seed={bot.id ?? bot.name} className={className} title={bot.name} />;
}
