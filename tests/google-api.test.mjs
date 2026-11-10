import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'test-publishable';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role';
process.env.GOOGLE_CLIENT_ID = 'google-client';
process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
process.env.APP_ORIGIN = 'https://agenda.example';
process.env.OAUTH_STATE_SECRET = Buffer.alloc(32, 7).toString('base64url');

const { handleGoogle, handleOAuthCallback, handleLegacy } =
  await import('../lib/google-api.js');
const originalFetch = globalThis.fetch;
const userId = '11111111-1111-4111-8111-111111111111';
const calendarScope = 'https://www.googleapis.com/auth/calendar.events.owned';

afterEach(() => { globalThis.fetch = originalFetch; });

function request(path, method = 'GET', headers = {}, body) {
  return new Request('https://agenda.example' + path, {
    method,
    headers: {
      ...(method !== 'GET' && { Origin: 'https://agenda.example' }),
      ...headers,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}
function mockAuth() {
  globalThis.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) {
      return Response.json({ id: userId, email: 'dono@example.com' });
    }
    if (String(url).endsWith('/rest/v1/rpc/google_oauth_token_read')) {
      return Response.json([]);
    }
    throw new Error('Unexpected request: ' + url);
  };
}

test('API requires a valid session and rejects cross-origin writes', async () => {
  let response = await handleGoogle(request('/api/google/status'), 'status');
  assert.equal(response.status, 401);
  mockAuth();
  response = await handleGoogle(request('/api/google/connect', 'POST', {
    Authorization: 'Bearer user-jwt', Origin: 'https://evil.example',
  }), 'connect');
  assert.equal(response.status, 403);
});

test('status returns connection state without exposing a refresh token', async () => {
  mockAuth();
  const response = await handleGoogle(request('/api/google/status', 'GET', {
    Authorization: 'Bearer user-jwt',
  }), 'status');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ready: true, connected: false, email: '' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('OAuth callback rejects a changed state and stores credentials only on the server', async () => {
  mockAuth();
  const connected = await handleGoogle(request('/api/google/connect', 'POST', {
    Authorization: 'Bearer user-jwt',
  }), 'connect');
  assert.equal(connected.status, 200);
  const url = new URL((await connected.json()).url);
  const state = url.searchParams.get('state');
  const cookie = connected.headers.get('set-cookie')?.split(';')[0];
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(connected.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);

  const altered = (state[0] === 'a' ? 'b' : 'a') + state.slice(1);
  let response = await handleOAuthCallback(request(
    '/oauth/callback?state=' + altered + '&code=google-code', 'GET', { Cookie: cookie },
  ));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?google=invalid');

  let stored;
  globalThis.fetch = async (target, options = {}) => {
    const endpoint = String(target);
    if (endpoint === 'https://oauth2.googleapis.com/token') {
      return Response.json({
        access_token: 'google-access',
        refresh_token: 'google-refresh',
        scope: 'openid email ' + calendarScope,
      });
    }
    if (endpoint === 'https://openidconnect.googleapis.com/v1/userinfo') {
      return Response.json({ email: 'conta@example.com' });
    }
    if (endpoint.endsWith('/rest/v1/rpc/google_oauth_token_store')) {
      stored = {
        body: JSON.parse(options.body),
        key: options.headers.apikey,
      };
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected request: ' + endpoint);
  };
  response = await handleOAuthCallback(request(
    '/oauth/callback?state=' + state + '&code=google-code', 'GET', { Cookie: cookie },
  ));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/?google=connected');
  assert.deepEqual(stored, {
    body: {
      p_user_id: userId,
      p_refresh_token: 'google-refresh',
      p_account_email: 'conta@example.com',
    },
    key: 'test-service-role',
  });
});

test('invalid events are rejected before contacting Google', async () => {
  mockAuth();
  const response = await handleGoogle(request('/api/google/events', 'POST', {
    Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json',
  }, {
    id: 'a'.repeat(32), title: 'Trabalhar', category: 'wrong',
    start: '2026-11-10T12:00:00.000Z', end: '2026-11-10T12:30:00.000Z',
    notes: '', location: 'Escritório',
  }), 'events');
  assert.equal(response.status, 400);
});

test('legacy local data is not silently imported on a serverless deployment', async () => {
  mockAuth();
  const response = await handleLegacy(request('/api/legacy/meta', 'GET', {
    Authorization: 'Bearer user-jwt',
  }), 'meta');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    count: 0, claimed: false, claimedByCurrentUser: false,
  });
});
