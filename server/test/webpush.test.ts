import crypto from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { encrypt, makeVapidKeys, MAX_PAYLOAD, validKeys, vapidAuthorization } from '../src/lib/webpush.js';
import { decrypt } from './push.js';

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');

describe('web push encryption', () => {
  test('matches the worked example of RFC 8291 (Section 5, Appendix A)', () => {
    const body = encrypt(b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'), {
      p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    }, { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), privateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') });
    const want = Buffer.concat([
      b(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
         mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8`),
      b(`8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
         bI_0LpXMuGvnzQ`),
    ]);
    expect(body.toString('base64url')).toBe(want.toString('base64url'));
  });

  test('a browser opens what is sealed for it, with fresh keys each time', () => {
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const auth = crypto.randomBytes(16);
    const to = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
    const msg = Buffer.from(JSON.stringify({ title: 'Ada', body: 'Done: the report is in your Library.' }));
    const one = encrypt(msg, to);
    const two = encrypt(msg, to);
    expect(one.equals(two)).toBe(false);
    expect(decrypt(one, ua.getPrivateKey(), auth).toString()).toBe(msg.toString());
    expect(decrypt(two, ua.getPrivateKey(), auth).toString()).toBe(msg.toString());
    // The largest message still fits the one record push services take.
    expect(encrypt(Buffer.alloc(MAX_PAYLOAD, 'x'), to).length).toBe(4096);
    expect(() => encrypt(Buffer.alloc(MAX_PAYLOAD + 1), to)).toThrow(/at most/);
  });

  test('refuses keys that are not a P-256 point and a 16-byte secret', () => {
    const auth = crypto.randomBytes(16).toString('base64url');
    expect(validKeys(Buffer.alloc(65, 4).toString('base64url'), auth)).toBe(true);
    expect(validKeys(Buffer.alloc(64, 4).toString('base64url'), auth)).toBe(false);
    expect(validKeys(Buffer.alloc(65, 3).toString('base64url'), auth)).toBe(false);
    expect(validKeys(Buffer.alloc(65, 4).toString('base64url'), 'short')).toBe(false);
    // Right shape, but not on the curve.
    expect(() => encrypt(Buffer.from('hi'), { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth })).toThrow();
  });
});

describe('VAPID', () => {
  test('signs a claim for the push service with the public key the browser subscribed with', () => {
    const keys = makeVapidKeys();
    const at = Date.UTC(2026, 10, 22, 12);
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc:def', keys, 'https://example.org', at);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, head, claims, sig, k] = m!;
    expect(k).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(head, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toEqual({ aud: 'https://fcm.googleapis.com', exp: at / 1000 + 12 * 3600, sub: 'https://example.org' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
  });
});
