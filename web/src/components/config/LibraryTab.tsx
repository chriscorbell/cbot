import { useCallback, useEffect, useRef, useState } from 'react';
import type { Bot, LibraryFile } from '@shared/types';
import { configApi, type LibraryListing } from '../../lib/configApi';
import { relativeShort } from '../../lib/time';
import { Icon } from '../Icon';
import { Glyph } from './glyphs';
import { formatBytes } from './ui';
import { useConfigUI } from '../../configStore';
import { folderOf, glow } from '../../lib/glow';
import { FilePreview, type PreviewFile } from '../FilePreview';

/** Files the bot saved under /root/dispatch/files/<botId> on its computer. */
export function LibraryTab({ bot }: { bot: Bot }) {
  const [path, setPath] = useState('');
  const [list, setList] = useState<LibraryListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewFile | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  // Only the listing of the folder shown now may land: a slower answer for the folder before it is dropped.
  const shownRef = useRef({ botId: bot.id, path });
  shownRef.current = { botId: bot.id, path };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const listing = await configApi.files(bot.id, path);
      if (shownRef.current.botId === bot.id && shownRef.current.path === path) setList(listing);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(false); }
  }, [bot.id, path]);

  useEffect(() => { setPath(''); setList(null); setPreview(null); }, [bot.id]);
  // A search result for a file here: open its folder, then make the file glow once it is listed.
  const jump = useConfigUI((s) => (s.jump?.kind === 'file' && s.jump.botId === bot.id ? s.jump : null));
  useEffect(() => { if (jump?.kind === 'file') setPath(folderOf(jump.path)); }, [jump]);
  useEffect(() => { void load(); }, [load]); // load shows a failure in `error`, so it never rejects
  useEffect(() => {
    if (jump?.kind !== 'file' || loading || !list || list.path !== folderOf(jump.path)) return;
    const name = jump.path.split('/').pop()!;
    const node = rootRef.current?.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`);
    if (node) { node.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); glow(node); }
    useConfigUI.getState().clearJump(jump);
  }, [jump, list, loading]);

  const download = async (f: LibraryFile) => {
    const rel = path ? `${path}/${f.name}` : f.name;
    setBusyFile(f.name); setError(null);
    try {
      const { url } = await configApi.downloadFile(bot.id, rel);
      const a = document.createElement('a');
      a.href = url; a.download = f.name; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { setError(`Couldn’t download ${f.name}: ${(e as Error).message}`); }
    finally { setBusyFile(null); }
  };

  const crumbs = path ? path.split('/') : [];

  return (
    <div className="details__sections" ref={rootRef}>
      <section>
        <div className="section-label section-label--row">
          <span className="lib-crumbs">
            {crumbs.length ? (
              <>
                <button type="button" className="link-btn link-btn--small" onClick={() => setPath('')}>Files</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="lib-crumbs__part">
                    <Icon name="chev_right" size={8} />
                    <button type="button" className="link-btn link-btn--small" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  </span>
                ))}
              </>
            ) : 'Files'}
          </span>
          <button type="button" className="link-btn link-btn--small" onClick={() => load()} disabled={loading} aria-label="Refresh files" title="Refresh">
            <Icon name="refresh" size={12} style={loading ? { animation: 'cfg-spin 0.8s linear infinite' } : undefined} />
          </button>
        </div>
        <div className="panel-card">
          {!list && loading ? (
            <div className="panel-empty">Looking for files…</div>
          ) : list?.status === 'error' ? (
            <div className="panel-empty">Couldn’t reach the computer. {list.error ? <span className="lib-err">{list.error}</span> : null}</div>
          ) : !list?.files.length ? (
            <div className="panel-empty panel-empty--center">{path ? 'This folder is empty.' : `Files that ${bot.name} creates, like reports and notes, are kept here.`}</div>
          ) : (
            list.files.map((f) => (
              <div key={f.name} className={`lib-row${f.isDir ? ' is-dir' : ''}`} data-name={f.name}>
                <button type="button" className="lib-row__main" onClick={() => (f.isDir ? setPath(path ? `${path}/${f.name}` : f.name) : setPreview({ botId: bot.id, path: path ? `${path}/${f.name}` : f.name, name: f.name, size: f.size, modifiedAt: f.modifiedAt }))} title={`Open ${f.name}`}>
                  <span className="lib-row__icon"><Glyph name={f.isDir ? 'folder' : 'doc'} size={16} /></span>
                  <span className="panel-row__text">
                    <span className="panel-row__title">{f.name}</span>
                    <span className="panel-row__meta">{f.isDir ? 'Folder' : formatBytes(f.size)} · {relativeShort(f.modifiedAt) === 'now' ? 'just now' : relativeShort(f.modifiedAt)}</span>
                  </span>
                </button>
                {f.isDir ? <Icon name="chev_right" size={12} /> : (
                  <button type="button" className="cfg-icon-btn" onClick={() => download(f)} disabled={busyFile === f.name} aria-label={`Download ${f.name}`} title="Download">
                    {busyFile === f.name ? <span className="cfg-spinner" /> : <Glyph name="download" size={14} />}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
        {error && <div className="cfg-error cfg-error--small">{error}</div>}
      </section>
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </div>
  );
}
