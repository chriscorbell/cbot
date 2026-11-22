import crypto from 'node:crypto';

/**
 * Web Push with Node's own crypto: the message encryption browsers expect (RFC 8291, the aes128gcm
 * content coding of RFC 8188) and the VAPID claim push services ask of a sender (RFC 8292).
 * notifications.ts decides what to send and to whom; this only turns a message into the request.
 *
 * A browser that subscribes gets an endpoint at its maker's push service and two keys: `p256dh`, its
 * public key, and `auth`, a secret shared with us. Only that browser can read what we encrypt for
 * them; the push service sees who and when, not what. VAPID proves every message comes from the
 * server whose public key the browser subscribed with.
 */

/** A VAPID key pair in base64url: the public key as an uncompressed P-256 point (65 bytes) and the private scalar (32). */
export interface VapidKeys { publicKey: string; privateKey: string }

/** Where a browser takes its messages, and its keys (base64url), as PushSubscription.toJSON() gives them. */
export interface PushTarget { endpoint: string; p256dh: string; auth: string }

export function makeVapidKeys(): VapidKeys {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

/** Whether a subscription's keys have the right shape: a P-256 point and a 16-byte secret. */
export function validKeys(p256dh: string, auth: string): boolean {
  const pub = Buffer.from(p256dh, 'base64url');
  return pub.length === 65 && pub[0] === 4 && Buffer.from(auth, 'base64url').length === 16;
}

/** The one record a message is: push services take a body of at most 4096 bytes. */
const RECORD = 4096;
/** The most a message may hold: the record less its header (86 bytes), the padding delimiter and the tag. */
export const MAX_PAYLOAD = RECORD - 86 - 1 - 16;

/**
 * The message encrypted for one browser (RFC 8291 section 3): a fresh key pair of our own, a secret
 * shared with the browser's key, and keys derived from that and the browser's auth secret. `fixed`
 * replaces the random salt and key pair, for the RFC's test vector only.
 */
export function encrypt(payload: Buffer, to: Pick<PushTarget, 'p256dh' | 'auth'>, fixed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`a push message holds at most ${MAX_PAYLOAD} bytes, not ${payload.length}`);
  if (!validKeys(to.p256dh, to.auth)) throw new Error('the subscription has no usable keys');
  const uaPublic = Buffer.from(to.p256dh, 'base64url');
  const authSecret = Buffer.from(to.auth, 'base64url');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed) ecdh.setPrivateKey(fixed.privateKey); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  // Throws for a point that isn't on the curve, which the RFC requires us to refuse.
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const salt = fixed?.salt ?? crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02 marks the last (and only) record; no padding beyond it.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/**
 * The Authorization header for a message to `endpoint` (RFC 8292): a JWT for the push service's origin,
 * signed with our VAPID key, good for 12 hours (services refuse more than 24). `subject` is how the
 * service can reach whoever runs the sender; services require one.
 */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, at = Date.now()): string {
  const head = b64json({ typ: 'JWT', alg: 'ES256' });
  const claims = b64json({ aud: new URL(endpoint).origin, exp: Math.floor(at / 1000) + 12 * 3600, sub: subject });
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  const signature = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

export interface PushOptions {
  /** How long the push service keeps a message for a browser that is offline, in seconds. */
  ttl: number;
  /** 'high' wakes a phone at once; 'normal' lets it wait for a good moment. */
  urgency: 'normal' | 'high';
  /** A message with the same topic replaces one still waiting at the service. Up to 32 base64url characters. */
  topic?: string;
}

/**
 * Sends one message and answers the push service's status: 201 when it took it, 404 or 410 when the
 * subscription is gone for good. Throws only when the service can't be reached.
 */
export async function sendPush(to: PushTarget, payload: Buffer, keys: VapidKeys, subject: string, o: PushOptions): Promise<{ status: number; text: string }> {
  const res = await fetch(to.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(to.endpoint, keys, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(o.ttl),
      urgency: o.urgency,
      ...(o.topic ? { topic: o.topic } : {}),
    },
    body: new Uint8Array(encrypt(payload, to)),
    // The endpoint came from a browser; it answers itself or not at all.
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
  return { status: res.status, text };
}
