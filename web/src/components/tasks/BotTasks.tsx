import { useMemo } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import type { Bot } from '@shared/types';
import { STATUS_LABEL, changedAgo, creatorText, plateOf } from '../../lib/tasks';
import { useConfigUI } from '../../configStore';
import { useStore } from '../../store';
import { StatusIcon } from './TaskBits';

/**
 * A bot's tasks in its details panel: what it is doing, what holds it up and what waits, with a way to
 * give it another and to see the whole board. Both open over the panel, as its other settings do.
 */
export function BotTasks({ bot }: { bot: Bot }) {
  const tasks = useStore((s) => s.tasks);
  const plate = useMemo(() => plateOf(tasks ?? [], bot.id), [tasks, bot.id]);
  const openEditor = useConfigUI((s) => s.openTaskEditor);
  if (!tasks) return null;
  return (
    <section>
      <div className="section-label section-label--row">
        <span>Tasks</span>
        <button type="button" className="link-btn link-btn--small" onClick={() => useStore.getState().setModal('tasks')}>All</button>
      </div>
      <div className="panel-card">
        {plate.map((t) => (
          <button key={t.id} type="button" className={`panel-row panel-row--action panel-row--task is-${t.status}`} onClick={() => openEditor({ kind: 'edit', taskId: t.id })} title={t.notes || undefined}>
            <span className="panel-row__icon"><StatusIcon status={t.status} /></span>
            <span className="panel-row__text">
              <span className="panel-row__title">{t.title}</span>
              <span className="panel-row__sub">{STATUS_LABEL[t.status]} · {creatorText(t)} · {changedAgo(t.updatedAt)}</span>
            </span>
          </button>
        ))}
        <button type="button" className="panel-row panel-row--action" onClick={() => openEditor({ kind: 'new', ownerId: bot.id })}>
          <span className="panel-row__icon"><Plus size={15} strokeWidth={1.75} aria-hidden /></span>
          <span className="panel-row__title">Add a task</span>
          <ChevronRight className="panel-row__chev" size={14} strokeWidth={2} aria-hidden />
        </button>
      </div>
    </section>
  );
}
