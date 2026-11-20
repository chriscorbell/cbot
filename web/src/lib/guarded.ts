/**
 * Runs a request whose answer changes what is on screen, and hands the answer on only while
 * `stillShown()` holds when it comes back. A panel that closed, or moved on to another bot,
 * ignores the answer, its error and its end alike (see EngineSettings.tsx).
 */
export async function guarded<T>(
  stillShown: () => boolean,
  request: () => Promise<T>,
  on: { done?: (value: T) => void; failed?: (error: Error) => void; settled?: () => void },
): Promise<void> {
  try {
    const value = await request();
    if (stillShown()) on.done?.(value);
  } catch (e) {
    if (stillShown()) on.failed?.(e as Error);
  } finally {
    if (stillShown()) on.settled?.();
  }
}

/**
 * The action still out for each bot, so a panel that comes back to a bot shows it busy instead of
 * offering a second one, and an action's end only clears what that same action started.
 */
export class PendingActions<Kind> {
  private readonly byBot = new Map<string, { kind: Kind }>();

  start(botId: string, kind: Kind) {
    const action = { kind };
    this.byBot.set(botId, action);
    return action;
  }

  /** The action of this kind still out for the bot, or null. */
  kindFor(botId: string): Kind | null {
    return this.byBot.get(botId)?.kind ?? null;
  }

  /** The action has ended. True when it was still the bot's latest, so its end may clear busy. */
  end(botId: string, action: { kind: Kind }): boolean {
    if (this.byBot.get(botId) !== action) return false;
    this.byBot.delete(botId);
    return true;
  }
}
