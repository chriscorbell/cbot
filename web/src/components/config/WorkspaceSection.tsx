import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { Workspace } from '@shared/types';
import { api, type WorkspacePatch } from '../../lib/api';
import { notifyFailure } from '../../lib/uiEvents';
import { currentWorkspaceId, useStore } from '../../store';
import { useConfigUI } from '../../configStore';
import { ConfirmDialog } from '../modals/ConfirmDialog';
import { Presence } from '../Presence';
import { useToast } from '../Toast';
import { PageHead, Switch } from './ui';

/** Check-in times a workspace may have (server/src/proactive.ts MAX_CHECKIN_TIMES). */
const MAX_TIMES = 6;

/** Every time zone the browser knows, for the check-ins' zone. */
const zones = (): string[] => {
  try { return Intl.supportedValuesOf('timeZone'); } catch { return []; }
};

/** "09:00" as the browser writes times: "9:00 AM" or "09:00". */
const timeLabel = (hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
};

/**
 * Settings > Workspace: the shown workspace's name, its task board, its check-ins and deleting it.
 * Each change is saved as it is made.
 */
export function WorkspaceSection() {
  const ws = useStore((s) => s.workspaces?.find((w) => w.id === currentWorkspaceId(s)) ?? null);
  const count = useStore((s) => s.workspaces?.length ?? 0);
  if (!ws) return <PageHead title="Workspace" />;
  // Keyed, so switching workspaces with the settings open starts the fields over.
  return <WorkspacePage key={ws.id} ws={ws} only={count <= 1} />;
}

function WorkspacePage({ ws, only }: { ws: Workspace; only: boolean }) {
  const applyWorkspace = useStore((s) => s.applyWorkspace);
  const primary = useStore((s) => s.bots.find((b) => b.workspaceId === ws.id && b.isPrimary && b.kind !== 'room'));
  const [name, setName] = useState(ws.name);
  const [zone, setZone] = useState(ws.checkins.timezone);
  const [adding, setAdding] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [toast, flash] = useToast();
  const allZones = useMemo(zones, []);
  useEffect(() => setZone(ws.checkins.timezone), [ws.checkins.timezone]);

  /** Saves a change; a refusal says why and puts the field back. */
  const save = async (p: WorkspacePatch, undo?: () => void) => {
    try {
      applyWorkspace((await api.updateWorkspace(ws.id, p)).workspace);
      return true;
    } catch (e) {
      undo?.();
      notifyFailure((e as Error).message || 'Couldn’t save that. Try again.');
      return false;
    }
  };
  const saveName = () => {
    const next = name.trim();
    if (!next) { setName(ws.name); return; }
    if (next !== ws.name) void save({ name: next }, () => setName(ws.name));
  };
  const times = ws.checkins.times;
  const addTime = () => {
    if (!adding || times.includes(adding)) { setAdding(''); return; }
    void save({ checkins: { times: [...times, adding] } }).then((ok) => { if (ok) setAdding(''); });
  };
  const saveZone = () => {
    const next = zone.trim();
    if (next && next !== ws.checkins.timezone) void save({ checkins: { timezone: next } }, () => setZone(ws.checkins.timezone));
    else setZone(ws.checkins.timezone);
  };
  const checkInNow = async () => {
    try {
      await api.checkInNow(ws.id);
      flash(`${primary?.name ?? 'Your primary bot'} is checking in`, true);
    } catch (e) {
      flash((e as Error).message || 'Couldn’t start a check-in', false);
    }
  };
  const remove = async () => {
    await api.deleteWorkspace(ws.id);
    // The roster event moves the app to another workspace; settings close with this one gone.
    useConfigUI.getState().closeAppSettings();
  };

  return (
    <>
      <PageHead title="Workspace" sub="A separate team of bots, with its own primary bot, board and check-ins. Its bots don’t see the ones in your other workspaces." />
      <section className="cfg-section">
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text"><label className="cfg-row__title" htmlFor="ws-name">Name</label></div>
            <input
              id="ws-name"
              className="text-input ws-settings__name"
              value={name}
              maxLength={40}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(ws.name); } }}
            />
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Task Board</div>
              <div className="cfg-row__sub">A board where you and the bots hand out and track work. Off, the board is hidden and the bots can’t use it; its tasks wait for it to come back on.</div>
            </div>
            <Switch on={ws.taskBoard} onChange={(v) => void save({ taskBoard: v })} label="Task board" />
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Check-ins</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Check In With Me</div>
              <div className="cfg-row__sub">{primary ? `${primary.name}` : 'The primary bot'} messages you at these times when there’s something worth telling you, like a decision you owe or work that’s stuck, and stays quiet otherwise.</div>
            </div>
            <Switch on={ws.checkins.enabled} onChange={(v) => void save({ checkins: { enabled: v } })} label="Check in with me" />
          </div>
          <div className={`ws-checkins${ws.checkins.enabled ? '' : ' is-off'}`}>
            <div className="cfg-row">
              <div className="cfg-row__text"><div className="cfg-row__title">Times</div></div>
              <div className="ws-times">
                {times.map((t) => (
                  <span key={t} className="ws-time">
                    {timeLabel(t)}
                    <button type="button" className="ws-time__remove" onClick={() => void save({ checkins: { times: times.filter((x) => x !== t) } })} aria-label={`Remove ${timeLabel(t)}`} disabled={times.length <= 1}>
                      <X size={12} strokeWidth={2} aria-hidden />
                    </button>
                  </span>
                ))}
                {times.length < MAX_TIMES && (
                  <span className="ws-time-add">
                    <input type="time" className="text-input ws-time-add__input" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addTime(); }} aria-label="Add a time" />
                    <button type="button" className="cfg-btn cfg-btn--secondary" onClick={addTime} disabled={!adding}>Add</button>
                  </span>
                )}
              </div>
            </div>
            <div className="cfg-row">
              <div className="cfg-row__text"><label className="cfg-row__title" htmlFor="ws-zone">Time Zone</label></div>
              <input
                id="ws-zone"
                className="text-input ws-settings__zone"
                list="ws-zones"
                value={zone}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setZone(e.target.value)}
                onBlur={saveZone}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              />
              <datalist id="ws-zones">{allZones.map((z) => <option key={z} value={z} />)}</datalist>
            </div>
          </div>
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Check In Now</div>
              <div className="cfg-row__sub">See what a check-in looks like. {primary ? primary.name : 'The primary bot'} writes in its chat only if it has something to say.</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--secondary" onClick={() => void checkInNow()} disabled={!primary}>Check In</button>
          </div>
        </div>
      </section>

      <section className="cfg-section">
        <div className="cfg-section__label">Delete</div>
        <div className="cfg-card">
          <div className="cfg-row">
            <div className="cfg-row__text">
              <div className="cfg-row__title">Delete Workspace</div>
              <div className="cfg-row__sub">{only ? 'Your only workspace stays. Make another one first to delete this one.' : 'Deletes every bot and group chat in it, with their chats, memory, routines and files, and its board.'}</div>
            </div>
            <button type="button" className="cfg-btn cfg-btn--danger" onClick={() => setDeleting(true)} disabled={only}>Delete</button>
          </div>
        </div>
      </section>
      <Presence show={deleting}>
        <ConfirmDialog
          title={`Delete ${ws.name}?`}
          body={`Every bot and group chat in ${ws.name} is deleted with its chats, memory, routines and files, along with the workspace’s board. It can’t be undone.`}
          confirmLabel="Delete Workspace"
          busyLabel="Deleting…"
          danger
          typeToConfirm={ws.name}
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      </Presence>
      {toast}
    </>
  );
}
