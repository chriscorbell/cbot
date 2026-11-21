// A stand-in model server for tests: OpenAI-compatible, as a self-hosted model (vLLM, llama.cpp, Ollama)
// would be, so a bot can finish a turn with no keys and no network. Point Settings > Providers >
// Self-hosted at it (http://127.0.0.1:<port>/v1) and give the bot the model `fake-model`.
//
//   node tests/fake-llm.mjs [port]            # 8799 when not given
//
// GET /v1/models lists the one model. POST /v1/chat/completions answers every request with REPLY, streamed
// when asked (stream: true) and whole otherwise, and never calls a tool. Every request is logged on one
// line. Node's standard library only, so it runs inside the dev container as it is.
import http from 'node:http';

const port = Number(process.argv[2] ?? 8799);
const REPLY = 'Hello from the fake model.';
const MODEL = 'fake-model';

let served = 0;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function completion(req, body) {
  served += 1;
  const id = `chatcmpl-fake-${served}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 };
  const last = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
  console.log(`[fake-llm] #${served} ${body.stream ? 'stream' : 'whole'} model=${body.model} tools=${(body.tools ?? []).length} user=${JSON.stringify(String(last?.content ?? '').slice(0, 80))}`);
  return { id, created, usage };
}

const server = http.createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0].replace(/^\/v1(?=\/)/, '');
  if (req.method === 'GET' && path === '/models') {
    return json(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', created: 0, owned_by: 'dispatch-tests' }] });
  }
  if (req.method === 'GET' && (path === '/health' || path === '/')) return json(res, 200, { ok: true, served });
  if (req.method !== 'POST' || path !== '/chat/completions') {
    console.log(`[fake-llm] ${req.method} ${req.url}: not here`);
    return json(res, 404, { error: { message: `${req.method} ${req.url} isn't something this fake serves` } });
  }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { error: { message: 'not JSON' } }); }
    const { id, created, usage } = completion(req, body);
    const model = body.model ?? MODEL;
    if (!body.stream) {
      return json(res, 200, {
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage,
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (delta, finish = null, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    for (const word of REPLY.split(/(?<= )/)) chunk({ content: word });
    chunk({}, 'stop', body.stream_options?.include_usage ? {} : { usage });
    if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[fake-llm] on http://127.0.0.1:${port}/v1, model ${MODEL}`));
