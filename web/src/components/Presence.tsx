import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const Exiting = createContext(false);

/** True while the surrounding <Presence> is playing its exit animation. */
export const useExiting = () => useContext(Exiting);

/**
 * Keeps its children mounted for `ms` after `show` turns false, so they can animate out.
 * Children read useExiting() and add an `is-exiting` class.
 */
export function Presence({ show, ms = 160, children }: { show: boolean; ms?: number; children: ReactNode }) {
  const [mounted, setMounted] = useState(show);
  useEffect(() => {
    if (show) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [show, ms]);
  if (!show && !mounted) return null;
  return <Exiting.Provider value={!show}>{children}</Exiting.Provider>;
}

/** The last non-null value, so a closing dialog can keep showing what it showed while it animates out. */
export function useLastValue<T>(v: T | null | undefined): T | null {
  const r = useRef<T | null>(v ?? null);
  if (v != null) r.current = v;
  return r.current;
}
