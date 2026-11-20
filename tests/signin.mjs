// Signs the end-to-end scripts in as CBOT_USER / CBOT_PASSWORD. On a server with no account yet (a
// fresh container) it creates that account first, as the first-run screen would, and then does what
// the setup wizard would: makes the primary bot, named "Main", unless one is there, and finishes setup
// without a greeting. That bot runs on whatever model the server's keys give it.

/** Returns the session cookie, "cbot_session=…", for fetch headers and WebSockets. */
export async function signIn(base) {
  const username = process.env.CBOT_USER;
  const password = process.env.CBOT_PASSWORD;
  if (!username || !password) throw new Error('Set CBOT_USER and CBOT_PASSWORD to the account to sign in as (a server with no account gets this one)');
  const me = await fetch(`${base}/api/auth/me`);
  if (!me.ok) throw new Error(`sign-in check failed: ${me.status}`);
  const { needsAccount } = await me.json();
  const res = await fetch(`${base}/api/auth/${needsAccount ? 'setup' : 'login'}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status} ${(await res.json().catch(() => ({}))).error ?? ''}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  if ((await res.json()).needsSetup) await finishSetup(base, cookie);
  return cookie;
}

async function finishSetup(base, cookie) {
  const call = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${(await r.json().catch(() => ({}))).error ?? ''}`);
    return r.json();
  };
  const { bots } = await call('GET', '/api/bots');
  if (!bots.some((b) => b.isPrimary)) await call('POST', '/api/bots', { name: 'Main' });
  await call('POST', '/api/setup/finish', { greet: false });
}

/** The same cookie for a Playwright context: `await ctx.addCookies([browserCookie(BASE, COOKIE)])`. */
export function browserCookie(base, cookie) {
  const i = cookie.indexOf('=');
  return { name: cookie.slice(0, i), value: cookie.slice(i + 1), url: base };
}
