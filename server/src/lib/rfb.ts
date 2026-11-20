/**
 * The client side of RFB (the VNC protocol) as far as this app needs it: the handshake with one of the
 * bots' Xvnc servers, which offer security type None on 127.0.0.1. The viewer relay (vnc.ts) and the
 * display check (displays.ts) both use it.
 */

/** Bytes from a socket, read in exact-size pieces. */
export class ByteQueue {
  private buf = Buffer.alloc(0);
  private waiters: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed: Error | null = null;
  push(b: Buffer) { this.buf = Buffer.concat([this.buf, b]); this.drain(); }
  close(e: Error) { this.closed = e; for (const w of this.waiters) w.reject(e); this.waiters = []; }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(this.closed);
      this.waiters.push({ n, resolve, reject });
      this.drain();
    });
  }
  takeAll(): Buffer { const b = this.buf; this.buf = Buffer.alloc(0); return b; }
  private drain() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift()!;
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
}

async function reason(q: ByteQueue): Promise<string> {
  const len = (await q.read(4)).readUInt32BE();
  return (await q.read(len)).toString();
}

/**
 * Sign in to the VNC server with security type None and join its shared session. Returns the
 * server's ServerInit message (size, pixel format, name). Throws with the server's reason when it
 * turns the connection away.
 */
export async function rfbHandshake(q: ByteQueue, send: (b: Buffer) => void): Promise<Buffer> {
  const version = (await q.read(12)).toString('latin1');
  if (version.startsWith('RFB 003.003')) {
    // TigerVNC turns away a host it has blacklisted in protocol 3.3: security type 0, then the reason.
    if ((await q.read(4)).readUInt32BE() === 0) throw new Error(`VNC refused: ${await reason(q)}`);
    throw new Error('Unsupported VNC protocol 3.3');
  }
  send(Buffer.from('RFB 003.008\n'));
  const n = (await q.read(1))[0];
  if (n === 0) throw new Error(`VNC refused: ${await reason(q)}`);
  const types = [...(await q.read(n))];
  if (!types.includes(1)) throw new Error(`Unsupported VNC security types: ${types.join(',')}`);
  send(Buffer.from([1])); // None
  if ((await q.read(4)).readUInt32BE() !== 0) {
    let why = '';
    try { why = await reason(q); } catch { /* none */ }
    throw new Error(`VNC auth failed ${why}`);
  }
  send(Buffer.from([1])); // ClientInit: shared
  const head = await q.read(24); // w,h,pixfmt(16),nameLen
  const name = await q.read(head.readUInt32BE(20));
  return Buffer.concat([head, name]);
}
