import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CircleAlert } from 'lucide-react';

type Note = { text: string; ok: boolean };

/**
 * A short confirmation at the bottom of the window ("Copied the conversation"). Any component can
 * show one: render the node, call flash. It is portalled to the body, because a transformed ancestor
 * (the rail as a drawer) would otherwise pin it inside. A failure gets an alert mark, not a check.
 */
export function useToast() {
  const [note, setNote] = useState<Note | null>(null);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!note) return;
    setLeaving(false);
    const a = setTimeout(() => setLeaving(true), 2200);
    const b = setTimeout(() => setNote(null), 2400);
    return () => { clearTimeout(a); clearTimeout(b); };
  }, [note]);
  const node = note ? createPortal(
    <div className={`toast${note.ok ? '' : ' is-error'}${leaving ? ' is-exiting' : ''}`} role="status">
      {note.ok ? <Check size={15} strokeWidth={2.25} aria-hidden /> : <CircleAlert size={15} strokeWidth={2} aria-hidden />}
      {note.text}
    </div>,
    document.body,
  ) : null;
  const flash = (text: string, ok = true) => setNote({ text, ok });
  return [node, flash] as const;
}
