import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Layer { el: () => HTMLElement | null; prev: HTMLElement | null; outerPrev: HTMLElement | null }

/** Open dialogs, bottom to top. Only the top one owns Tab and Escape; the ones below it are inert. */
const stack: Layer[] = [];

const layerEl = (l: Layer) => l.el()?.closest<HTMLElement>('.modal-root, .viewer') ?? l.el();

function syncInert() {
  const root = document.getElementById('root');
  root?.toggleAttribute('inert', stack.length > 0);
  stack.forEach((l, i) => layerEl(l)?.toggleAttribute('inert', i < stack.length - 1));
}

/** True when `el` belongs to the top dialog (or no dialog is open). */
export function isTopLayer(el: HTMLElement | null) {
  const top = stack[stack.length - 1];
  return !top || (!!el && !!top.el()?.contains(el)) || top.el() === el;
}

const usable = (n: HTMLElement | null) => !!n && n.isConnected && n.offsetParent !== null && !n.closest('[inert]');

/** Where focus goes when a dialog closes and the element that opened it is gone or hidden. */
function fallbackTarget(): HTMLElement | null {
  const candidates = ['.drawer-btn', '.chat__chip', '.composer__input'];
  for (const sel of candidates) {
    const n = document.querySelector<HTMLElement>(sel);
    if (usable(n)) return n;
  }
  return null;
}

/**
 * Keeps keyboard focus inside a dialog that is portaled to <body>: everything below it goes inert,
 * Tab and Shift+Tab wrap at its ends, and focus returns to its opener (or a visible stand-in) on close.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, { autoFocus = true, trap = true }: { autoFocus?: boolean; trap?: boolean } = {}) {
  // Read live so a dialog can hand Tab to something else (a remote desktop) without remounting.
  const trapRef = useRef(trap);
  trapRef.current = trap;
  // Captured during the first render: an autoFocus field inside the dialog takes focus before effects
  // run, and making the root inert blurs everything behind it.
  const prevRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const prev = prevRef.current;
    // Opened from inside another dialog that is about to close (New bot → group chat): fall back to
    // whatever opened that one.
    const outer = stack.find((l) => prev && l.el()?.contains(prev));
    const layer: Layer = { el: () => ref.current, prev, outerPrev: outer ? (outer.prev ?? outer.outerPrev) : null };
    stack.push(layer);
    syncInert();
    const t = autoFocus ? setTimeout(() => {
      const el = ref.current;
      if (!el || el.contains(document.activeElement)) return;
      // Prefer the dialog's own starting point, then the current section, and never the close button.
      const pick = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
        ?? el.querySelector<HTMLElement>('[aria-current="true"], [aria-current="page"], [aria-selected="true"]')
        ?? Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).find((n) => !n.matches('.modal__close, .viewer__close'));
      pick?.focus({ preventScroll: true });
    }) : undefined;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current || !trapRef.current || stack[stack.length - 1] !== layer) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', key);
      const i = stack.indexOf(layer);
      if (i >= 0) stack.splice(i, 1);
      syncInert();
      const back = [layer.prev, layer.outerPrev].find(usable) ?? fallbackTarget();
      back?.focus({ preventScroll: true });
    };
  }, [ref, autoFocus]);
}

/** Wraps Tab inside `el` (for overlays that are not portaled dialogs: the phone drawer, the details sheet). */
export function trapTabWithin(el: HTMLElement | null): () => void {
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !el || stack.length) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const inside = el.contains(document.activeElement);
    if (e.shiftKey && (document.activeElement === first || !inside)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !inside)) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', key);
  return () => document.removeEventListener('keydown', key);
}
