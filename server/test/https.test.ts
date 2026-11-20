import crypto from 'node:crypto';
import fs from 'node:fs';
import { expect, test } from 'vitest';
import { altNames, certificateNames, door, plan, redirectTarget } from '../src/https.js';

// Public certificates only (fixtures/https): an authority and the certificate it signed for testhost
// at 192.168.1.20, and an unrelated authority. Their keys were thrown away.
const fixture = (name: string) => new crypto.X509Certificate(fs.readFileSync(new URL(`fixtures/https/${name}`, import.meta.url)));
const authority = fixture('ca.crt');
const cert = fixture('server.crt');
const other = fixture('other-ca.crt');
const DAY = 86_400_000;
const issued = Date.parse(cert.validFrom);
const names = certificateNames('testhost', '192.168.1.20');

test('the certificate names this machine by host name, .local name and network address', () => {
  expect(names).toEqual({ dns: ['localhost', 'testhost', 'testhost.local'], ips: ['127.0.0.1', '192.168.1.20'] });
  expect(certificateNames('Box.example.com', '10.0.0.5').dns).toEqual(['localhost', 'box.example.com', 'box.local']);
  // A host name a certificate can't hold, or no route to the network, leaves the rest.
  expect(certificateNames('bad_name', undefined)).toEqual({ dns: ['localhost'], ips: ['127.0.0.1'] });
  expect(certificateNames('testhost', 'fe80::1').ips).toEqual(['127.0.0.1']);
  expect(altNames(names)).toEqual(cert.subjectAltName!.split(', ').sort());
});

test('a matching certificate is kept, renewed near its end, and replaced with its authority when anything else changed', () => {
  expect(plan(authority, cert, names, issued + DAY)).toBe('keep');
  expect(plan(authority, cert, names, Date.parse(cert.validTo) - 10 * DAY)).toBe('renew');
  // A new address needs a new authority, since the authority is limited to the old one.
  expect(plan(authority, cert, certificateNames('testhost', '192.168.1.21'), issued + DAY)).toBe('replace');
  expect(plan(other, cert, names, issued + DAY)).toBe('replace');
  expect(plan(null, cert, names, issued + DAY)).toBe('replace');
  expect(plan(authority, null, names, issued + DAY)).toBe('replace');
  expect(plan(authority, cert, names, Date.parse(authority.validTo) - 10 * DAY)).toBe('replace');
});

test('a TLS handshake gets HTTPS, plain HTTP from this machine is served, and from elsewhere redirected', () => {
  expect(door(0x16, '192.168.1.7')).toBe('https');
  expect(door(0x16, '127.0.0.1')).toBe('https');
  expect(door('G'.charCodeAt(0), '127.0.0.1')).toBe('http');
  expect(door('G'.charCodeAt(0), '::ffff:127.0.0.1')).toBe('http');
  expect(door('G'.charCodeAt(0), '::1')).toBe('http');
  expect(door('G'.charCodeAt(0), '192.168.1.7')).toBe('redirect');
  expect(door('P'.charCodeAt(0), undefined)).toBe('redirect');
});

test('a redirect keeps the host, port and path, and refuses a Host that is not one', () => {
  expect(redirectTarget('192.168.1.20:8787', '/api/bots?x=1')).toBe('https://192.168.1.20:8787/api/bots?x=1');
  expect(redirectTarget('testhost.local:8787', undefined)).toBe('https://testhost.local:8787/');
  expect(redirectTarget('[fe80::1]:8787', '/')).toBe('https://[fe80::1]:8787/');
  expect(redirectTarget(undefined, '/')).toBeNull();
  expect(redirectTarget('evil.com/x', '/')).toBeNull();
  expect(redirectTarget('a b', '/')).toBeNull();
});
