import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

// The relay's upstream is a fake VNC server on a free port instead of a bot's Xvnc.
const fake = vi.hoisted(() => ({ port: 0 }));
vi.mock('../src/computer.js', () => ({ screenFor: async () => ({ screenId: 'screen-1' }), readyScreen: async () => {} }));
vi.mock('../src/machine.js', async (orig) => ({ ...(await orig<typeof import('../src/machine.js')>()), vncPortFor: () => fake.port }));

const { attachVncRelay, setRelayMode } = await import('../src/vnc.js');
const { auth, seedBot, seedOwner } = await import('./helpers.js');

/** What the fake VNC server got from the relay after the handshake. */
const received: Buffer[] = [];
let vnc: net.Server;
let app: http.Server;
let base = '';

beforeAll(async () => {
  vnc = net.createServer((s) => {
    let step = 0;
    let buf = Buffer.alloc(0);
    s.write('RFB 003.008\n');
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // Version, security type None, ClientInit; then everything is a client message.
      const need = [12, 1, 1];
      while (step < 3 && buf.length >= need[step]) {
        buf = buf.subarray(need[step]);
        if (step === 0) s.write(Buffer.from([1, 1]));
        if (step === 1) s.write(Buffer.alloc(4));
        if (step === 2) s.write(Buffer.alloc(24)); // ServerInit with an empty name
        step++;
      }
      if (step === 3 && buf.length) { received.push(buf); buf = Buffer.alloc(0); }
    });
  });
  await new Promise<void>((r) => vnc.listen(0, '127.0.0.1', r));
  fake.port = (vnc.address() as net.AddressInfo).port;
  app = http.createServer();
  attachVncRelay(app);
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  base = `ws://127.0.0.1:${(app.address() as net.AddressInfo).port}`;
});
afterAll(() => { app.close(); vnc.close(); });

/** A browser's side of the relay, signed in as far as the handshake. */
async function open(botId: string, mode: 'watch' | 'control', conn: string) {
  const ws = new WebSocket(`${base}/api/bots/${botId}/screen?mode=${mode}&conn=${conn}`, 'binary', { headers: auth() });
  const got: Buffer[] = [];
  ws.on('message', (d: Buffer) => got.push(d));
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const until = async (n: number) => { while (Buffer.concat(got).length < n) await new Promise((r) => setTimeout(r, 5)); };
  await until(12); ws.send(Buffer.from('RFB 003.008\n'));
  await until(14); ws.send(Buffer.from([1]));
  await until(18); ws.send(Buffer.from([1]));
  await until(42);
  return ws;
}

const pointer = Buffer.from([5, 0, 0, 10, 0, 20]);
const update = Buffer.from([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);
const settle = () => new Promise((r) => setTimeout(r, 50));

test('taking control and handing back switch the open connection', async () => {
  const user = seedOwner();
  const bot = seedBot(user.id, { name: 'Vic' });
  const ws = await open(bot.id, 'watch', 'conn-vic-1');

  // Watching: input is dropped, the rest goes through.
  received.length = 0;
  ws.send(Buffer.concat([pointer, update])); await settle();
  expect(Buffer.concat(received)).toEqual(update);

  expect(setRelayMode(user.id, bot.id, 'conn-vic-1', 'control')).toBe(true);
  received.length = 0;
  ws.send(pointer); await settle();
  expect(Buffer.concat(received)).toEqual(pointer);

  expect(setRelayMode(user.id, bot.id, 'conn-vic-1', 'watch')).toBe(true);
  received.length = 0;
  ws.send(pointer); ws.send(update); await settle();
  expect(Buffer.concat(received)).toEqual(update);

  // Only for the bot it was opened for, and only while it is open.
  const other = seedBot(user.id, { name: 'Wes' });
  expect(setRelayMode(user.id, other.id, 'conn-vic-1', 'control')).toBe(false);
  ws.close(); await settle();
  expect(setRelayMode(user.id, bot.id, 'conn-vic-1', 'control')).toBe(false);
});

test('a connection name already in use is refused', async () => {
  const bot = seedBot(seedOwner().id, { name: 'Xia' });
  const ws = await open(bot.id, 'watch', 'conn-xia-1');
  await expect(open(bot.id, 'watch', 'conn-xia-1')).rejects.toThrow(/409/);
  ws.close();
});
