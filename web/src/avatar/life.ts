/**
 * The bots' inner life. One animation loop drives every avatar on screen. Each avatar is a small
 * creature with a personality drawn from its bot's id, so two bots never move alike. Nothing here
 * is a loop on a timer: breathing and sway come from smooth noise, and behaviours are picked at
 * random intervals from a weighted list that changes with what the bot is doing.
 *
 * Layers, from always-on to occasional:
 *   breathing and a slow sway (noise, never quite repeating)
 *   eyes: saccades to new points, tiny tremors while holding, blinks (sometimes double)
 *   attention: the eyes, and a little of the body, follow the pointer when it comes near
 *   behaviours: glances, head tilts, happy squints, hops, wiggles, stretches, curious stares,
 *     looking at another bot (who may look back), and while working, reading scans, focus and
 *     a "thinking" turn into a ball with two orbiting dots
 *   moods: working is busier and focused; waiting looks at you and nudges; finishing a turn
 *     earns a little celebration; when you go quiet for a while they get drowsy, then sleep,
 *     and wake with a start when you come back
 *   a new bot hatches: a seed, sparkles, a growing ball, then it pops into shape and blinks awake
 *
 * The loop writes SVG transforms directly; React only builds the elements once.
 */
import type { Geometry } from './geometry';

export type Mood = 'idle' | 'working' | 'waiting' | 'asleep';
export type Detail = 'full' | 'lite';

export interface CreatureEls {
  host: HTMLElement;
  root: SVGGElement;
  body: SVGGElement;
  face: SVGGElement;
  eyes: { g: SVGGElement; open: SVGGraphicsElement; happy: SVGPathElement; dot: SVGCircleElement; shut: SVGPathElement }[];
  ball: SVGGElement;
  core: SVGCircleElement;
  orbs: SVGCircleElement[];
  sparks: SVGCircleElement[];
}

// ---------------------------------------------------------------------------- randomness

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** mulberry32: small, fast, seedable. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1D gradient noise in about [-1, 1]. */
function noise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g = (n: number) => {
    const s = Math.sin((n + seed * 0.618) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return (g(i) * f * (1 - u) + g(i + 1) * (f - 1) * u) * 2.2;
}

/** Two octaves: a slow wander with a little texture on top. */
const fbm = (x: number, seed: number) => noise(x, seed) * 0.72 + noise(x * 2.7 + 13.1, seed + 7) * 0.28;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// ---------------------------------------------------------------------------- physics

/** A damped spring toward `target`: `f` is how fast it moves (Hz), `z` how much it overshoots (1 = none). */
class Spring {
  v = 0;
  target: number;
  constructor(public x: number, public f: number, public z: number) { this.target = x; }
  step(dt: number) {
    const w = 2 * Math.PI * this.f;
    // Sub-steps keep stiff springs stable on slow frames.
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (w * w * (this.target - this.x) - 2 * this.z * w * this.v) * h;
      this.x += this.v * h;
    }
  }
  kick(dv: number) { this.v += dv; }
}

/** Eases a value toward its target at `rate` per second. */
class Ease {
  target: number;
  constructor(public x: number, public rate: number) { this.target = x; }
  step(dt: number) { this.x += (this.target - this.x) * (1 - Math.exp(-dt * this.rate)); }
}

// ---------------------------------------------------------------------------- the world

interface Pointer { x: number; y: number; moved: number; speed: number }
const pointer: Pointer = { x: -1e4, y: -1e4, moved: -1e9, speed: 0 };
/** Last time the person did anything here (moved, typed, scrolled, clicked), in seconds. */
let lastActivity = performance.now() / 1000;
let rectsDirty = true;
const reduced = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

const creatures = new Set<Creature>();
let raf = 0;
let last = 0;
let listening = false;

function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('pointermove', (e) => {
    const now = performance.now() / 1000;
    const dt = Math.max(1 / 240, now - pointer.moved);
    const d = Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y);
    pointer.speed = pointer.speed * 0.6 + (d / dt) * 0.4;
    pointer.x = e.clientX; pointer.y = e.clientY; pointer.moved = now;
    wake(now);
  }, { passive: true });
  for (const ev of ['keydown', 'wheel', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => wake(performance.now() / 1000), { passive: true, capture: true });
  window.addEventListener('scroll', () => { rectsDirty = true; }, { passive: true, capture: true });
  window.addEventListener('resize', () => { rectsDirty = true; }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { last = 0; start(); } });
}

