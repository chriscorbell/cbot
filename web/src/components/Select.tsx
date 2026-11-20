import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { edgeIndex, matchIndex, stepIndex } from '../lib/listnav';
import { Icon } from './Icon';
import { Presence, useExiting } from './Presence';

export interface SelectOption<T> {
  value: T;
  label: string;
  /** Quiet text at the right of the option, such as "Not connected". */
  hint?: string;
  title?: string;
  /** Options with a group are listed under it, in the order the groups first appear. */
  group?: string;
  disabled?: boolean;
}

/**
 * A compact value with a chevron that opens the app's own menu of options, in place of the system's
 * dropdown. The list is portaled to <body>, so a scrolling panel or a dialog can't clip it; a dialog
 * or popover that closes on outside clicks lets clicks on `.select-pop` through (see VoicePicker).
 */
export function Select<T extends string | number>({ label, value, options, onChange, disabled, className = '', display }: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
  /** What the closed control shows, when it isn't the option's label. */
  display?: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);
  const shown = display ?? current?.label ?? String(value);
  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }, []);
  const off = disabled || !options.length;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`mini-select${open ? ' is-open' : ''} ${className}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${shown}`}
        title={current?.title}
        disabled={off}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true); } }}
      >
        <span className="mini-select__value">{shown}</span>
        <Icon name="chev_down" size={10} />
      </button>
      <Presence show={open} ms={110}>
        <SelectList label={label} value={value} options={options} anchor={trigger} onPick={(v) => { close(); if (v !== value) onChange(v); }} onClose={close} />
      </Presence>
    </>
  );
}

function SelectList<T extends string | number>({ label, value, options, anchor, onPick, onClose }: {
  label: string;
  value: T;
  options: SelectOption<T>[];
  anchor: React.RefObject<HTMLButtonElement | null>;
  onPick: (v: T) => void;
  onClose: (refocus?: boolean) => void;
}) {
  const exiting = useExiting();
  const pop = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const typed = useRef({ q: '', at: 0 });
  // Transparent, not hidden, while it measures itself: a hidden option can't take focus.
  const [pos, setPos] = useState<CSSProperties>({ opacity: 0 });
  const disabled = options.map((o) => !!o.disabled);
  // The key handler reads these live, so it doesn't have to be added again on every render.
  const live = useRef({ options, disabled });
  live.current = { options, disabled };

  // Below the control, or above it when there isn't room; the right edges line up.
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? 0;
    if (!a) return;
    const below = window.innerHeight - a.bottom - 12, above = a.top - 12;
    const down = h <= below || below >= above;
    setPos({
      right: Math.max(8, window.innerWidth - a.right),
      minWidth: Math.max(a.width, 180),
      maxHeight: Math.max(120, down ? below : above),
      ...(down ? { top: a.bottom + 6 } : { bottom: window.innerHeight - a.top + 6 }),
    });
    // The anchor doesn't move while the list is open: scrolling or resizing closes it.
  }, [anchor]);

  // Focus starts on the current option.
  useEffect(() => {
    const i = options.findIndex((o) => o.value === value);
    items.current[i >= 0 && !disabled[i] ? i : edgeIndex(disabled, 'first')]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (exiting) return;
    const inside = (t: EventTarget | null) => t instanceof Node && (pop.current?.contains(t) || anchor.current?.contains(t));
    const down = (e: PointerEvent) => { if (!inside(e.target)) onClose(false); };
    const scroll = (e: Event) => { if (!(e.target instanceof Node && pop.current?.contains(e.target))) onClose(false); };
    const away = () => onClose(false);
    const key = (e: KeyboardEvent) => {
      if (!pop.current?.contains(document.activeElement)) return;
      const { options, disabled } = live.current;
      const at = items.current.indexOf(document.activeElement as HTMLButtonElement);
      const go = (i: number) => { if (i >= 0) items.current[i]?.focus({ preventScroll: true }); };
      // Window capture runs before any dialog or popover listening on the document, so Escape and
      // Tab close only this list.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); go(stepIndex(disabled, at < 0 ? -1 : at, e.key === 'ArrowDown' ? 1 : -1)); return; }
      if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); go(edgeIndex(disabled, e.key === 'Home' ? 'first' : 'last')); return; }
      if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const now = Date.now();
        typed.current = { q: now - typed.current.at < 700 ? typed.current.q + e.key : e.key, at: now };
        go(matchIndex(options.map((o) => o.label), disabled, at, typed.current.q));
      }
    };
    document.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, [anchor, exiting, onClose]);

  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  return createPortal(
    <div className="select-pop" style={pos}>
      <div ref={pop} className={`menu select-menu${exiting ? ' is-exiting' : ''}`} role="listbox" aria-label={label} style={{ maxHeight: pos.maxHeight }}>
        {groups.map((g) => (
          <Fragment key={g || '_'}>
            {g && <div className="menu__header" role="presentation">{g}</div>}
            {options.filter((o) => (o.group ?? '') === g).map((o) => {
              const on = o.value === value;
              return (
                <button
                  key={String(o.value)}
                  ref={(el) => { items.current[options.indexOf(o)] = el; }}
                  type="button"
                  role="option"
                  aria-selected={on}
                  disabled={o.disabled}
                  title={o.title}
                  className={`menu__item select-menu__item${on ? ' is-selected' : ''}`}
                  onClick={() => onPick(o.value)}
                >
                  <span className="menu__item-main"><span className="select-menu__label">{o.label}</span></span>
                  <span className="select-menu__end">
                    {o.hint && <span className="menu__hint">{o.hint}</span>}
                    <span className="select-menu__check" aria-hidden>{on && <Icon name="check" size={14} />}</span>
                  </span>
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>,
    document.body,
  );
}
