import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { getRequestListener } from '@hono/node-server';
import { env } from './env.js';

/**
 * HTTPS with Dispatch's own certificate, on with HTTPS=1 (the installer sets it). Browsers allow the
 * microphone, and so voice calls, only over HTTPS or on localhost, and no public authority signs a
 * certificate for a machine reached by its address on the local network.
 *
 * The certificate comes from a small certificate authority of the machine's own, limited by name
 * constraints to exactly the names and addresses the certificate holds: localhost, the host name and
 * <host>.local, 127.0.0.1, and the address the machine reaches the network from. Its key lives on the
 * machine, where the bots could read it, so it must not be able to vouch for any other site. A device
 * that installs the authority (Settings > General > Certificate) trusts Dispatch without a warning; one that
 * doesn't warns once and then works the same. Both live in DATA_DIR/https, which a reset leaves alone.
 * When the names change (a new address), a new authority and certificate replace them, and devices need
 * the new authority; when the certificate nears its end, the same authority signs a new one. That is
 * checked at start and hourly, and new connections get a new certificate without a restart.
 *
 * One port serves both. A connection that opens with a TLS handshake gets HTTPS. Plain HTTP from this
 * machine is served as before (the release health check, Tailscale Serve, the bots' MCP); plain HTTP
 * from anywhere else is redirected to HTTPS.
 */

const DIR = path.join(env.dataDir, 'https');
const FILES = { caKey: 'ca.key', caCert: 'ca.crt', key: 'server.key', cert: 'server.crt' } as const;
const file = (name: keyof typeof FILES, suffix = '') => path.join(DIR, FILES[name] + suffix);
const DAY = 86_400_000;
const AUTHORITY_DAYS = 3650;
// Apple refuses a certificate valid for longer than 825 days, even from an authority a person added.
const CERTIFICATE_DAYS = 397;
const RENEW_DAYS = 30;
const run = promisify(execFile);

export interface Names { dns: string[]; ips: string[] }

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/** What the certificate covers: this machine by name, and by the address it reaches the network from. */
export function certificateNames(hostname: string, address: string | undefined): Names {
  const dns = new Set(['localhost']);
  const host = hostname.trim().toLowerCase();
  if (HOST_NAME.test(host)) {
    dns.add(host);
    dns.add(`${host.split('.')[0]}.local`);
  }
  const ips = new Set(['127.0.0.1']);
  if (address && net.isIPv4(address)) ips.add(address);
  return { dns: [...dns], ips: [...ips] };
}

/** The names as a certificate lists them (`subjectAltName`), sorted, to compare. */
export const altNames = (n: Names) => [...n.dns.map((d) => `DNS:${d}`), ...n.ips.map((ip) => `IP Address:${ip}`)].sort();

const altNamesOf = (cert: crypto.X509Certificate) => (cert.subjectAltName ?? '').split(', ').filter(Boolean).sort();

/** What to do about the files on disk: keep them, sign a fresh certificate, or replace the authority too. */
export function plan(authority: crypto.X509Certificate | null, cert: crypto.X509Certificate | null, want: Names, now: number): 'keep' | 'renew' | 'replace' {
  if (!authority || !cert || !cert.checkIssued(authority) || !cert.verify(authority.publicKey)) return 'replace';
  if (altNamesOf(cert).join() !== altNames(want).join()) return 'replace';
  if (Date.parse(authority.validTo) - now < RENEW_DAYS * DAY) return 'replace';
  if (Date.parse(cert.validTo) - now < RENEW_DAYS * DAY) return 'renew';
  return 'keep';
}

const readCert = (p: string) => {
  try { return new crypto.X509Certificate(fs.readFileSync(p)); } catch { return null; }
};

const subjectName = (n: Names) => n.dns.find((d) => d !== 'localhost') ?? 'localhost';
const newKey = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-noenc'];

