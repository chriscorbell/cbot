import { expect, test, vi } from 'vitest';
import { openPrompts, runEvent, startedRun, stoppedStatus } from '../src/agent/run-events.js';

test('a run event is checked where it enters, and one that is not shaped as expected is ignored, not cast', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(runEvent({ event: 'message.delta', delta: 'Hi' })).toEqual({ event: 'message.delta', delta: 'Hi' });
  // A delta that isn't text is logged and ignored; the run goes on.
  expect(runEvent({ event: 'message.delta', delta: 5 })).toEqual({ event: 'other', name: 'message.delta' });
  expect(warn).toHaveBeenCalledTimes(1);
  // An event Dispatch doesn't know passes as `other`, quietly.
  expect(runEvent({ event: 'run.queued' })).toEqual({ event: 'other', name: 'run.queued' });
  // The end of a run needs nothing but its name, so a run never waits on a malformed one.
  expect(runEvent({ event: 'run.completed' })).toEqual({ event: 'run.completed' });
  expect(runEvent({ event: 'run.failed', error: { code: 1 } })).toEqual({ event: 'run.failed', error: { code: 1 } });
  // Data with no event name is skipped.
  expect(runEvent('[DONE]')).toBeNull();
  expect(runEvent({ type: 'x' })).toBeNull();
  warn.mockRestore();
});

test("a run's start, stop and status answers are read only when they say what they should", () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(startedRun({ run_id: 'run_1' })).toBe('run_1');
  expect(startedRun({ run_id: 7 })).toBeNull();
  expect(startedRun(null)).toBeNull();
  expect(stoppedStatus({ status: 'cancelled' })).toBe('cancelled');
  expect(stoppedStatus({})).toBe('');
  expect(openPrompts({ pending_controls: [{ prompt_id: 'p1' }, { prompt_id: null }] })).toEqual(new Set(['p1']));
  // No list means nothing is open; a list that can't be read means nobody knows, so nothing expires.
  expect(openPrompts({})).toEqual(new Set());
  expect(openPrompts({ pending_controls: 'p1' })).toBeNull();
  warn.mockRestore();
});
