import {
  createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual,
} from 'node:crypto';

const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const serverKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const clientId = process.env.GOOGLE_CLIENT_ID || '';
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const calendarScope = 'https://www.googleapis.com/auth/calendar.events.owned';
const googleEventsUrl = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const oauthCookieName = 'tu_google_oauth';
const oauthAad = Buffer.from('tu-agendando-google-oauth-v1');
const zone = 'America/Sao_Paulo';

function configuredOrigin() {
  try {
    const value = new URL(process.env.APP_ORIGIN || '');
    if (value.protocol !== 'https:' || value.pathname !== '/' || value.search || value.hash) return '';
    return value.origin;
  } catch { return ''; }
}
const appOrigin = configuredOrigin();

function stateKey() {
  const value = process.env.OAUTH_STATE_SECRET || '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value ? bytes : null;
}
const oauthKey = stateKey();

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}
function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}
function errorResponse(error) {
  if (!error?.status) console.error('Tu Agendando API error:', error?.name || 'unknown');
  return json({ error: error?.status ? error.message : 'Não foi possível concluir a operação.' },
    error?.status || 500);
}
function expectMethod(request, allowed) {
  if (!allowed.includes(request.method)) fail(405, 'Método não permitido.');
}
function sameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) fail(403, 'Origem inválida.');
  if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Origem inválida.');
}
function googleReady(request) {
  return Boolean(supabaseUrl.startsWith('https://') && publishableKey &&
    serverKey && serverKey !== publishableKey && clientId && clientSecret &&
    oauthKey && appOrigin && appOrigin === new URL(request.url).origin);
}
async function currentUser(request) {
  if (!supabaseUrl.startsWith('https://') || !publishableKey) {
    fail(503, 'Configure o Supabase na Vercel.');
  }
  const bearer = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
  if (!bearer) fail(401, 'Entre na sua conta para continuar.');
  let response;
  try {
    response = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: publishableKey, Authorization: 'Bearer ' + bearer },
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
  } catch { fail(503, 'Não foi possível validar sua sessão.'); }
  if (!response.ok) fail(401, 'Sua sessão expirou. Entre novamente.');
  const profile = await response.json().catch(() => ({}));
  if (!/^[0-9a-f-]{36}$/i.test(profile.id || '')) fail(401, 'Sua sessão expirou. Entre novamente.');
  return { id: profile.id, email: profile.email || '' };
}
async function serviceRpc(name, values) {
  if (!serverKey || serverKey === publishableKey || !supabaseUrl.startsWith('https://')) {
    fail(503, 'A integração com o Google ainda não está configurada.');
  }
  let response;
  try {
    response = await fetch(supabaseUrl + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        apikey: serverKey,
        Authorization: 'Bearer ' + serverKey,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(values),
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
    });
  } catch { fail(503, 'O armazenamento seguro do Google está indisponível.'); }
  if (!response.ok) {
    console.error('Tu Agendando Google storage status:', response.status);
    fail(503, 'O armazenamento seguro do Google está indisponível.');
  }
  return response.status === 204 ? null : response.json();
}
async function credentials(userId) {
  const rows = await serviceRpc('google_oauth_token_read', { p_user_id: userId });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}
