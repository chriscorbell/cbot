import { Fragment, useEffect, useRef, type ReactNode } from 'react';
import { useExiting } from './Presence';

export interface MenuItem { label: string; onSelect: () => void; danger?: boolean; hint?: string; icon?: ReactNode; separatorBefore?: boolean }

/** Small popover menu anchored by its parent (position: relative). Closes on outside click / Escape. */
export function Menu({ items, onClose, align = 'left', placement = 'below', children }: { items: MenuItem[]; onClose: () => void; align?: 'left' | 'right' | 'center'; placement?: 'below' | 'above'; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useExiting();
  // The button that opened the menu; focus goes back to it so a keyboard user keeps their place.
  const trigger = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); trigger.current?.focus(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[next].focus();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', down));
    document.addEventListener('keydown', key, true);
    return () => { clearTimeout(t); document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [onClose]);
  return (
    <div ref={ref} className={`menu is-${align} is-${placement}${exiting ? ' is-exiting' : ''}`} role="menu">
      {children}
      {items.map((it) => (
        <Fragment key={it.label}>
          {it.separatorBefore && <div className="menu__sep" role="separator" />}
          <button type="button" role="menuitem" className={`menu__item${it.danger ? ' is-danger' : ''}`} onClick={() => { trigger.current?.focus({ preventScroll: true }); onClose(); it.onSelect(); }}>
            <span className="menu__item-main">{it.icon}<span>{it.label}</span></span>
            {it.hint && <span className="menu__hint">{it.hint}</span>}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
