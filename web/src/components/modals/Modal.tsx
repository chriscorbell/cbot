import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useExiting } from '../Presence';
import { isTopLayer, useDialogFocus } from '../../lib/focus';

/** 50% black scrim + centered dialog. Escape and scrim click close. Focus is trapped loosely (restored on close). */
export function Modal({ onClose, children, className, label, top }: { onClose: () => void; children: ReactNode; className?: string; label: string; top?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const exiting = useExiting();
  useDialogFocus(ref);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Only the top dialog closes; an open dropdown takes its Escape before this sees it.
      if (!isTopLayer(ref.current)) return;
      e.preventDefault(); onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className={`modal-root${exiting ? ' is-exiting' : ''}`}>
      <div className="modal-scrim" onMouseDown={onClose} />
      <div ref={ref} className={`modal ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={label} style={top !== undefined ? { marginTop: top } : undefined}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
