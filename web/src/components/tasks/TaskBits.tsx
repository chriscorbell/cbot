import { Circle, CircleCheck, CircleDot, CircleSlash } from 'lucide-react';
import type { Bot, Task, TaskStatus } from '@shared/types';
import { BotAvatarFor } from '../../avatar/BotAvatar';

const STATUS_ICON = { todo: Circle, doing: CircleDot, blocked: CircleSlash, done: CircleCheck } as const;

/** A task's status as a glyph, tinted by status (tasks.css). */
export function StatusIcon({ status, size = 15 }: { status: TaskStatus; size?: number }) {
  const I = STATUS_ICON[status];
  return <span className={`task-status is-${status}`} aria-hidden><I size={size} strokeWidth={1.9} /></span>;
}

/** Whose task it is: the bot's avatar and name, or "Unassigned" (and whose it was, when its bot was removed). */
export function OwnerChip({ task, owner }: { task: Pick<Task, 'ownerId' | 'previousOwner'>; owner: Bot | undefined }) {
  if (owner) {
    return (
      <span className="task-owner">
        <BotAvatarFor bot={owner} size={16} life="off" />
        <span className="task-owner__name">{owner.name}</span>
      </span>
    );
  }
  return (
    <span className="task-owner is-none">
      <span className="task-owner__name">{task.previousOwner ? `Unassigned · was ${task.previousOwner}’s` : 'Unassigned'}</span>
    </span>
  );
}
