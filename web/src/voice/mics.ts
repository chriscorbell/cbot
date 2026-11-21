import { useEffect, useState } from 'react';

/**
 * Microphones the browser can see, kept up to date as they are plugged in and out. Their names only
 * show once the page has been allowed to use one (during a call they always have). Chrome's own
 * "default" entry is left out: System Default stands for it.
 */
export function useMics() {
  const [mics, setMics] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md?.enumerateDevices) return;
    let alive = true;
    const load = () => md.enumerateDevices()
      .then((all) => { if (alive) setMics(all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }))); })
      .catch(() => {});
    void load(); // load catches its own failure
    md.addEventListener?.('devicechange', load);
    return () => { alive = false; md.removeEventListener?.('devicechange', load); };
  }, []);
  return mics;
}