async function storeCredentials(userId, refreshToken, email) {
  await serviceRpc('google_oauth_token_store', {
    p_user_id: userId, p_refresh_token: refreshToken, p_account_email: email || null,
  });
}
async function removeCredentials(userId) {
  await serviceRpc('google_oauth_token_delete', { p_user_id: userId });
}
async function tokenRequest(fields) {
  let response;
  try {
    response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, ...fields,
      }),
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
    });
  } catch { fail(502, 'Não foi possível acessar o Google. Tente novamente.'); }
  if (!response.ok) {
    fail(response.status === 400 ? 409 : 502,
      'A autorização do Google falhou ou expirou. Reconecte sua conta.');
  }
  return response.json();
}
async function googleAccessToken(userId) {
  const account = await credentials(userId);
  if (!account?.refresh_token) fail(409, 'Conecte o Google Agenda primeiro.');
  const token = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: account.refresh_token,
  });
  if (!token.access_token) fail(409, 'Reconecte o Google Agenda.');
  return token.access_token;
}
async function googleRequest(userId, path = '', options = {}) {
  let response;
  try {
    response = await fetch(googleEventsUrl + path, {
      method: options.method || 'GET',
      headers: {
        Authorization: 'Bearer ' + await googleAccessToken(userId),
        ...(options.body && { 'Content-Type': 'application/json' }),
        ...(options.etag && { 'If-Match': options.etag }),
      },
      ...(options.body && { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(12000),
      cache: 'no-store',
    });
  } catch { fail(502, 'Não foi possível acessar o Google Agenda. Tente novamente.'); }
  if (response.status === 412) fail(409, 'Este compromisso mudou no Google. Atualize a agenda.');
  if ([404, 410].includes(response.status)) fail(404, 'Este compromisso não está mais disponível.');
  if (response.status === 401) fail(409, 'A autorização do Google expirou. Reconecte sua conta.');
  if (response.status === 409) fail(409, 'Este compromisso já existe no Google Agenda.');
  if (!response.ok) fail(502, 'O Google Agenda não concluiu a operação.');
  return response.status === 204 ? null : response.json();
}
function normalize(event) {
  const category = event.extendedProperties?.private?.tuAgendandoCategory ||
    event.extendedProperties?.private?.agendaAquiCategory;
  return {
    id: event.id, source: 'google', etag: event.etag,
    title: event.summary || '(Sem título)',
    category: ['pf', 'pj'].includes(category) ? category : '',
    start: event.start.dateTime || event.start.date,
    end: event.end.dateTime || event.end.date,
    allDay: Boolean(event.start.date),
    notes: event.description || '', location: event.location || '',
    recurring: Boolean(event.recurringEventId),
    locked: Boolean(event.locked || (event.eventType && event.eventType !== 'default')),
  };
}
async function listEvents(userId, from, to) {
  const query = new URLSearchParams({
    timeMin: from, timeMax: to, singleEvents: 'true', maxResults: '250',
  });
  const events = [];
  do {
    const result = await googleRequest(userId, '?' + query);
    events.push(...(result.items || [])
      .filter(event => event.start && event.end && event.status !== 'cancelled')
      .map(normalize));
    if (!result.nextPageToken) return events;
    query.set('pageToken', result.nextPageToken);
  } while (events.length < 10000);
  fail(502, 'Há muitos compromissos neste período. Escolha um intervalo menor.');
}
function validDate(value, allDay) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && (allDay
    ? /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(ms).toISOString().slice(0, 10) === value
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      new Date(ms).toISOString() === value);
}
function eventFields(body) {
  const allDay = body?.allDay === true;
  if (typeof body?.title !== 'string' || !body.title.trim() || body.title.length > 180 ||
      !['pf', 'pj'].includes(body.category) || !validDate(body.start, allDay) ||
      !validDate(body.end, allDay) || body.start >= body.end ||
      typeof body.notes !== 'string' || body.notes.length > 4000 ||
      typeof body.location !== 'string' || body.location.length > 300) {
    fail(400, 'Confira o título, a agenda, o local e os horários.');
  }
  return {
    title: body.title.trim(), category: body.category, start: body.start, end: body.end,
    allDay, notes: body.notes, location: body.location,
  };
}
function googleFields(event) {
  return {
    summary: event.title, description: event.notes, location: event.location,
    start: event.allDay ? { date: event.start } : { dateTime: event.start, timeZone: zone },
    end: event.allDay ? { date: event.end } : { dateTime: event.end, timeZone: zone },
    extendedProperties: { private: { tuAgendandoCategory: event.category } },
  };
}
async function jsonBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    fail(415, 'Formato inválido.');
  }
  if (Number(request.headers.get('content-length') || 0) > 32000) fail(413, 'Solicitação muito longa.');
  const text = await request.text();
  if (text.length > 32000) fail(413, 'Solicitação muito longa.');
  try { return JSON.parse(text); }
  catch { fail(400, 'Formato inválido.'); }
}
function seal(payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', oauthKey, iv);
  cipher.setAAD(oauthAad);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
function unseal(value) {
  const data = Buffer.from(value, 'base64url');
  if (data.length < 29) fail(400, 'Estado OAuth inválido.');
  const decipher = createDecipheriv('aes-256-gcm', oauthKey, data.subarray(0, 12));
  decipher.setAAD(oauthAad);
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
}
function cookieValue(request) {
  return request.headers.get('cookie')?.match(/(?:^|;\s*)tu_google_oauth=([A-Za-z0-9_-]+)/)?.[1] || '';
}
function clearCookie() {
  return oauthCookieName + '=; Path=/oauth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
function move(outcome) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/?google=' + outcome,
      'Set-Cookie': clearCookie(),
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
async function connect(request, user) {
  if (!googleReady(request)) fail(409, 'Configure a integração Google na Vercel.');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const cookie = seal({ state, verifier, userId: user.id, expiresAt: Date.now() + 600000 });
  const query = new URLSearchParams({
    client_id: clientId, redirect_uri: appOrigin + '/oauth/callback',
    response_type: 'code', scope: 'openid email ' + calendarScope,
    access_type: 'offline', prompt: 'consent select_account', state,
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query }, 200, {
    'Set-Cookie': oauthCookieName + '=' + cookie +
      '; Path=/oauth/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600',
  });
}
export async function handleOAuthCallback(request) {
  try {
    expectMethod(request, ['GET']);
    if (!googleReady(request)) return move('error');
    const params = new URL(request.url).searchParams;
    const state = params.get('state') || '';
    const cookie = cookieValue(request);
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !cookie) return move('invalid');
    let pending;
    try { pending = unseal(cookie); } catch { return move('invalid'); }
    if (pending.expiresAt <= Date.now() ||
        !/^[0-9a-f-]{36}$/i.test(pending.userId || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier || '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(pending.state || '') ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
      return move('invalid');
    }
    if (!params.get('code')) return move('cancelled');
    const result = await tokenRequest({
      code: params.get('code'), code_verifier: pending.verifier,
      grant_type: 'authorization_code',
      redirect_uri: appOrigin + '/oauth/callback',
    });
    if (!result.refresh_token || !result.scope?.split(' ').includes(calendarScope)) {
      return move('error');
    }
    let email = '';
    try {
      const identity = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: 'Bearer ' + result.access_token },
        signal: AbortSignal.timeout(8000), cache: 'no-store',
      });
      if (identity.ok) email = String((await identity.json()).email || '').slice(0, 320);
    } catch { /* A agenda não depende da leitura do e-mail. */ }
    await storeCredentials(pending.userId, result.refresh_token, email);
    return move('connected');
  } catch { return move('error'); }
}
async function disconnect(userId) {
  const account = await credentials(userId);
  if (account?.refresh_token) {
    let response;
    try {
      response = await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        body: new URLSearchParams({ token: account.refresh_token }),
        signal: AbortSignal.timeout(12000), cache: 'no-store',
      });
    } catch { fail(502, 'Tente desconectar novamente.'); }
    if (!response.ok && response.status !== 400) fail(502, 'Tente desconectar novamente.');
  }
  await removeCredentials(userId);
  return json({});
}
export async function handleGoogle(request, operation, id = null) {
  try {
    const methods = {
      status: ['GET'], connect: ['POST'], disconnect: ['POST'],
      events: ['GET', 'POST'], event: ['PATCH', 'DELETE'],
    };
    if (!methods[operation]) fail(404, 'Página não encontrada.');
    expectMethod(request, methods[operation]);
    if (request.method !== 'GET') sameOrigin(request);
    const user = await currentUser(request);
    if (operation === 'status') {
      const ready = googleReady(request);
      const account = ready ? await credentials(user.id) : null;
      return json({ ready, connected: Boolean(account?.refresh_token), email: account?.account_email || '' });
    }
    if (operation === 'connect') return connect(request, user);
    if (!googleReady(request)) fail(409, 'Configure a integração Google na Vercel.');
    if (operation === 'disconnect') return disconnect(user.id);
    if (operation === 'events' && request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const from = params.get('from'), to = params.get('to');
      if (!validDate(from, false) || !validDate(to, false) || from >= to ||
          Date.parse(to) - Date.parse(from) > 50 * 86400000) {
        fail(400, 'Período inválido.');
      }
      return json({ events: await listEvents(user.id, from, to) });
    }
    if (operation === 'events') {
      const body = await jsonBody(request);
      const event = eventFields(body);
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) {
        fail(400, 'Identificador inválido.');
      }
      let saved;
      try {
        saved = await googleRequest(user.id, '', {
          method: 'POST', body: { ...googleFields(event), id: body.id },
        });
      } catch (error) {
        if (![409, 502].includes(error.status)) throw error;
        saved = await googleRequest(user.id, '/' + body.id);
      }
      return json(normalize(saved), 201);
    }
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(id)) {
      fail(400, 'Identificador inválido.');
    }
    const body = await jsonBody(request);
    if (typeof body?.etag !== 'string' || !body.etag || body.etag.length > 256) {
      fail(400, 'Reabra o compromisso.');
    }
    const path = '/' + encodeURIComponent(id) + '?sendUpdates=none';
    if (request.method === 'DELETE') {
      await googleRequest(user.id, path, { method: 'DELETE', etag: body.etag });
      return json({});
    }
    const event = eventFields(body);
    return json(normalize(await googleRequest(user.id, path, {
      method: 'PATCH', etag: body.etag, body: googleFields(event),
    })));
  } catch (error) { return errorResponse(error); }
}
export async function handleLegacy(request, action) {
  try {
    const methods = { meta: ['GET'], claim: ['POST'], complete: ['POST'] };
    if (!methods[action]) fail(404, 'Página não encontrada.');
    expectMethod(request, methods[action]);
    if (request.method !== 'GET') sameOrigin(request);
    await currentUser(request);
    if (action === 'meta') {
      return json({ count: 0, claimed: false, claimedByCurrentUser: false });
    }
    fail(410, 'A importação de dados locais só está disponível no servidor local.');
  } catch (error) { return errorResponse(error); }
}
