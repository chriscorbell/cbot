import { useRef } from 'react';
import type React from 'react';

/**
 * Touch screens have no hover and no right-click: holding a finger still on an element for a moment
 * calls `onLongPress` with where the finger is. The tap that ends the hold does nothing else, and a
 * finger that moves (a scroll) cancels it. Mice and pens are left alone.
 */
export function useLongPress(onLongPress: (x: number, y: number) => void, ms = 420) {
  const latest = useRef(onLongPress);
  latest.current = onLongPress;
  const timer = useRef<number | null>(null);
  const start = useRef({ x: 0, y: 0 });
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        latest.current(start.current.x, start.current.y);
      }, ms);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (timer.current !== null && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    // Android opens the browser's own menu on a long press; the hold already did what it should.
    onContextMenu: (e: React.MouseEvent) => {
      if (fired.current || timer.current !== null) e.preventDefault();
    },
  };
}
