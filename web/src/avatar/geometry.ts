import type { ShapeDef } from './shapes.gen';

/** Where a shape's body and eyes sit, in its viewBox units, measured once per shape. */
export interface Box { x: number; y: number; w: number; h: number; cx: number; cy: number }

/** One eye as the pill it is drawn as: its length, its width, and where it sits in the artwork. */
export interface Pill { cx: number; cy: number; len: number; wid: number }

export interface Geometry {
  body: Box;
  /** The artwork's eyes, left first, fitted to pills. */
  eyes: Pill[];
  /** Where the eyes rest when the bot looks straight ahead: the body's centre of mass. */
  face: { cx: number; cy: number };
  /** Distance between the eyes' centres. */
  gap: number;
  /** Radius of the sphere the eyes travel on. */
  r: number;
}

const cache = new Map<string, Geometry>();
let probe: SVGPathElement | null = null;

function measure(d: string): Box {
  if (!probe) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;left:-9999px;top:-9999px;visibility:hidden';
    probe = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(probe);
    document.body.appendChild(svg);
  }
  probe.setAttribute('d', d);
  const b = probe.getBBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
}

/** The points of a path made only of moves and lines (the traced eyes and most outlines). */
function points(d: string): [number, number][] | null {
  if (/[AaCcQqSsTtHhVv]/.test(d)) return null;
  const n = (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out.length > 2 ? out : null;
}

/** Fits a pill to a traced eye: its long axis from the points' spread, its extents along both axes. */
function pill(d: string): Pill {
  const pts = points(d);
  const box = measure(d);
  if (!pts) return { cx: box.cx, cy: box.cy, len: Math.max(box.w, box.h), wid: Math.min(box.w, box.h) };
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(a), uy = Math.sin(a);
  let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
  for (const [x, y] of pts) {
    const p = (x - mx) * ux + (y - my) * uy;
    const q = -(x - mx) * uy + (y - my) * ux;
    lo = Math.min(lo, p); hi = Math.max(hi, p); lo2 = Math.min(lo2, q); hi2 = Math.max(hi2, q);
  }
  return { cx: box.cx, cy: box.cy, len: hi - lo, wid: hi2 - lo2 };
}

/** The body's centre of mass, from its outline (a circle's is its centre). */
function centroid(outline: string, box: Box): { cx: number; cy: number } {
  const pts = points(outline);
  if (!pts) return { cx: box.cx, cy: box.cy };
  let a = 0, x = 0, y = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const c = x0 * y1 - x1 * y0;
    a += c; x += (x0 + x1) * c; y += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-6) return { cx: box.cx, cy: box.cy };
  return { cx: x / (3 * a), cy: y / (3 * a) };
}

/** The shape's geometry; `eyes` is the part of its path after the body outline. */
export function geometryOf(key: string, def: ShapeDef, eyes: string): Geometry {
  const hit = cache.get(key);
  if (hit) return hit;
  const body = measure(def.outline);
  const fitted = eyes.split(/(?=M)/).map((s) => s.trim()).filter(Boolean).map(pill).sort((a, b) => a.cx - b.cx);
  // Both eyes are the same pill (the artwork draws them a little unequal, which looks off once they
  // move), never thinner than about two-fifths of their length.
  const len = fitted.reduce((s, p) => s + p.len, 0) / Math.max(1, fitted.length);
  const wid = Math.max(fitted.reduce((s, p) => s + p.wid, 0) / Math.max(1, fitted.length), len * 0.42);
  const pills = fitted.map((p) => ({ ...p, len, wid }));
  const c = centroid(def.outline, body);
  const gap = Math.max(pills.length > 1 ? Math.hypot(pills[1].cx - pills[0].cx, pills[1].cy - pills[0].cy) : body.w * 0.25, wid * 2.1);
  const g: Geometry = {
    body,
    eyes: pills,
    // A touch above the centre of mass, where a face sits.
    face: { cx: c.cx, cy: c.cy - body.h * 0.02 },
    gap,
    r: Math.min(body.w, body.h) * 0.5,
  };
  cache.set(key, g);
  return g;
}