/** The person is back: anyone who dozed off wakes up, the deep sleepers with a start. */
function wake(now: number) {
  const away = now - lastActivity;
  lastActivity = now;
  if (away > 60) for (const c of creatures) c.wakeUp(away);
}

function start() {
  if (raf || !creatures.size) return;
  raf = requestAnimationFrame(frame);
}

function frame(ms: number) {
  raf = 0;
  if (document.visibilityState !== 'visible' || !creatures.size) return;
  const now = ms / 1000;
  const dt = last ? clamp(now - last, 0, 0.1) : 1 / 60;
  last = now;
  const refresh = rectsDirty;
  rectsDirty = false;
  for (const c of creatures) c.update(now, dt, refresh);
  raf = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------- a creature

interface Persona {
  /** How much it moves (0.65 to 1.35). */
  energy: number;
  /** How often it looks around. */
  curiosity: number;
  /** How readily it smiles. */
  cheer: number;
  /** Mean seconds between blinks. */
  blink: number;
  /** A slight habitual head tilt, in degrees. */
  tilt: number;
  /** How quickly its eyes catch up (Hz). */
  eyes: number;
}

type Timed = { at: number; fn: () => void };

export class Creature {
  private rnd: () => number;
  private seed: number;
  /** The bot this is; its other avatars on screen aren't company. */
  readonly who: string;
  private p: Persona;
  private mood: Mood;
  private visible = true;
  private hovered = false;
  private rect = { cx: 0, cy: 0, r: 0, at: -1 };
  private queue: Timed[] = [];
  private nextAct = 0;
  private nextBlink = 0;
  private nextTremor = 0;
  private blinkAt = -1;
  private blinkLen = 0.18;
  private busyUntil = 0;
  private holdGazeUntil = 0;
  private breathPhase = 0;
  private hatchAt = -1;
  private sleepiness = 0;
  private io: IntersectionObserver | null = null;

  // gaze, -1..1 on each axis
  private gx: Spring; private gy: Spring;
  private gazeT = { x: 0, y: 0 };
  // body
  private tilt = new Spring(0, 2.1, 0.5);
  private wig = new Spring(0, 4.2, 0.16);
  private lean = new Spring(0, 1.6, 0.85);
  private sx = new Spring(1, 4.6, 0.3);
  private sy = new Spring(1, 4.6, 0.3);
  private hop = new Spring(0, 2.6, 0.42);
  private pop = new Spring(1, 3.2, 0.34);
  // expressions, 0..1
  private happy = new Ease(0, 15);
  private dot = new Ease(0, 15);
  private wide = new Ease(0, 12);
  private squint = new Ease(0, 6);
  private shut = new Ease(0, 5);
  private ball = new Ease(0, 7);

  constructor(private els: CreatureEls, private geo: Geometry, opts: { seed: string; mood: Mood; detail: Detail; born?: boolean }) {
    this.who = opts.seed;
    this.seed = hashString(opts.seed) % 10007;
    this.rnd = rng(hashString(`${opts.seed}:${performance.now()}`));
    const r = rng(hashString(opts.seed));
    this.p = {
      energy: 0.65 + r() * 0.7,
      curiosity: 0.6 + r() * 0.9,
      cheer: 0.5 + r() * 1.0,
      blink: 2.6 + r() * 2.6,
      tilt: (r() - 0.5) * 5,
      eyes: 6 + r() * 4,
    };
    this.detail = opts.detail;
    this.mood = opts.mood;
    this.gx = new Spring(0, this.p.eyes, 0.82);
    this.gy = new Spring(0, this.p.eyes, 0.82);
    const now = performance.now() / 1000;
    this.nextAct = now + 0.6 + this.rnd() * 2.4;
    this.nextBlink = now + 0.4 + this.rnd() * this.p.blink;
    this.breathPhase = this.rnd() * Math.PI * 2;
    if (opts.mood === 'asleep') this.shut.x = this.shut.target = 1;
    if (opts.born) this.hatch(now);
  }

  detail: Detail;

  attach() {
    creatures.add(this);
    listen();
    if (typeof IntersectionObserver !== 'undefined') {
      this.io = new IntersectionObserver((es) => { for (const e of es) this.visible = e.isIntersecting; if (this.visible) { this.rect.at = -1; start(); } });
      this.io.observe(this.els.host);
    }
    const h = this.els.host;
    h.addEventListener('pointerenter', this.onEnter);
    h.addEventListener('pointerleave', this.onLeave);
    h.addEventListener('pointerdown', this.onDown);
    start();
  }

  detach() {
    creatures.delete(this);
    this.io?.disconnect();
    const h = this.els.host;
    h.removeEventListener('pointerenter', this.onEnter);
    h.removeEventListener('pointerleave', this.onLeave);
    h.removeEventListener('pointerdown', this.onDown);
  }

  setMood(m: Mood) {
    if (m === this.mood) return;
    const was = this.mood;
    this.mood = m;
    const now = performance.now() / 1000;
    this.queue = [];
    this.busyUntil = 0;
    this.ball.target = 0;
    this.dot.target = 0;
    this.shut.target = m === 'asleep' ? 1 : 0;
    this.squint.target = 0;
    if (m === 'working') {
      // Perks up, then settles into focus.
      this.wide.target = 1;
      this.after(0.35, () => { this.wide.target = 0; this.squint.target = 0.35; });
      this.sy.kick(1.6);
      this.nextAct = now + 0.8;
    } else if (was === 'working' && m === 'idle') {
      this.celebrate();
    } else if (m === 'waiting') {
      this.look(0, 0.2, 2.5);
      this.nudge();
    }
  }

  // ------------------------------------------------------------------ pointer

  private onEnter = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    this.hovered = true;
    if (this.mood === 'asleep') return;
    this.wig.kick((this.rnd() < 0.5 ? -1 : 1) * 40 * this.p.energy);
    this.happy.target = this.p.cheer > 0.8 || this.rnd() < 0.6 ? 1 : 0;
  };
  private onLeave = () => {
    this.hovered = false;
    this.happy.target = 0;
  };
  private onDown = () => {
    if (this.mood === 'asleep') { this.shut.target = 0; this.wide.target = 1; this.after(0.5, () => { this.wide.target = 0; this.shut.target = 1; }); return; }
    this.sy.kick(-3.2); this.sx.kick(2.4);
    this.happy.target = 1;
    this.after(0.7, () => { if (!this.hovered) this.happy.target = 0; });
    if (this.detail === 'full' && this.rnd() < 0.35) this.after(0.2, () => this.hopNow(0.7));
  };

  /** Came back after being away: the dozy ones blink awake, the sleepers jump. */
  wakeUp(away: number) {
    if (this.mood === 'asleep') return;
    const deep = away > 300;
    this.sleepiness = 0;
    this.shut.target = 0;
    this.queue = [];
    if (deep) {
      this.wide.target = 1;
      this.after(0.12 + this.rnd() * 0.25, () => { if (this.detail === 'full') this.hopNow(0.8); this.wig.kick(60); });
      this.after(0.9, () => { this.wide.target = 0; this.doubleBlink(performance.now() / 1000); });
    } else {
      this.after(this.rnd() * 0.4, () => this.doubleBlink(performance.now() / 1000));
    }
  }

  /** Another bot looked over: maybe look back, maybe smile. */
  noticed(by: Creature) {
    if (this.mood === 'asleep' || this.sleepiness > 0.7) return;
    this.after(0.25 + this.rnd() * 0.45, () => {
      this.lookAt(by, 0.9 + this.rnd() * 1.1);
      if (this.rnd() < 0.45) { this.happy.target = 1; this.after(0.9, () => { this.happy.target = 0; }); }
    });
  }

  // ------------------------------------------------------------------ the frame

  update(now: number, dt: number, refresh: boolean) {
    if (!this.visible || !this.els.host.isConnected) return;
    if (refresh || now - this.rect.at > 0.6 + (this.seed % 7) * 0.05) {
      const b = this.els.host.getBoundingClientRect();
      this.rect = { cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: Math.max(b.width, b.height) / 2, at: now };
    }

    // Timed steps of the current behaviour.
    if (this.queue.length) {
      const due = this.queue.filter((q) => q.at <= now);
      if (due.length) { this.queue = this.queue.filter((q) => q.at > now); for (const q of due) q.fn(); }
    }

    const still = !!reduced?.matches;
    const asleep = this.mood === 'asleep';
    // Drowsy after 90 s of nobody around, asleep after five minutes (only when there's nothing to do).
    const away = now - lastActivity;
    const target = this.mood === 'idle' ? smooth(90, 200, away) + smooth(300, 330, away) : 0;
    this.sleepiness += (target - this.sleepiness) * (1 - Math.exp(-dt * 0.8));
    const sleeping = asleep || this.sleepiness > 1.5;
    if (!asleep && this.mood === 'idle') this.shut.target = this.sleepiness > 1.5 ? 1 : this.hatchAt >= 0 ? this.shut.target : 0;

    // Blinks.
    if (now >= this.nextBlink && !sleeping) {
      if (this.rnd() < 0.16) this.doubleBlink(now); else this.blink(now);
      const mean = this.p.blink * (this.mood === 'working' ? 1.35 : 1) * (1 + this.sleepiness * 0.6);
      this.nextBlink = now + clamp(-Math.log(1 - this.rnd()) * mean, 0.5, mean * 3);
    }

    if (!still && !sleeping && now >= this.nextAct && now >= this.busyUntil && this.hatchAt < 0) this.act(now);

    // Attention: eyes, and a little of the body, follow a pointer that comes near.
    const fresh = now - pointer.moved < 2.2;
    const dx = pointer.x - this.rect.cx;
    const dy = pointer.y - this.rect.cy;
    const dist = Math.hypot(dx, dy);
    const reach = this.detail === 'full' ? 360 : 220;
    const attending = !still && !sleeping && fresh && dist < reach && this.hatchAt < 0;
    let gtx = this.gazeT.x, gty = this.gazeT.y, leanT = 0;
    if (attending) {
      if (dist < this.rect.r * 0.9) { gtx = dx / (this.rect.r || 1) * 0.35; gty = dy / (this.rect.r || 1) * 0.35; }
      else {
        const m = clamp((dist - this.rect.r) / 70, 0.35, 1);
        gtx = (dx / dist) * m; gty = (dy / dist) * m * 0.85;
        leanT = clamp(dx / reach, -1, 1) * 0.8 * (1 - dist / reach);
      }
      // A whoosh right past it is startling.
      if (pointer.speed > 2600 && dist < 150 && now > this.busyUntil && this.wide.target === 0 && this.rnd() < 0.08) {
        this.wide.target = 1; this.wig.kick(-50);
        this.after(0.55, () => { this.wide.target = 0; });
      }
    } else if (sleeping) { gtx = 0; gty = 0.25; }
    // Once a look has been held long enough, the eyes drift back to rest, just ahead.
    if (now > this.holdGazeUntil) { const k = Math.exp(-dt * 0.9); this.gazeT.x *= k; this.gazeT.y = this.gazeT.y * k + 0.04 * (1 - k); }

    // Tiny tremors while holding a look.
    if (now >= this.nextTremor) {
      this.nextTremor = now + 0.25 + this.rnd() * 0.9;
      this.gx.target = gtx + (this.rnd() - 0.5) * 0.08;
      this.gy.target = gty + (this.rnd() - 0.5) * 0.06;
    } else { this.gx.target += (gtx - this.gx.target) * 0.35; this.gy.target += (gty - this.gy.target) * 0.35; }
    this.gx.target = clamp(this.gx.target, -1, 1);
    this.gy.target = clamp(this.gy.target, -1, 1);
    this.lean.target = leanT;

    for (const s of [this.gx, this.gy, this.tilt, this.wig, this.lean, this.sx, this.sy, this.hop, this.pop]) s.step(dt);
    for (const e of [this.happy, this.dot, this.wide, this.squint, this.shut, this.ball]) e.step(dt);

    this.render(now, dt, still, sleeping);
  }

  private render(now: number, dt: number, still: boolean, sleeping: boolean) {
    const { body: b } = this.geo;
    const lite = this.detail === 'lite';
    const amp = lite ? 0.55 : 1;
    const e = this.p.energy;

    // Breathing: slow and deep when sleepy, quicker while working, its pace wandering a little.
    const rate = (this.mood === 'working' ? 0.4 : 0.24) * (1 + 0.25 * fbm(now * 0.07, this.seed)) * (1 - 0.35 * Math.min(1, this.sleepiness)) * (0.85 + e * 0.15);
    this.breathPhase += dt * Math.PI * 2 * rate;
    const depth = (0.013 + 0.008 * Math.min(1, this.sleepiness)) * amp;
    const br = Math.sin(this.breathPhase);
    const bsx = 1 - br * depth * 0.55;
    const bsy = 1 + br * depth;

    // Sway: a slow wander plus a habitual tilt.
    const sway = still ? 0 : fbm(now * 0.16, this.seed) * 2.4 * e * amp + this.p.tilt * amp + (sleeping ? 6 * Math.min(1, this.sleepiness - 0.5) : 0);
    const drift = still ? 0 : fbm(now * 0.11 + 40, this.seed) * b.w * 0.008 * amp;

    const gx = still ? 0 : this.gx.x;
    const gy = still ? 0 : this.gy.x;
    const angle = still ? 0 : sway + this.tilt.x + this.wig.x * 0.12 + this.lean.x * 4 + gx * 1.8;
    const tx = drift + (still ? 0 : this.lean.x * b.w * 0.045 + gx * b.w * 0.02);
    const ty = still ? 0 : this.hop.x * b.h;
    const ball = this.ball.x;
    const pop = this.pop.x;
    const sx = (still ? 1 : bsx * this.sx.x) * pop * (1 - 0.18 * ball);
    const sy = (still ? 1 : bsy * this.sy.x) * pop * (1 - 0.18 * ball);
    const ox = b.cx;
    const oy = b.y + b.h; // squash and stretch from the feet

    this.els.root.setAttribute('transform', `translate(${tx.toFixed(3)} ${ty.toFixed(3)}) translate(${ox} ${oy}) rotate(${angle.toFixed(3)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-ox} ${-oy})`);

    // Eyes live on the front of a sphere: looking somewhere moves them across it. They stay clean
    // pills: a little shorter along the way they look, leaning slightly on diagonals (up-right
    // reads as \\, down-right as //), and a little closer together when looking aside.
    const { face, gap, r } = this.geo;
    const travel = r * (lite ? 0.26 : 0.34);
    const lean = clamp(gx * gy * 38, -18, 18);
    const shortX = 1 - 0.12 * Math.abs(gx);
    const shortY = 1 - 0.16 * Math.abs(gy);
    const spacing = gap * (1 - 0.14 * Math.abs(gx));
    const ex = face.cx + gx * travel;
    const ey = face.cy + gy * travel * 0.8 - this.happy.x * gap * 0.06;

    const blink = this.blinkAmount(now);
    const droop = 1 - 0.5 * clamp(this.sleepiness, 0, 1);
    const wide = this.wide.x;
    const esx = 1 + 0.14 * wide;
    const esy = Math.max(0.07, (1 - 0.93 * blink) * (1 + 0.14 * wide) * (1 - 0.34 * this.squint.x) * droop);
    const happy = this.happy.x, dot = this.dot.x, shut = this.shut.x;
    const openO = clamp(1 - Math.max(happy, dot, shut), 0, 1);
    for (let i = 0; i < this.els.eyes.length; i++) {
      const el = this.els.eyes[i];
      const side = i === 0 ? -1 : 1;
      const x = ex + (side * spacing) / 2;
      el.g.setAttribute('transform', `translate(${x.toFixed(3)} ${ey.toFixed(3)}) rotate(${lean.toFixed(2)}) scale(${(esx * shortX).toFixed(4)} ${(esy * shortY).toFixed(4)})`);
      el.open.setAttribute('opacity', openO.toFixed(3));
      el.happy.setAttribute('opacity', (happy * (1 - shut)).toFixed(3));
      el.dot.setAttribute('opacity', (dot * (1 - happy) * (1 - shut)).toFixed(3));
      el.shut.setAttribute('opacity', shut.toFixed(3));
    }

    // Thinking: the body draws into a ball and two dots circle it. Hatching uses the same ball.
    const R = Math.min(b.w, b.h) * 0.5;
    let ballO = ball, coreR = R * (0.66 + 0.1 * ball + 0.03 * Math.sin(now * 5.3)), orbO = ball;
    let bodyO = 1 - ball, bodyS = 1 - 0.35 * ball;
    let sparkP = -1;
    if (this.hatchAt >= 0) {
      const h = now - this.hatchAt;
      if (h < 0.75) {
        ballO = 1; bodyO = 0; orbO = 0;
        coreR = R * (h < 0.3 ? 0.06 + 0.12 * smooth(0, 0.3, h) + 0.03 * Math.sin(h * 40) : 0.18 + 0.5 * smooth(0.3, 0.75, h));
        sparkP = h / 0.75;
      } else if (h < 0.95) {
        const k = smooth(0.75, 0.95, h);
        ballO = 1 - k; bodyO = k; orbO = 0; coreR = R * (0.68 + 0.1 * k);
      } else { ballO = 0; bodyO = 1; }
      bodyS = 1;
    }
    this.els.body.setAttribute('opacity', bodyO.toFixed(3));
    this.els.body.setAttribute('transform', bodyS === 1 ? '' : `translate(${b.cx} ${b.cy}) scale(${bodyS.toFixed(4)}) translate(${-b.cx} ${-b.cy})`);
    this.els.ball.setAttribute('opacity', ballO.toFixed(3));
    if (ballO > 0.002) {
      this.els.core.setAttribute('r', coreR.toFixed(3));
      const a = now * (3.1 + e * 0.8);
      this.els.orbs.forEach((o, i) => {
        const t = a + i * Math.PI;
        o.setAttribute('cx', (b.cx + Math.cos(t) * R * 1.12).toFixed(3));
        o.setAttribute('cy', (b.cy + Math.sin(t) * R * 0.2).toFixed(3));
        o.setAttribute('r', (R * 0.12 * (0.78 + 0.3 * Math.sin(t))).toFixed(3));
        o.setAttribute('opacity', orbO.toFixed(3));
      });
    }
    this.els.sparks.forEach((s, i) => {
      if (sparkP < 0) { s.setAttribute('opacity', '0'); return; }
      const ang = (i / this.els.sparks.length) * Math.PI * 2 + this.seed;
      const d = R * (0.25 + 1.05 * sparkP);
      s.setAttribute('cx', (b.cx + Math.cos(ang) * d).toFixed(3));
      s.setAttribute('cy', (b.cy + Math.sin(ang) * d).toFixed(3));
      s.setAttribute('r', (R * 0.07 * (1 - sparkP * 0.6)).toFixed(3));
      s.setAttribute('opacity', (Math.sin(Math.min(1, sparkP * 1.15) * Math.PI)).toFixed(3));
    });
    if (this.hatchAt >= 0 && now - this.hatchAt > 1.6) this.hatchAt = -1;
  }

  // ------------------------------------------------------------------ behaviours

  private after(s: number, fn: () => void) { this.queue.push({ at: performance.now() / 1000 + s, fn }); }

  private blink(now: number, len = 0.14 + this.rnd() * 0.08) { this.blinkAt = now; this.blinkLen = len * (1 + this.sleepiness * 1.5); }
  private doubleBlink(now: number) { this.blink(now, 0.13); this.after(0.24, () => this.blink(performance.now() / 1000, 0.13)); }
  private blinkAmount(now: number) {
    if (this.blinkAt < 0) return 0;
    const t = (now - this.blinkAt) / this.blinkLen;
    if (t >= 1) { this.blinkAt = -1; return 0; }
    // Shut fast, open a little slower.
    return t < 0.38 ? smooth(0, 0.38, t) : t < 0.5 ? 1 : 1 - smooth(0.5, 1, t);
  }

  private look(x: number, y: number, hold: number) {
    this.gazeT = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
    this.nextTremor = 0;
    this.holdGazeUntil = performance.now() / 1000 + hold;
  }

  private lookAt(other: Creature, hold: number) {
    const dx = other.rect.cx - this.rect.cx, dy = other.rect.cy - this.rect.cy;
    const d = Math.hypot(dx, dy) || 1;
    this.look((dx / d) * 0.95, (dy / d) * 0.8, hold);
    this.after(hold, () => this.look((this.rnd() - 0.5) * 0.4, (this.rnd() - 0.5) * 0.3, 1));
  }

  private hopNow(height = 1) {
    if (this.detail !== 'full') { this.sy.kick(2); return; }
    this.sy.target = 0.86; this.sx.target = 1.1;
    this.after(0.11, () => {
      this.sy.target = 1; this.sx.target = 1;
      this.sy.kick(3.4 * height); this.sx.kick(-2 * height);
      this.hop.kick(-1.55 * height * (0.8 + this.p.energy * 0.25));
    });
    this.after(0.42, () => { this.sy.kick(-2.6 * height); this.sx.kick(1.8 * height); });
  }

  private celebrate() {
    this.happy.target = 1;
    this.hopNow(0.9);
    this.after(0.5, () => this.wig.kick(45));
    this.after(1.4, () => { this.happy.target = 0; });
    this.busyUntil = performance.now() / 1000 + 1.6;
  }

  private nudge() {
    if (this.mood !== 'waiting') return;
    this.hopNow(0.45);
    this.after(2.8 + this.rnd() * 2.5, () => this.nudge());
  }

  hatch(now: number) {
    this.hatchAt = now;
    this.pop.x = 1; this.pop.target = 1;
    this.shut.x = 1; this.shut.target = 1;
    this.busyUntil = now + 1.8;
    this.after(0.75, () => { this.pop.x = 0.45; this.pop.v = 0; this.pop.target = 1; this.pop.kick(5); this.wig.kick(70); });
    this.after(1.05, () => { this.shut.target = 0; this.wide.target = 1; });
    this.after(1.35, () => { this.wide.target = 0; this.doubleBlink(performance.now() / 1000); this.look(0.6, -0.2, 0.6); });
    this.after(1.75, () => { this.look(-0.6, 0, 0.6); });
    this.after(2.3, () => { this.happy.target = 1; this.look(0, 0.1, 1); this.hopNow(0.6); });
    this.after(3.2, () => { this.happy.target = 0; });
  }

  /** Picks the next thing to do. Weights follow mood and personality, so each bot has habits. */
  private act(now: number) {
    const p = this.p;
    const full = this.detail === 'full';
    const working = this.mood === 'working';
    const waiting = this.mood === 'waiting';
    const friends = [...creatures].filter((c) => c !== this && c.who !== this.who && c.visible && c.mood !== 'asleep' && Math.hypot(c.rect.cx - this.rect.cx, c.rect.cy - this.rect.cy) < 700);
    const options: [number, () => number][] = [
      // weight, action (returns how long it keeps the bot busy)
      [working ? 1 : 5 * p.curiosity, () => { this.look((this.rnd() * 2 - 1) * 0.9, (this.rnd() * 2 - 1) * 0.6, 0.6 + this.rnd() * 1.8); return 0.5; }],
      [working ? 0.5 : 1.8 * p.curiosity, () => {
        const side = this.rnd() < 0.5 ? -1 : 1;
        this.look(side * 0.85, -0.1, 0.5); this.after(0.55 + this.rnd() * 0.4, () => this.look(-side * 0.85, -0.05, 0.6)); this.after(1.4, () => this.look(0, 0, 1));
        return 1.6;
      }],
      [2 * (waiting ? 0.3 : 1), () => {
        const side = this.rnd() < 0.5 ? -1 : 1;
        this.tilt.target = side * (5 + this.rnd() * 5) * p.energy; this.look(side * 0.5, -0.2, 1.4);
        this.after(1.1 + this.rnd() * 1.3, () => { this.tilt.target = 0; });
        return 1.8;
      }],
      [1.4 * p.cheer * (working ? 0.3 : 1), () => {
        this.happy.target = 1; this.sy.kick(1.2);
        this.after(0.8 + this.rnd() * 1.1, () => { if (!this.hovered) this.happy.target = 0; });
        return 1.4;
      }],
      [full ? 0.7 * p.energy * (working ? 0.4 : 1) : 0, () => { this.hopNow(0.7 + this.rnd() * 0.4); return 0.9; }],
      [1.1 * p.energy, () => { this.wig.kick((this.rnd() < 0.5 ? -1 : 1) * (35 + this.rnd() * 30)); return 0.6; }],
      [full && !working ? 0.45 : 0, () => {
        this.sy.target = 1.1; this.sx.target = 0.93; this.happy.target = 1; this.look(0, -0.4, 0.8);
        this.after(0.75, () => { this.sy.target = 1; this.sx.target = 1; this.sx.kick(1.5); this.happy.target = 0; this.wig.kick(40); });
        return 1.5;
      }],
      [1.1 * p.curiosity * (working ? 0.4 : 1), () => {
        this.dot.target = 1; this.tilt.target = (this.rnd() - 0.5) * 9; this.look((this.rnd() * 2 - 1) * 0.8, (this.rnd() * 2 - 1) * 0.5, 1.2);
        this.after(1 + this.rnd() * 1.2, () => { this.dot.target = 0; this.tilt.target = 0; });
        return 1.8;
      }],
      [friends.length && !working ? 1.4 : 0, () => {
        const f = friends[Math.floor(this.rnd() * friends.length)];
        this.lookAt(f, 1 + this.rnd() * 1.2);
        if (this.rnd() < 0.55) f.noticed(this);
        return 1.8;
      }],
      [working ? 4 : 0, () => {
        // Reading: short hops of the eyes along a line, then back to the start of the next.
        const y = -0.1 + this.rnd() * 0.3;
        const steps = 3 + Math.floor(this.rnd() * 3);
        for (let i = 0; i < steps; i++) this.after(i * (0.22 + this.rnd() * 0.12), () => this.look(-0.75 + (1.5 * i) / (steps - 1), y, 0.4));
        this.after(steps * 0.3, () => this.look(-0.7, y + 0.15, 0.4));
        return steps * 0.3 + 0.3;
      }],
      [working ? 1.6 : 0, () => {
        this.squint.target = 0.75; this.look((this.rnd() - 0.5) * 0.4, 0.35, 1.6);
        this.after(1.4 + this.rnd(), () => { this.squint.target = 0.35; });
        return 2;
      }],
      [working && full ? 1 : working ? 0.5 : 0, () => {
        this.ball.target = 1;
        this.after(1.4 + this.rnd() * 1.6, () => { this.ball.target = 0; this.sy.kick(1.5); });
        return 3;
      }],
      [waiting ? 3 : 0, () => { this.look(0, 0.2, 2); this.after(0.2, () => this.sy.kick(1.6)); return 1.2; }],
      [working ? 0.8 : 3, () => 0.4], // a quiet spell
    ];
    let sum = 0;
    for (const [w] of options) sum += w;
    let pick = this.rnd() * sum;
    let busy = 0.5;
    for (const [w, fn] of options) { pick -= w; if (pick <= 0) { busy = fn(); break; } }
    this.busyUntil = now + busy;
    const mean = (working ? 1.3 : this.mood === 'waiting' ? 2 : 3.1) / (0.7 + p.energy * 0.3) * (this.detail === 'lite' ? 1.3 : 1);
    this.nextAct = now + busy + clamp(-Math.log(1 - this.rnd()) * mean, 0.4, mean * 3.2);
  }
}

// Dev builds expose the creatures, so moods, hatching and sleep can be checked without waiting.
if (import.meta.env.DEV) {
  (globalThis as { __cbotLife?: unknown }).__cbotLife = {
    creatures,
    /** Pretends the person has been away for `s` seconds. */
    away: (s: number) => { lastActivity -= s; },
  };
}
