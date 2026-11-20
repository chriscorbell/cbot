import type { KeyboardEvent } from 'react';

/**
 * Arrow-key movement for a radio group or tab list: one Tab stop for the group, arrows move and
 * select. Put it on the container; options are its [role=radio] or [role=tab] descendants.
 */
export function onRovingKeyDown(e: KeyboardEvent<HTMLElement>) {
  const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled), [role="tab"]:not(:disabled)'));
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (i < 0 || !items.length) return;
  e.preventDefault();
  const n = items.length;
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : n - 1)) % n;
  items[next].focus();
  items[next].click();
}

/** Only the selected option is a Tab stop. */
export const rovingTab = (selected: boolean) => (selected ? 0 : -1);
