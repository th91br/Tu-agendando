const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const sessionKey = 'tu-agendando.auth.session.v1';
const source = fs.readFileSync(path.join(__dirname, '../public/supabase.js'), 'utf8').replace(/^export /gm, '');
const response = (status, value) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const session = (extra = {}) => ({
  access_token: 'test-access', refresh_token: 'test-refresh', expires_at: Date.now() + 3600_000,
  user: { id: 'test-user', email: 'test@example.invalid' }, ...extra,
});
const authResponse = (extra = {}) => ({ ...session(), expires_at: Math.floor(Date.now() / 1000) + 3600, ...extra });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function context(t, options = {}) {
  const storage = options.storage || new Map();
  const dom = new JSDOM('', { url: 'https://agenda.example.invalid/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window;
  const local = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  Object.defineProperty(w, 'localStorage', { value: local });
  if (options.legacy) w.sessionStorage.setItem(sessionKey, JSON.stringify(options.legacy));
  if (options.locks) Object.defineProperty(w.navigator, 'locks', { value: options.locks });
  const requests = [], changes = [];
  w.addEventListener('tu-agendando:auth', event => changes.push(event.detail));
  w.TU_AGENDANDO_CONFIG = { url: 'https://auth.example.invalid', publishableKey: 'test-publishable' };
  w.fetch = async (url, init) => {
    requests.push({ url, ...init });
    return (options.fetch || (() => response(200, authResponse())))(url, init);
  };
  w.eval(source + '\nwindow.auth = {signIn, signUp, signOut, getUser, getSession, accessToken, selectRows, consumeRecoveryLink, updateRecoveryPassword};');
  return { w, auth: w.auth, storage, local, requests, changes };
}
function storageChanged(ctx) {
  const event = new ctx.w.Event('storage');
  Object.defineProperty(event, 'key', { value: sessionKey });
  ctx.w.dispatchEvent(event);
}

test('login persists tokens and minimum identity, without saving the password', async t => {
  const ctx = context(t);
  await ctx.auth.signIn('test@example.invalid', 'never-store-this-password');
  const saved = JSON.parse(ctx.storage.get(sessionKey));
  assert.equal(saved.user.id, 'test-user');
  assert.ok(saved.expires_at > Date.now());
  assert.equal(JSON.stringify(saved).includes('never-store-this-password'), false);
  assert.equal(ctx.w.sessionStorage.getItem(sessionKey), null);
  assert.deepEqual(Object.keys(saved).sort(), ['access_token', 'expires_at', 'refresh_token', 'user']);
});

test('closing the window and reopening the PWA restores the existing login without another sign-in', async t => {
  const first = context(t);
  await first.auth.signIn('test@example.invalid', 'test-password');
  const stored = first.storage;
  first.w.close();
  const reopened = context(t, { storage: stored });
  assert.equal(reopened.auth.getUser().id, 'test-user');
  assert.equal(await reopened.auth.accessToken(), 'test-access');
  assert.equal(reopened.requests.length, 0);
});

test('the current tab session migrates to persistent storage without changing its expiration', t => {
  const existing = session();
  const ctx = context(t, { legacy: existing });
  assert.equal(ctx.auth.getSession().expires_at, existing.expires_at);
  assert.equal(JSON.parse(ctx.storage.get(sessionKey)).expires_at, existing.expires_at);
  assert.equal(ctx.w.sessionStorage.getItem(sessionKey), null);
});

test('reopening after access-token expiry rotates and persists tokens automatically', async t => {
  const storage = new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]);
  const ctx = context(t, { storage, fetch: () => response(200, authResponse({ access_token: 'renewed-access', refresh_token: 'renewed-refresh' })) });
  assert.equal(await ctx.auth.accessToken(), 'renewed-access');
  assert.equal(ctx.requests.length, 1);
  assert.match(ctx.requests[0].url, /grant_type=refresh_token/);
  assert.equal(JSON.parse(ctx.requests[0].body).refresh_token, 'test-refresh');
  assert.equal(JSON.parse(storage.get(sessionKey)).refresh_token, 'renewed-refresh');
  assert.equal(context(t, { storage }).auth.getSession().access_token, 'renewed-access');
});

test('concurrent requests rotate an expired token only once in the same window', async t => {
  const gate = deferred();
  const ctx = context(t, { storage: new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]), fetch: () => gate.promise });
  const requests = [ctx.auth.accessToken(), ctx.auth.accessToken(), ctx.auth.accessToken()];
  gate.resolve(response(200, authResponse({ access_token: 'once' })));
  assert.deepEqual(await Promise.all(requests), ['once','once','once']);
  assert.equal(ctx.requests.length, 1);
});

test('Web Locks prevent separate tabs from rotating the same refresh token concurrently', async t => {
  let chain = Promise.resolve();
  const locks = { request: (_name, action) => { const result = chain.then(action); chain = result.catch(() => {}); return result; } };
  const storage = new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]);
  const fetch = () => response(200, authResponse({ access_token: 'shared-new', refresh_token: 'shared-refresh' }));
  const a = context(t, { storage, locks, fetch }), b = context(t, { storage, locks, fetch });
  const tokens = await Promise.all([a.auth.accessToken(), b.auth.accessToken()]);
  assert.deepEqual(tokens, ['shared-new', 'shared-new']);
  assert.equal(a.requests.length + b.requests.length, 1);
});

