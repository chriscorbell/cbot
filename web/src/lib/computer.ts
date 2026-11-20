import type { ComputerState } from '@shared/types';

export function computerStatusText(c: ComputerState | null): string {
  if (!c) return 'Checking…';
  return c.status === 'error' ? 'Unreachable' : 'Running';
}

/** Every bot's screen is 1440x900 unless the server says otherwise (server/src/displays.ts). */
export const DEFAULT_SCREEN = { width: 1440, height: 900 };

/** Pixel size of a bot's screen, for the viewer's aspect ratio. Before the server reports one, assume the usual size so the frame does not change shape when the screen appears. */
export function screenSize(c: ComputerState | null, botId: string): { width: number; height: number } {
  const s = c?.screens.find((x) => x.botId === botId);
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  return s && ok(s.width) && ok(s.height) ? { width: s.width, height: s.height } : DEFAULT_SCREEN;
}
