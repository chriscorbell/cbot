import type { IncomingMessage, Server } from 'node:http';
import net from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { db, type BotRecord } from './db.js';
import { authenticate, crossSite, headerOf } from './lib/auth.js';
import { displayFor, vncPortFor } from './machine.js';
import { readyScreen, screenFor } from './computer.js';
import { ByteQueue, rfbHandshake } from './lib/rfb.js';

/**
 * VNC relay: browser <-> our server <-> the VNC server of the bot's display (Xvnc on 127.0.0.1).
 * The browser has signed in to this app; the VNC servers have no password of their own, because
 * they listen on loopback only, out of reach of anything but this machine. The server does the RFB handshake upstream, then
 * offers the browser an unauthenticated RFB session. In "watch" mode, client input messages
 * (KeyEvent, PointerEvent, ClientCutText) are dropped server-side.
 *
 * Taking control and handing back change the mode of the open connection (setRelayMode) rather than
 * opening a new one: a new connection meant a moment without a picture, and noVNC logged errors while
 * the old socket was still closing. The browser names its connection with `conn` when it opens it.
 */

type Mode = 'watch' | 'control';
interface Relay { userId: string; botId: string; mode: Mode; filter: WatchFilter }
/** Open relays by the browser's name for them. */
const relays = new Map<string, Relay>();
const CONN_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Switch one of this user's open relays to the bot between watching and control. False when there
 * is no such relay (closed, or another user's or bot's).
 */
export function setRelayMode(userId: string, botId: string, conn: string, mode: Mode): boolean {
  const r = relays.get(conn);
  if (!r || r.userId !== userId || r.botId !== botId) return false;
  // noVNC sends whole messages in each WebSocket message, so a fresh filter starts at a boundary.
  if (mode === 'watch' && r.mode !== 'watch') r.filter = new WatchFilter();
  r.mode = mode;
  return true;
}

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

async function browserHandshake(q: ByteQueue, send: (b: Buffer) => void, serverInit: Buffer) {
  send(Buffer.from('RFB 003.008\n'));
  await q.read(12);
  send(Buffer.from([1, 1])); // one security type: None
  await q.read(1);
  send(u32(0)); // SecurityResult OK
  await q.read(1); // ClientInit
  send(serverInit);
}

/** Filters a client->server RFB stream, dropping input events. Returns bytes to forward. */
class WatchFilter {
  private pending = Buffer.alloc(0);
  feed(chunk: Buffer): Buffer {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: Buffer[] = [];
    for (;;) {
      const b = this.pending;
      if (!b.length) break;
      const len = msgLength(b);
      if (len === -1) { this.pending = Buffer.alloc(0); break; } // unknown: fail closed
      if (len === 0 || b.length < len) break; // need more bytes
      const msg = b.subarray(0, len);
      const t = b[0];
      if (t !== 4 && t !== 5 && t !== 6) out.push(Buffer.from(msg));
      this.pending = b.subarray(len);
    }
    return Buffer.concat(out);
  }
}

/** Length of the client message at the head of `b`, 0 if more bytes are needed to know, -1 if unknown. */
function msgLength(b: Buffer): number {
  const t = b[0];
  switch (t) {
    case 0: return 20; // SetPixelFormat
    case 2: return b.length < 4 ? 0 : 4 + 4 * b.readUInt16BE(2); // SetEncodings
    case 3: return 10; // FramebufferUpdateRequest
    case 4: return 8; // KeyEvent
    case 5: return 6; // PointerEvent
    case 6: return b.length < 8 ? 0 : 8 + Math.abs(b.readInt32BE(4)); // ClientCutText (+extended)
    case 150: return 10; // EnableContinuousUpdates
    case 248: return b.length < 9 ? 0 : 9 + b[8]; // ClientFence
    case 251: return b.length < 8 ? 0 : 8 + 16 * b[6]; // SetDesktopSize
    default: return -1;
  }
}

export function attachVncRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });

  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/api\/bots\/([^/]+)\/screen$/);
    if (!m) return; // not ours
    // Same checks as every HTTP request: from the app's own page, with the session cookie (see lib/auth.ts).
    if (crossSite((name) => headerOf(req, name))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const user = authenticate(req.headers.cookie);
    const bot = user ? db.prepare<[string, string], BotRecord>('SELECT * FROM bots WHERE id=? AND user_id=?').get(m[1], user.id) : null;
    if (!user || !bot) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'watch';
    const conn = url.searchParams.get('conn');
    if (conn && (!CONN_ID.test(conn) || relays.has(conn))) {
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => relay(client, { userId: user.id, botId: bot.id, mode, filter: new WatchFilter() }, conn));
  });
}

async function relay(client: WebSocket, state: Relay, conn: string | null) {
  const { userId, botId } = state;
  const fromClient = new ByteQueue();
  const fromUp = new ByteQueue();
  let upstream: net.Socket | null = null;
  let piping = false;
  if (conn) relays.set(conn, state);
  const closeAll = (code = 1000, reason = '') => {
    try { client.close(code, reason.slice(0, 120)); } catch { /* */ }
    upstream?.destroy();
  };
  // The mode is read per message, so a switch applies from the next one.
  const forward = (data: Buffer) => (state.mode === 'watch' ? state.filter.feed(data) : data);

  client.on('message', (data: Buffer) => {
    if (!piping) return fromClient.push(Buffer.from(data));
    const fwd = forward(Buffer.from(data));
    if (fwd.length && upstream?.writable) upstream.write(fwd);
  });
  client.on('close', () => {
    if (conn && relays.get(conn) === state) relays.delete(conn);
    fromClient.close(new Error('client closed'));
    upstream?.destroy();
  });

  try {
    const { screenId } = await screenFor(userId, botId);
    // A screen nobody has used yet is bare; set it up while the person is already watching.
    readyScreen(userId, botId).catch(() => {});
    const up = net.connect({ host: '127.0.0.1', port: vncPortFor(Number(displayFor(screenId).slice(1))) });
    upstream = up;
    up.setNoDelay(true);
    up.on('data', (data: Buffer) => {
      if (!piping) return fromUp.push(data);
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
    up.on('close', () => { fromUp.close(new Error('upstream closed')); closeAll(1000, 'the screen closed'); });
    up.on('error', (e) => { fromUp.close(e); closeAll(1011, String(e.message)); });
    await new Promise<void>((res, rej) => { up.once('connect', () => res()); up.once('error', rej); });

    const serverInit = await rfbHandshake(fromUp, (b) => up.write(b));
    await browserHandshake(fromClient, (b) => client.send(b), serverInit);
    // Flush anything that arrived during the handshake, then switch to piping.
    piping = true;
    const leftoverUp = fromUp.takeAll();
    if (leftoverUp.length) client.send(leftoverUp);
    const leftoverClient = fromClient.takeAll();
    if (leftoverClient.length) {
      const fwd = forward(leftoverClient);
      if (fwd.length) up.write(fwd);
    }
  } catch (e: any) {
    console.warn('[vnc] relay failed', e?.message ?? e);
    closeAll(1011, String(e?.message ?? e));
  }
}
