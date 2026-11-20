import type { Row } from '@shared/types';

/** What the composer is replying to: a row, named by its chat (generation) and place in it. */
export interface ReplyRef { text: string; seq: number; generation: number }

/**
 * What sending with a reply does. It answers the question it quotes only if that question is still
 * open in the same chat and no files go with it; otherwise the text goes as a message under a quote.
 * A seq reused by a newer chat never makes a reply answer a different question.
 */
export function replyAction(reply: ReplyRef, rows: Row[], withFiles: boolean): { kind: 'answer'; seq: number; generation: number } | { kind: 'quote'; message: (text: string) => string } {
  const row = rows.find((r) => r.seq === reply.seq && r.generation === reply.generation);
  const b = row?.body;
  if (!withFiles && b?.type === 'card' && b.card === 'question' && b.status === 'pending') return { kind: 'answer', seq: reply.seq, generation: reply.generation };
  return { kind: 'quote', message: (text) => `${reply.text.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${text}` };
}
