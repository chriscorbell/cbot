import { useState } from 'react';
import { ShieldCheck, ShieldQuestionMark, ShieldX } from 'lucide-react';
import type { ApprovalChoice, CardBody, Row } from '@shared/types';
import { api } from '../../lib/api';
import { Icon } from '../Icon';
import { WeatherCard } from './WeatherCard';
import { PageCard } from './PageCard';
import { emitUi } from '../../lib/uiEvents';

type Card<K extends CardBody['card']> = Extract<CardBody, { card: K }>;

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Never rejects: a failure shows in `error`. */
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message || 'Something went wrong'); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

const APP_NAMES: Record<string, string> = { googlecalendar: 'Google Calendar', gmail: 'Gmail', googledrive: 'Google Drive', googledocs: 'Google Docs', googlesheets: 'Google Sheets', github: 'GitHub', slack: 'Slack', notion: 'Notion', linear: 'Linear' };
/** "GOOGLECALENDAR_CREATE_EVENT" → "Google Calendar · Create event". */
const prettyTool = (s: string) => {
  const parts = s.split(/[_:]/).filter(Boolean);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  if (parts.length < 2) return cap(s.replace(/_/g, ' '));
  const app = APP_NAMES[parts[0].toLowerCase()] ?? cap(parts[0]);
  return `${app} · ${cap(parts.slice(1).join(' '))}`;
};
/** Options often arrive numbered ("1. Foo"); the letter key already numbers them. */
const optionLabel = (o: string) => o.replace(/^\s*(\d+|[A-Za-z])[.)]\s+/, '');

// ---------------- approval ----------------

const APPROVAL_OUTCOME: Record<string, string> = { allowed: 'Allowed once', always: 'Always allowed', denied: 'Not allowed', expired: 'Expired' };
const APPROVAL_ICON = { pending: ShieldQuestionMark, allowed: ShieldCheck, always: ShieldCheck, denied: ShieldX, expired: ShieldX };

/** Hermes' question before an action it flags (server/src/agent/approvals.ts); the run waits for the answer. */
export function ApprovalCard({ body }: { body: Card<'approval'> }) {
  const { busy, error, run } = useBusy();
  const pending = body.status === 'pending';
  const offered = body.choices ?? ['once', 'always', 'deny'];
  const decide = (c: ApprovalChoice) => run(c, () => api.approve(body.approvalId, c));
  const StatusIcon = APPROVAL_ICON[body.status] ?? ShieldQuestionMark;
  const sub = body.label || (body.tool ? prettyTool(body.tool) : '');
  return (
    <div className={`card approval-card${pending ? '' : ' is-resolved'}`}>
      <div className="card__head">
        <span className="approval-card__tile" aria-hidden><StatusIcon key={body.status} size={22} strokeWidth={1.75} /></span>
        <div className="card__titles">
          <div className="card__title">{body.title}</div>
          {sub && <div className="card__sub">{sub}</div>}
        </div>
      </div>
      {body.command && <pre className="card__code">{body.command}</pre>}
      {body.detail && <div className="card__body">{body.detail}</div>}
      {pending ? (
        <>
          <div className="card__actions">
            {offered.includes('deny') && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('deny')}>Don't allow</button>}
            {offered.includes('always') && <button type="button" className="btn btn--secondary" disabled={!!busy} onClick={() => decide('always')} title="Every Bot stops asking about this">Always allow</button>}
            {offered.includes('once') && <button type="button" className="btn btn--primary" disabled={!!busy} onClick={() => decide('once')}>Allow</button>}
          </div>
          {error && <div className="card__error">{error}</div>}
        </>
      ) : (
        <div className={`card__outcome is-${body.status}`}>
          <Icon name={body.status === 'denied' || body.status === 'expired' ? 'close' : 'check'} size={14} />
          {APPROVAL_OUTCOME[body.status] ?? body.status}
        </div>
      )}
    </div>
  );
}

// ---------------- question ----------------

export function QuestionCard({ row, body }: { row: Row; body: Card<'question'> }) {
  const { busy, error, run } = useBusy();
  const [picked, setPicked] = useState<number[]>([]);
  const pending = body.status === 'pending';
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const answered = new Set((body.answer ?? '').split(/\s*;\s*/).filter(Boolean));
  const choose = (i: number) => {
    if (!pending || busy) return;
    if (!body.multiple) { void run(String(i), () => api.answer(row.botId, row.seq, row.generation, body.options[i])); return; }
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)));
  };
  // "Something else" hands the question to the composer, as a reply.
  const other = () => {
    if (!pending) return;
    emitUi('reply', { text: body.question, seq: row.seq, generation: row.generation });
  };
  return (
    <div className={`card question-card${pending ? '' : ' is-resolved'}`} data-seq={row.seq}>
      <div className="question-card__head">
        <div className="question-card__q">{body.question}</div>
        {body.multiple && <div className="question-card__hint">Choose all that apply</div>}
      </div>
      <div className="question-card__options" role={body.multiple ? 'group' : undefined}>
        {body.options.map((opt, i) => {
          const chosen = pending ? picked.includes(i) : answered.has(opt);
          return (
            <button
              key={i}
              type="button"
              className={`question-option${chosen ? ' is-chosen' : ''}`}
              disabled={!pending || !!busy}
              aria-pressed={body.multiple ? chosen : undefined}
              onClick={() => choose(i)}
            >
              <span className="question-option__key">{letters[i] ?? i + 1}</span>
              <span className="question-option__label">{optionLabel(opt)}</span>
              {chosen && <Icon name="check" size={14} className="question-option__check" />}
            </button>
          );
        })}
        <button type="button" className="question-option is-other" disabled={!pending || !!busy} onClick={other}>
          <span className="question-option__key">{letters[body.options.length] ?? body.options.length + 1}</span>
          <span className="question-option__label">Something else</span>
        </button>
      </div>
      {pending && body.multiple && (
        <div className="question-card__foot">
          <button type="button" className="btn btn--primary btn--sm" disabled={!picked.length || !!busy} onClick={() => run('done', () => api.answer(row.botId, row.seq, row.generation, picked.map((i) => body.options[i]).join('; ')))}>Done</button>
        </div>
      )}
      {error && <div className="card__error">{error}</div>}
    </div>
  );
}

export function CardRow({ row }: { row: Row }) {
  const b = row.body;
  if (b.type !== 'card') return null;
  switch (b.card) {
    case 'approval': return <ApprovalCard body={b} />;
    case 'question': return <QuestionCard row={row} body={b} />;
    case 'weather': return <WeatherCard body={b} />;
    case 'page': return <PageCard row={row} body={b} />;
    default: return null;
  }
}
