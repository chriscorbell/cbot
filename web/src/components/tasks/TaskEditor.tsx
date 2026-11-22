import { useCallback, useState } from 'react';
import { TASK_STATUSES, type TaskStatus } from '@shared/types';
import { api, type TaskPatch } from '../../lib/api';
import { guarded } from '../../lib/guarded';
import { STATUS_LABEL, changedAgo, creatorText } from '../../lib/tasks';
import { useConfigUI, type TaskEditorTarget } from '../../configStore';
import { useStore } from '../../store';
import { Icon } from '../Icon';
import { Presence, useLastValue } from '../Presence';
import { Select, type SelectOption } from '../Select';
import { ConfirmDialog } from '../modals/ConfirmDialog';
import { Modal } from '../modals/Modal';

const STATUS_OPTIONS: SelectOption<TaskStatus>[] = TASK_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }));

/** The task editor over the app, for whichever task or new task configStore names. It keeps showing the last one while it animates out. */
export function TaskEditor() {
  const target = useLastValue(useConfigUI((s) => s.taskEditor));
  if (!target) return null;
  // A fresh form for each task opened.
  return <TaskForm key={target.kind === 'edit' ? target.taskId : `new:${target.ownerId ?? ''}`} target={target} />;
}

function TaskForm({ target }: { target: TaskEditorTarget }) {
  const close = useConfigUI((s) => s.closeTaskEditor);
  const bots = useStore((s) => s.bots).filter((b) => b.kind !== 'room');
  const task = useStore((s) => (target.kind === 'edit' ? s.tasks?.find((t) => t.id === target.taskId) : undefined));
  const loaded = useStore((s) => s.tasks !== null);
  // What the form started from. A save sends only what the user changed, so a bot's change to another
  // field meanwhile (it marked the task done) stays.
  const [start] = useState(() => ({
    title: task?.title ?? '',
    notes: task?.notes ?? '',
    ownerId: target.kind === 'edit' ? task?.ownerId ?? '' : target.ownerId ?? '',
    status: task?.status ?? ('todo' as TaskStatus),
  }));
  const [draft, setDraft] = useState(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const gone = target.kind === 'edit' && loaded && !task;
  const isNew = target.kind === 'new';
  const canSave = !!draft.title.trim() && !busy && !gone;
  // The answer counts only while this same editor is open.
  const stillShown = useCallback(() => useConfigUI.getState().taskEditor === target, [target]);

  const ownerOptions: SelectOption<string>[] = [
    { value: '', label: 'Unassigned' },
    ...bots.map((b) => ({ value: b.id, label: b.name, hint: b.label || undefined })),
  ];

  const save = () => {
    if (!canSave) return;
    setBusy(true); setError(null);
    const ownerId = draft.ownerId || null;
    const request = () => {
      if (target.kind === 'new') return api.addTask({ title: draft.title.trim(), notes: draft.notes.trim(), ownerId, status: draft.status });
      const patch: TaskPatch = {};
      if (draft.title.trim() !== start.title) patch.title = draft.title.trim();
      if (draft.notes.trim() !== start.notes.trim()) patch.notes = draft.notes.trim();
      if (draft.ownerId !== start.ownerId) patch.ownerId = ownerId;
      if (draft.status !== start.status) patch.status = draft.status;
      if (!Object.keys(patch).length) return Promise.resolve(null);
      return api.updateTask(target.taskId, patch);
    };
    void guarded(stillShown, request, {
      done: (r) => { if (r) useStore.getState().applyTask(r.task); close(); },
      failed: (e) => { setError(e.message || 'Couldn’t save the task.'); setBusy(false); },
    });
  };

  const remove = async () => {
    if (target.kind !== 'edit') return;
    await api.deleteTask(target.taskId);
    useStore.getState().removeTask(target.taskId);
    if (stillShown()) close();
  };

  const owner = draft.ownerId ? bots.find((b) => b.id === draft.ownerId) : undefined;
  // A bot given the task is told at once and starts on it (server/src/agent/team.ts).
  const wakes = !!owner && (isNew || draft.ownerId !== start.ownerId) && draft.status !== 'done';

  return (
    <Modal onClose={close} className="task-editor" label={isNew ? 'New task' : 'Edit task'}>
      <form onSubmit={(e) => { e.preventDefault(); save(); }}>
        <div className="modal__header">
          <div className="modal__title">{isNew ? 'New task' : 'Task'}</div>
          <button type="button" className="modal__close" onClick={close} aria-label="Close"><Icon name="close" size={16} /></button>
        </div>
        <div className="task-editor__body">
          <input
            className="text-input task-editor__title"
            placeholder="What needs doing"
            autoComplete="off"
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            aria-label="Title"
            maxLength={200}
            autoFocus
          />
          <textarea
            className="text-input task-editor__notes"
            placeholder="Notes"
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
            aria-label="Notes"
            rows={5}
          />
          <div className="task-editor__fields">
            <div className="task-editor__field">
              <span className="field-label">Owner</span>
              <Select label="Owner" value={draft.ownerId} options={ownerOptions} onChange={(ownerId) => setDraft({ ...draft, ownerId })} />
            </div>
            <div className="task-editor__field">
              <span className="field-label">Status</span>
              <Select label="Status" value={draft.status} options={STATUS_OPTIONS} onChange={(status) => setDraft({ ...draft, status })} />
            </div>
          </div>
          {wakes && owner && <div className="task-editor__note">{owner.name} is told and starts on it.</div>}
          {task && (
            <div className="task-editor__meta">
              Added {creatorText(task)} · changed {changedAgo(task.updatedAt)}
              {task.previousOwner && !task.ownerId ? ` · was ${task.previousOwner}’s` : ''}
            </div>
          )}
          {gone && <div className="form-error" role="alert">This task is no longer on the board.</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
        <div className="modal__footer">
          {!isNew && !gone && (
            <button type="button" className="link-btn task-editor__delete" onClick={() => setConfirmDelete(true)} disabled={busy}>Delete</button>
          )}
          <button type="button" className="btn btn--ghost" onClick={close}>Cancel</button>
          <button type="submit" className="btn btn--primary" disabled={!canSave}>{busy ? 'Saving…' : isNew ? 'Add task' : 'Save'}</button>
        </div>
      </form>
      <Presence show={confirmDelete}>
        <ConfirmDialog
          title="Delete this task?"
          body={`“${draft.title.trim() || start.title}” comes off the board. It can’t be undone.`}
          confirmLabel="Delete"
          busyLabel="Deleting…"
          danger
          focusCancel
          onConfirm={remove}
          onClose={() => setConfirmDelete(false)}
        />
      </Presence>
    </Modal>
  );
}