async function makeAuthority(n: Names) {
  const only = [...n.dns.map((d) => `permitted;DNS:${d}`), ...n.ips.map((ip) => `permitted;IP:${ip}/255.255.255.255`)].join(',');
  await run('openssl', ['req', '-x509', ...newKey, '-keyout', file('caKey', '.new'), '-out', file('caCert', '.new'),
    '-days', String(AUTHORITY_DAYS), '-subj', `/O=Dispatch/CN=Dispatch on ${subjectName(n)}`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', `nameConstraints=critical,${only}`]);
}

async function makeCertificate(n: Names, authority: '' | '.new') {
  const alt = [...n.dns.map((d) => `DNS:${d}`), ...n.ips.map((ip) => `IP:${ip}`)].join(',');
  await run('openssl', ['req', '-x509', '-CA', file('caCert', authority), '-CAkey', file('caKey', authority), ...newKey,
    '-keyout', file('key', '.new'), '-out', file('cert', '.new'), '-days', String(CERTIFICATE_DAYS), '-subj', `/CN=${subjectName(n)}`,
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'keyUsage=critical,digitalSignature',
    '-addext', 'extendedKeyUsage=serverAuth', '-addext', `subjectAltName=${alt}`]);
}

/** The address this machine reaches the network from (a UDP "connect" only picks a route; nothing is sent). */
function networkAddress(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const done = (address?: string) => { socket.close(); resolve(address); };
    socket.on('error', () => done());
    socket.connect(53, '1.1.1.1', () => done(socket.address().address));
  });
}

/** The certificate and key to serve, made or renewed first when they need it. */
async function certificate(): Promise<{ key: Buffer; cert: Buffer; changed: boolean }> {
  const want = certificateNames(os.hostname(), await networkAddress());
  const step = plan(readCert(file('caCert')), readCert(file('cert')), want, Date.now());
  if (step !== 'keep') {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    if (step === 'replace') await makeAuthority(want);
    await makeCertificate(want, step === 'replace' ? '.new' : '');
    if (step === 'replace') for (const f of ['caKey', 'caCert'] as const) fs.renameSync(file(f, '.new'), file(f));
    for (const f of ['key', 'cert'] as const) fs.renameSync(file(f, '.new'), file(f));
    console.log(`[https] ${step === 'replace' ? 'new authority and certificate' : 'renewed certificate'} for ${altNames(want).join(', ')}`);
  }
  return { key: fs.readFileSync(file('key')), cert: fs.readFileSync(file('cert')), changed: step !== 'keep' };
}

/** The authority a device installs to trust Dispatch's certificate, while HTTPS is on and it exists. */
export function authorityPem(): Buffer | null {
  if (!env.https) return null;
  try { return fs.readFileSync(file('caCert')); } catch { return null; }
}

const isLoopback = (address: string | undefined) => !!address && (address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.'));

/** Where a new connection goes, from its first byte (22 opens a TLS handshake) and where it comes from. */
export function door(firstByte: number, remote: string | undefined): 'https' | 'http' | 'redirect' {
  if (firstByte === 0x16) return 'https';
  return isLoopback(remote) ? 'http' : 'redirect';
}

/** The HTTPS address for a plain request, or null when its Host isn't a host name and port. */
export function redirectTarget(host: string | undefined, url: string | undefined): string | null {
  if (!host || !/^[a-z0-9.-]+(:\d+)?$|^\[[0-9a-f:.]+\](:\d+)?$/i.test(host)) return null;
  return `https://${host}${url?.startsWith('/') ? url : '/'}`;
}

/**
 * Listens on PORT with HTTPS and plain HTTP (see the top of this file). Returns the plain server,
 * which gets every WebSocket upgrade, so the relays attach to it alone. Throws when the certificate
 * can't be made; index.ts then serves plain HTTP.
 */
export async function serveHttps(fetch: Parameters<typeof getRequestListener>[0]): Promise<http.Server> {
  const { key, cert } = await certificate();
  const listener = getRequestListener(fetch);
  const plain = http.createServer(listener);
  const secure = https.createServer({ key, cert }, listener);
  secure.on('upgrade', (req, socket, head) => plain.emit('upgrade', req, socket, head));
  const moved = http.createServer((req, res) => {
    const to = redirectTarget(req.headers.host, req.url);
    res.writeHead(to ? 308 : 400, to ? { location: to } : {}).end();
  });
  moved.on('upgrade', (_req, socket) => socket.destroy());
  const servers = { https: secure, http: plain, redirect: moved };

  const front = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    // A client speaks first in both protocols; one that says nothing is let go.
    socket.setTimeout(30_000, () => socket.destroy());
    socket.once('data', (chunk: Buffer) => {
      socket.setTimeout(0);
      socket.pause();
      socket.unshift(chunk);
      servers[door(chunk[0], socket.remoteAddress)].emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
  front.listen(env.port, env.host, () => console.log(`[dispatch] server on https://${env.host ?? 'localhost'}:${env.port} (and http from this machine)`));

  setInterval(() => {
    certificate()
      .then((next) => { if (next.changed) secure.setSecureContext({ key: next.key, cert: next.cert }); })
      .catch((e: unknown) => console.error('[https] could not renew the certificate:', e));
  }, 3_600_000).unref();
  return plain;
}
