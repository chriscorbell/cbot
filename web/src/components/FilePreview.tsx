import { useEffect, useState } from 'react';
import { configApi } from '../lib/configApi';
import { fileUrl, isBinary, previewKind, TEXT_LIMIT } from '../lib/files';
import { relativeShort } from '../lib/time';
import { Modal } from './modals/Modal';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { Glyph } from './config/glyphs';
import { formatBytes } from './config/ui';

/** A file in a bot's Library (or a group's folder), as the Library tab or a chat attachment knows it. */
export interface PreviewFile { botId: string; path: string; name: string; size: number; modifiedAt?: number }

type Read =
  | { status: 'loading' }
  | { status: 'text'; text: string; truncated: boolean }
  | { status: 'svg'; url: string }
  | { status: 'none'; why: string };

/**
 * A Library file shown in place: pictures, PDFs, audio and video from the server as they are; text,
 * Markdown and SVG read here first. HTML and SVG never load at the app's own address, where their
 * script would run as the app: HTML shows as source, and SVG as a picture, which runs no script.
 */
export function FilePreview({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const kind = previewKind(file.name);
  const inline = fileUrl(file.botId, file.path, true);
  const [read, setRead] = useState<Read>({ status: 'loading' });
  const [failed, setFailed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    setRead({ status: 'loading' }); setFailed(false); setShown(false);
    if (kind !== 'text' && kind !== 'markdown' && kind !== 'svg') return;
    const ctrl = new AbortController();
    let svg: string | null = null;
    configApi.readFile(file.botId, file.path, kind === 'svg' ? undefined : TEXT_LIMIT, ctrl.signal)
      .then(({ bytes, size }) => {
        if (ctrl.signal.aborted) return;
        if (kind === 'svg') {
          svg = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
          setRead({ status: 'svg', url: svg });
        } else if (isBinary(bytes)) {
          setRead({ status: 'none', why: 'This file isn’t text, so it can’t be shown here.' });
        } else {
          const truncated = size > bytes.length;
          const text = new TextDecoder().decode(bytes);
          // A file cut short ends at its last whole line.
          setRead({ status: 'text', text: truncated && text.includes('\n') ? text.slice(0, text.lastIndexOf('\n') + 1) : text, truncated });
        }
      })
      .catch((e: Error) => { if (!ctrl.signal.aborted) setRead({ status: 'none', why: `Couldn’t open it: ${e.message}` }); });
    return () => { ctrl.abort(); if (svg) URL.revokeObjectURL(svg); };
  }, [file.botId, file.path, kind]);

  const meta = [formatBytes(file.size), file.modifiedAt ? when(file.modifiedAt) : null].filter(Boolean).join(' · ');
  const download = fileUrl(file.botId, file.path);
  const nothing = (why: string) => (
    <div className="file-preview__none">
      <span>{why}</span>
      <a className="btn btn--sm btn--primary" href={download} download={file.name} data-autofocus>Download</a>
    </div>
  );
  const onLoad = () => setShown(true);
  const onError = () => setFailed(true);

  let body;
  if (!kind) body = nothing('There’s no preview for this kind of file.');
  else if (failed) body = nothing('Your browser can’t show this file.');
  else if (kind === 'image') body = <img className="file-preview__media" src={inline} alt={file.name} onLoad={onLoad} onError={onError} />;
  else if (kind === 'pdf') body = <iframe className="file-preview__frame" src={inline} title={file.name} onLoad={onLoad} />;
  else if (kind === 'video') body = <video className="file-preview__media" src={inline} controls playsInline preload="metadata" onLoadedMetadata={onLoad} onError={onError} />;
  else if (kind === 'audio') body = <audio className="file-preview__audio" src={inline} controls preload="metadata" onLoadedMetadata={onLoad} onError={onError} />;
  else if (read.status === 'none') body = nothing(read.why);
  else if (read.status === 'svg') body = <img className="file-preview__media file-preview__media--svg" src={read.url} alt={file.name} onLoad={onLoad} onError={onError} />;
  else if (read.status === 'text') {
    body = (
      <div className="file-preview__scroll">
        {kind === 'markdown' ? <div className="file-preview__doc"><Markdown text={read.text} /></div> : <pre className="file-preview__text">{read.text}</pre>}
        {read.truncated && <div className="file-preview__more">Showing the first {formatBytes(TEXT_LIMIT)}. Download the file to see the rest.</div>}
      </div>
    );
  }
  // Read here: loading until read. Loaded by the browser: until the element says it has something to show.
  const readHere = kind === 'text' || kind === 'markdown' || kind === 'svg';
  const loading = !!kind && !failed && (readHere ? read.status === 'loading' : !shown);
  const empty = !kind || failed || read.status === 'none';

  return (
    <Modal onClose={onClose} className={`file-preview file-preview--${empty ? 'none' : kind}`} label={file.name}>
      <div className="modal__header file-preview__header">
        <span className="file-preview__title">
          <span className="modal__title" title={file.name}>{file.name}</span>
          {meta && <span className="file-preview__meta">{meta}</span>}
        </span>
        <a className="cfg-icon-btn file-preview__download" href={download} download={file.name} aria-label={`Download ${file.name}`} title="Download">
          <Glyph name="download" size={14} />
        </a>
        <button type="button" className="modal__close" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="close" size={14} /></button>
      </div>
      <div className={`file-preview__body${loading ? ' is-loading' : ''}`}>
        {loading && <span className="cfg-spinner file-preview__spinner" aria-label="Loading" />}
        {body}
      </div>
    </Modal>
  );
}

function when(ts: number): string {
  const r = relativeShort(ts);
  return r === 'now' ? 'just now' : r === 'Yesterday' ? 'yesterday' : `${r} ago`;
}