test('network failures retain the login so a later request can renew it', async t => {
  let connected = false;
  const storage = new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]);
  const ctx = context(t, { storage, fetch: () => { if (!connected) throw new Error('offline'); return response(200, authResponse()); } });
  await assert.rejects(ctx.auth.accessToken(), /Sem conexão/);
  assert.equal(ctx.auth.getUser().id, 'test-user');
  assert.equal(JSON.parse(storage.get(sessionKey)).refresh_token, 'test-refresh');
  assert.equal(ctx.changes.length, 0);
  connected = true;
  assert.equal(await ctx.auth.accessToken(), 'test-access');
});

test('server outages and rate limits do not erase the persistent session', async t => {
  for (const status of [500, 503, 429]) {
    const storage = new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]);
    const ctx = context(t, { storage, fetch: () => response(status, { message: 'Try later' }) });
    await assert.rejects(ctx.auth.accessToken());
    assert.equal(ctx.auth.getUser().id, 'test-user');
    assert.ok(storage.has(sessionKey));
    assert.equal(ctx.changes.length, 0);
  }
});

test('a refresh token rejected by the server removes the expired session and requests login', async t => {
  const storage = new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]);
  const ctx = context(t, { storage, fetch: () => response(400, { error_code: 'refresh_token_not_found', message: 'Invalid Refresh Token' }) });
  await assert.rejects(ctx.auth.accessToken(), /sessão expirou/);
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(storage.has(sessionKey), false);
  assert.equal(ctx.changes.at(-1).reason, 'expired');
});

test('Sair clears storage immediately, even when server logout is slow', async t => {
  const gate = deferred();
  const storage = new Map([[sessionKey, JSON.stringify(session())]]);
  const ctx = context(t, { storage, fetch: () => gate.promise });
  const signingOut = ctx.auth.signOut();
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(storage.has(sessionKey), false);
  assert.equal(context(t, { storage }).auth.getUser(), null);
  assert.match(ctx.requests[0].url, /logout\?scope=local$/);
  gate.resolve(response(204, {}));
  await signingOut;
});

test('Sair keeps the device signed out even without internet', async t => {
  const ctx = context(t, { storage: new Map([[sessionKey, JSON.stringify(session())]]), fetch: () => { throw new Error('offline'); } });
  await ctx.auth.signOut();
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(ctx.storage.has(sessionKey), false);
  await assert.rejects(ctx.auth.accessToken(), /Entre na sua conta/);
});

test('an in-flight refresh cannot restore a session after Sair', async t => {
  const gate = deferred();
  const ctx = context(t, { storage: new Map([[sessionKey, JSON.stringify(session({ expires_at: 0 }))]]),
    fetch: url => url.includes('refresh_token') ? gate.promise : response(204, {}) });
  const refreshing = ctx.auth.accessToken();
  await ctx.auth.signOut();
  gate.resolve(response(200, authResponse({ access_token: 'must-not-restore' })));
  await assert.rejects(refreshing, /sessão foi encerrada/);
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(ctx.storage.has(sessionKey), false);
});

test('sign-out in another tab also clears the open window and its legacy session', t => {
  const storage = new Map([[sessionKey, JSON.stringify(session())]]);
  const ctx = context(t, { storage });
  ctx.w.sessionStorage.setItem(sessionKey, JSON.stringify(session()));
  storage.delete(sessionKey);
  storageChanged(ctx);
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(ctx.w.sessionStorage.getItem(sessionKey), null);
  assert.equal(ctx.changes.at(-1).user, null);
});

test('a refreshed session in another tab is adopted without signing in again', async t => {
  const storage = new Map([[sessionKey, JSON.stringify(session())]]);
  const ctx = context(t, { storage });
  storage.set(sessionKey, JSON.stringify(session({ access_token: 'other-tab-new', refresh_token: 'other-tab-refresh' })));
  storageChanged(ctx);
  assert.equal(await ctx.auth.accessToken(), 'other-tab-new');
  assert.equal(ctx.requests.length, 0);
  assert.equal(ctx.changes.length, 0);
});

test('malformed stored sessions do not crash startup or count as a login', t => {
  for (const value of ['{broken-json', JSON.stringify({ access_token: 123, refresh_token: 'r', user: { id: 'u' } }), 'null']) {
    const ctx = context(t, { storage: new Map([[sessionKey, value]]) });
    assert.equal(ctx.auth.getUser(), null);
  }
});

test('a database request retries one rejected access token after refreshing the session', async t => {
  let restCalls = 0;
  const ctx = context(t, { storage: new Map([[sessionKey, JSON.stringify(session())]]), fetch: url => {
    if (url.includes('/auth/')) return response(200, authResponse({ access_token: 'fresh-database-token' }));
    return ++restCalls === 1 ? response(401, {}) : response(200, [{ id: 'owned-event' }]);
  } });
  const result = await ctx.auth.selectRows('events', { user_id: 'eq.test-user' });
  assert.equal(result[0].id, 'owned-event');
  assert.equal(ctx.requests.length, 3);
  assert.equal(ctx.requests.at(-1).headers.Authorization, 'Bearer fresh-database-token');
});

test('a recovery link never becomes a persistent login and is removed from the URL', t => {
  const ctx = context(t);
  ctx.w.location.hash = 'type=recovery&access_token=recovery-only&refresh_token=must-not-persist';
  assert.equal(ctx.auth.consumeRecoveryLink(), true);
  assert.equal(ctx.w.location.hash, '');
  assert.equal(ctx.auth.getUser(), null);
  assert.equal(ctx.storage.has(sessionKey), false);
});
