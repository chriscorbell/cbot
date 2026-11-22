import { useCallback, useMemo, type CSSProperties } from 'react';
import { Plus } from 'lucide-react';
import { TASK_STATUSES, type Bot, type Task } from '@shared/types';
import { STATUS_LABEL, changedAgo, tasksByStatus } from '../../lib/tasks';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Modal } from '../modals/Modal';
import { OwnerChip, StatusIcon } from './TaskBits';

/** The team's task board: every task in a column by status, opened from the sidebar or a bot's details. */
export function TaskBoard() {
  const setModal = useStore((s) => s.setModal);
  const tasks = useStore((s) => s.tasks);
  const bots = useStore((s) => s.bots);
  const close = useCallback(() => setModal(null), [setModal]);
  const columns = useMemo(() => tasksByStatus(tasks ?? []), [tasks]);
  const open = useConfigUI((s) => s.openTaskEditor);

  return (
    <Modal onClose={close} className="task-board" label="Tasks">
      <div className="modal__header task-board__header">
        <div className="modal__title">Tasks</div>
        <button type="button" className="btn btn--sm btn--secondary task-board__new" onClick={() => open({ kind: 'new', ownerId: null })}>
          <Plus size={14} strokeWidth={2} aria-hidden />New task
        </button>
        <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
      </div>
      <div className={`task-board__cols${tasks ? '' : ' is-loading'}`}>
        {TASK_STATUSES.map((status) => (
          <section key={status} className={`task-col is-${status}`} aria-label={STATUS_LABEL[status]}>
            <div className="task-col__head">
              <StatusIcon status={status} size={14} />
              <span className="task-col__name">{STATUS_LABEL[status]}</span>
              <span className="task-col__count">{columns[status].length || ''}</span>
            </div>
            <div className="task-col__list">
              {columns[status].map((t, i) => (
                <TaskCard key={t.id} task={t} owner={bots.find((b) => b.id === t.ownerId)} index={i} onOpen={() => open({ kind: 'edit', taskId: t.id })} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}

function TaskCard({ task, owner, index, onOpen }: { task: Task; owner: Bot | undefined; index: number; onOpen: () => void }) {
  const notes = task.notes.trim().split('\n')[0];
  return (
    // A task that moves to another column mounts there anew, so it arrives with the card's entrance.
    <button type="button" className={`task-card is-${task.status}`} onClick={onOpen} style={{ '--i': Math.min(index, 8) } as CSSProperties}>
      <span className="task-card__title">{task.title}</span>
      {notes && <span className="task-card__notes">{notes}</span>}
      <span className="task-card__foot">
        <OwnerChip task={task} owner={owner} />
        <span className="task-card__when">{changedAgo(task.updatedAt)}</span>
      </span>
    </button>
  );
}
