/**
 * Requests between parts of the UI that share no parent, such as "put this in the composer". Each
 * name has a typed detail; add new ones to UiEvents. Server data never travels this way (that is
 * the store's job).
 */
import type { ReplyRef } from './reply';

interface UiEvents {
  /** Reply to a message or answer a question in your own words: the composer shows the quote. */
  reply: ReplyRef;
  /** Put text in the composer and focus it. */
  compose: { text: string };
  /** Ask for a new chat; the chat view confirms it. */
  fresh: null;
  /** Something the user did, or a refresh, failed with no place of its own to say so: a toast says it (Notices in Toast.tsx). */
  notice: { text: string };
}

/** Says that something failed, in a toast at the bottom of the window. */
export const notifyFailure = (text: string) => emitUi('notice', { text });

export function emitUi<K extends keyof UiEvents>(name: K, detail: UiEvents[K]) {
  window.dispatchEvent(new CustomEvent(`dispatch:${name}`, { detail }));
}

/** Listen for a UI request; returns the function that stops listening (an effect's cleanup). */
export function onUi<K extends keyof UiEvents>(name: K, handler: (detail: UiEvents[K]) => void): () => void {
  const h = (e: Event) => handler((e as CustomEvent<UiEvents[K]>).detail);
  window.addEventListener(`dispatch:${name}`, h);
  return () => window.removeEventListener(`dispatch:${name}`, h);
}
