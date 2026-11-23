import { isTeammateMessage, type Bot, type Row } from '@shared/types';
import { api } from './api';
import { clock } from './time';
import { sortedRows, useStore } from '../store';

/** The conversation as Markdown: who said what, oldest first, with the day and time of each message. Teammates' messages to the bot aren't part of it. */
export function conversationMarkdown(bot: Bot, rows: Row[]): string {
  const out: string[] = [`# ${bot.name}`];
  let day = '';
  for (const r of rows) {
    const b = r.body;
    if (b.type !== 'message' || !b.text?.trim() || isTeammateMessage(b)) continue;
    const d = new Date(r.createdAt).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (d !== day) { out.push(`## ${d}`); day = d; }
    const who = b.role === 'user' ? (b.from && b.from.kind !== 'voice' ? b.from.name : 'You') : b.from?.name ?? bot.name;
    out.push(`**${who}** · ${clock(r.createdAt)}\n\n${b.text.trim()}`);
  }
  return out.join('\n\n') + '\n';
}

/**
 * Copies a bot's conversation as Markdown (the rail's "Copy Conversation"). An open chat's rows are
 * already loaded; any other bot's are fetched. The text goes to the clipboard as a promise, so the
 * copy still counts as part of the click that asked for it while the rows load; browsers that don't
 * take a promise get the text once it is ready.
 */
export async function copyConversation(bot: Bot): Promise<void> {
  let text: Promise<string> | null = null;
  const markdown = () => (text ??= (async () => {
    const loaded = useStore.getState().transcripts[bot.id];
    const rows = loaded?.loaded ? sortedRows(loaded) : [...(await api.rows(bot.id)).rows].sort((a, b) => a.seq - b.seq);
    return conversationMarkdown(bot, rows);
  })());
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': markdown().then((t) => new Blob([t], { type: 'text/plain' })) })]);
  } catch {
    await navigator.clipboard.writeText(await markdown());
  }
}
