import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';

const port = Number(process.env.PORT || 4173);
const origin = 'http://localhost:' + port;
const redirect = origin + '/oauth/callback';
const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const data = resolve(process.env.AGENDA_DATA_DIR || process.env.LOCALAPPDATA || 'data',
  process.env.AGENDA_DATA_DIR || !process.env.LOCALAPPDATA ? '' : 'TuAgendando');
mkdirSync(data, { recursive: true, mode: 0o700 });
const db = resolve(data, 'agenda.json');
let state;
try {
  state = JSON.parse(readFileSync(db, 'utf8'));
  state.events ||= [];
  state.googleTokens ||= {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = { events: [], googleTokens: {} };
}
function save(next) {
  writeFileSync(db + '.tmp', JSON.stringify(next), { mode: 0o600 });
  renameSync(db + '.tmp', db);
  state = next;
}

const googleClientId = process.env.GOOGLE_CLIENT_ID || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
const googleReady = Boolean(googleClientId && googleClientSecret);
const oauth = new Map();
const accessCache = new Map();
const accessFlights = new Map();
const verifiedUsers = new Map();
const zone = 'America/Sao_Paulo';
const calendarScope = 'https://www.googleapis.com/auth/calendar.events.owned';
const googlePrimary = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
function readyForSupabase() { return Boolean(supabaseUrl.startsWith('https://') && publishableKey); }
async function currentUser(req) {
  if (!readyForSupabase()) fail(503, 'Configure o Supabase no arquivo .env.');
  const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/)?.[1];
  if (!bearer) fail(401, 'Entre na sua conta para continuar.');
  const cached = verifiedUsers.get(bearer);
  if (cached?.until > Date.now()) return cached.user;
  for (const [key, value] of verifiedUsers) if (value.until <= Date.now()) verifiedUsers.delete(key);
  let response;
  try {
    response = await fetch(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: publishableKey, Authorization: 'Bearer ' + bearer },
      signal: AbortSignal.timeout(10000), cache: 'no-store',
    });
  } catch { fail(503, 'Não foi possível validar sua sessão.'); }
  if (!response.ok) fail(401, 'Sua sessão expirou. Entre novamente.');
  const profile = await response.json();
  if (!profile.id) fail(401, 'Sua sessão expirou. Entre novamente.');
  const user = { id: profile.id, email: profile.email || '' };
  verifiedUsers.set(bearer, { user, until: Date.now() + 45000 });
  return user;
}
async function tokenRequest(fields) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: googleClientId, client_secret: googleClientSecret, ...fields }),
    signal: AbortSignal.timeout(12000), cache: 'no-store',
  });
  if (!response.ok) fail(502, 'A autorização do Google expirou ou falhou. Reconecte sua conta.');
  return response.json();
}
async function accessToken(userId) {
  const account = state.googleTokens?.[userId];
  if (!googleReady || !account?.refreshToken) fail(409, 'Conecte o Google Agenda primeiro.');
  const saved = accessCache.get(userId);
  if (saved?.until > Date.now()) return saved.value;
  if (accessFlights.has(userId)) return accessFlights.get(userId);
  const flight = tokenRequest({ grant_type: 'refresh_token', refresh_token: account.refreshToken })
    .then(result => {
      accessCache.set(userId, { value: result.access_token, until: Date.now() + Math.max(30, result.expires_in - 60) * 1000 });
      return result.access_token;
    }).finally(() => accessFlights.delete(userId));
  accessFlights.set(userId, flight);
  return flight;
}
async function google(userId, path = '', options = {}) {
  const response = await fetch(googlePrimary + path, {
    method: options.method || 'GET',
    headers: {
      Authorization: 'Bearer ' + await accessToken(userId),
      ...(options.body && { 'Content-Type': 'application/json' }),
      ...(options.etag && { 'If-Match': options.etag }),
    },
    body: options.body && JSON.stringify(options.body),
    signal: AbortSignal.timeout(12000), cache: 'no-store',
  });
  if (response.status === 412) fail(409, 'Este compromisso mudou no Google. Atualize a agenda e abra o evento novamente.');
  if ([404, 410].includes(response.status)) fail(404, 'O compromisso já foi removido ou não está disponível.');
  if (response.status === 401) fail(409, 'A autorização do Google expirou. Reconecte sua conta.');
  if (!response.ok) fail(502, 'O Google Agenda não concluiu a operação. Tente novamente.');
  return response.status === 204 ? null : response.json();
}
function normalize(event) {
  const rawCategory = event.extendedProperties?.private?.tuAgendandoCategory ||
    event.extendedProperties?.private?.tuAgendandoCategory;
  return {
    id: event.id, source: 'google', etag: event.etag, title: event.summary || '(Sem título)',
    category: ['pf', 'pj'].includes(rawCategory) ? rawCategory : '',
    start: event.start.dateTime || event.start.date, end: event.end.dateTime || event.end.date,
    allDay: Boolean(event.start.date), notes: event.description || '', location: event.location || '',
    recurring: Boolean(event.recurringEventId), locked: Boolean(event.locked || (event.eventType && event.eventType !== 'default')),
  };
}
async function listGoogle(userId, from, to) {
  const query = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: 'true', maxResults: '250' });
  const events = [];
  do {
    const result = await google(userId, '?' + query);
    events.push(...(result.items || []).filter(event => event.start && event.end && event.status !== 'cancelled').map(normalize));
    if (!result.nextPageToken) return events;
    query.set('pageToken', result.nextPageToken);
  } while (events.length < 10000);
  fail(502, 'Há muitos compromissos neste período. Escolha um intervalo menor.');
}

const day = /^\d{4}-\d{2}-\d{2}$/;
function validDate(value, allDay) {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && (allDay
    ? day.test(value) && new Date(ms).toISOString().slice(0, 10) === value
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(ms).toISOString() === value);
}
function eventFields(event) {
  const allDay = event?.allDay === true;
  if (typeof event?.title !== 'string' || !event.title.trim() || event.title.length > 180 ||
      !['pf', 'pj'].includes(event.category) || !validDate(event.start, allDay) ||
      !validDate(event.end, allDay) || event.start >= event.end ||
      typeof event.notes !== 'string' || event.notes.length > 4000 ||
      typeof event.location !== 'string' || event.location.length > 300) {
    fail(400, 'Confira o título, a categoria, o local e os horários.');
  }
  return { title: event.title.trim(), category: event.category, start: event.start, end: event.end,
    allDay, notes: event.notes, location: event.location };
}
function googleFields(event) {
  return { summary: event.title, description: event.notes, location: event.location,
    start: event.allDay ? { date: event.start } : { dateTime: event.start, timeZone: zone },
    end: event.allDay ? { date: event.end } : { dateTime: event.end, timeZone: zone },
    extendedProperties: { private: { tuAgendandoCategory: event.category } },
  };
}
async function jsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) fail(415, 'Formato inválido.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32000) fail(413, 'Solicitação muito longa.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); }
  catch { fail(400, 'Formato inválido.'); }
}
let writes = Promise.resolve();
function write(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}
const assets = new Map(Object.entries({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/supabase.js': ['supabase.js', 'text/javascript; charset=utf-8'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/brand-logo.png': ['brand-logo.png', 'image/png'],
}));
const server = createServer(async (req, res) => {
  const connectOrigin = readyForSupabase() ? new URL(supabaseUrl).origin : "'self'";
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${connectOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  const reply = (payload, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  };
  const move = path => { res.writeHead(303, { Location: path }); res.end(); };
  try {
    if (req.headers.host !== 'localhost:' + port) fail(403, 'Abra pelo endereço localhost.');
    const url = new URL(req.url, origin);
    const { pathname: path, searchParams: params } = url;
    const method = req.method;
    if (method !== 'GET' && req.headers.origin !== origin) fail(403, 'Origem inválida.');
    if (req.headers['sec-fetch-site'] === 'cross-site' && path !== '/' && path !== '/oauth/callback') fail(403, 'Origem inválida.');

    if (method === 'GET' && path === '/config.js') {
      const config = { url: readyForSupabase() ? supabaseUrl : '', publishableKey: readyForSupabase() ? publishableKey : '' };
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end('window.TU_AGENDANDO_CONFIG = Object.freeze(' + JSON.stringify(config) + ');');
    }
    if (method === 'GET' && assets.has(path)) {
      const [file, type] = assets.get(path);
      const bytes = readFileSync(new URL('./public/' + file, import.meta.url));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(bytes);
    }

    if (path === '/oauth/callback' && method === 'GET') {
      const id = params.get('state');
      const cookie = req.headers.cookie?.match(/(?:^|; )tu_google_oauth=([A-Za-z0-9_-]+)/)?.[1];
      const pending = oauth.get(id);
      if (!pending || cookie !== id || pending.until < Date.now()) return move('/?google=invalid');
      oauth.delete(id);
      res.setHeader('Set-Cookie', 'tu_google_oauth=; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=0');
      if (!params.get('code')) return move('/?google=cancelled');
      try {
        await write(async () => {
          const result = await tokenRequest({ code: params.get('code'), code_verifier: pending.verifier,
            grant_type: 'authorization_code', redirect_uri: redirect });
          if (!result.refresh_token || !result.scope?.split(' ').includes(calendarScope)) fail(409, 'Permissão insuficiente.');
          let email = '';
          try {
            const identity = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
              headers: { Authorization: 'Bearer ' + result.access_token }, signal: AbortSignal.timeout(8000), cache: 'no-store',
            });
            if (identity.ok) email = (await identity.json()).email || '';
          } catch { /* O acesso à agenda não depende da leitura do e-mail. */ }
          const googleTokens = { ...(state.googleTokens || {}), [pending.userId]: { refreshToken: result.refresh_token, email } };
          save({ ...state, googleTokens });
          accessCache.delete(pending.userId);
        });
        return move('/?google=connected');
      } catch { return move('/?google=error'); }
    }

    if (path === '/api/google/status' && method === 'GET') {
      const user = await currentUser(req);
      const account = state.googleTokens?.[user.id];
      return reply({ ready: googleReady, connected: Boolean(googleReady && account?.refreshToken), email: account?.email || '' });
    }
    if (path === '/api/google/connect' && method === 'POST') {
      const user = await currentUser(req);
      if (!googleReady) fail(409, 'Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no arquivo .env.');
      for (const [key, value] of oauth) if (value.until < Date.now()) oauth.delete(key);
      const id = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      oauth.set(id, { verifier, userId: user.id, until: Date.now() + 600000 });
      res.setHeader('Set-Cookie', 'tu_google_oauth=' + id + '; HttpOnly; SameSite=Lax; Path=/oauth/callback; Max-Age=600');
      const query = new URLSearchParams({ client_id: googleClientId, redirect_uri: redirect, response_type: 'code',
        scope: 'openid email ' + calendarScope, access_type: 'offline', prompt: 'consent select_account', state: id,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
      return reply({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query });
    }
    if (path === '/api/google/disconnect' && method === 'POST') {
      const user = await currentUser(req);
      const account = state.googleTokens?.[user.id];
      if (account?.refreshToken) {
        const response = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST', body: new URLSearchParams({ token: account.refreshToken }), signal: AbortSignal.timeout(12000), cache: 'no-store',
        });
        if (!response.ok && response.status !== 400) fail(502, 'Tente desconectar novamente.');
      }
      await write(async () => {
        const googleTokens = { ...(state.googleTokens || {}) };
        delete googleTokens[user.id];
        save({ ...state, googleTokens });
        accessCache.delete(user.id);
      });
      return reply({});
    }
    if (path === '/api/google/events' && method === 'GET') {
      const user = await currentUser(req);
      const from = params.get('from'), to = params.get('to');
      if (!validDate(from, false) || !validDate(to, false) || Date.parse(to) - Date.parse(from) > 50 * 86400000 || from >= to) {
        fail(400, 'Período inválido.');
      }
      return reply({ events: await listGoogle(user.id, from, to) });
    }
    if (path === '/api/google/events' && method === 'POST') {
      const user = await currentUser(req);
      const body = await jsonBody(req);
      const event = eventFields(body);
      if (typeof body.id !== 'string' || !/^[a-f0-9]{32}$/.test(body.id)) fail(400, 'Identificador inválido.');
      let saved;
      try {
        saved = await google(user.id, '', { method: 'POST', body: { ...googleFields(event), id: body.id } });
      } catch (error) {
        if (error.status !== 502) throw error;
        saved = await google(user.id, '/' + body.id);
      }
      return reply(normalize(saved), 201);
    }
    const googleMatch = path.match(/^\/api\/google\/events\/([A-Za-z0-9_-]{1,1024})$/);
    if (googleMatch && ['PATCH', 'DELETE'].includes(method)) {
      const user = await currentUser(req);
      const id = googleMatch[1];
      const body = await jsonBody(req);
      if (typeof body?.etag !== 'string' || !body.etag || body.etag.length > 256) fail(400, 'Reabra o compromisso.');
      if (method === 'DELETE') {
        await google(user.id, '/' + id + '?sendUpdates=none', { method, etag: body.etag });
        return reply({});
      }
      const event = eventFields(body);
      return reply(normalize(await google(user.id, '/' + id + '?sendUpdates=none', {
        method, etag: body.etag, body: googleFields(event),
      })));
    }

    if (path === '/api/legacy/meta' && method === 'GET') {
      const user = await currentUser(req);
      return reply({ count: Array.isArray(state.events) ? state.events.length : 0,
        claimed: Boolean(state.legacyImportedUserId), claimedByCurrentUser: state.legacyImportedUserId === user.id });
    }
    if (path === '/api/legacy/claim' && method === 'POST') {
      const user = await currentUser(req);
      if (state.legacyImportedUserId && state.legacyImportedUserId !== user.id) fail(409, 'Os dados antigos já foram vinculados a outra conta.');
      return reply({ events: Array.isArray(state.events) ? state.events : [] });
    }
    if (path === '/api/legacy/complete' && method === 'POST') {
      const user = await currentUser(req);
      const body = await jsonBody(req);
      if (!Number.isInteger(body.count) || body.count !== (state.events || []).length) fail(409, 'A importação não foi concluída. Tente novamente.');
      await write(async () => {
        if (state.legacyImportedUserId && state.legacyImportedUserId !== user.id) fail(409, 'Os dados antigos já foram vinculados a outra conta.');
        save({ ...state, legacyImportedUserId: user.id });
      });
      return reply({});
    }

    fail(404, 'Página não encontrada.');
  } catch (error) {
    if (!res.headersSent) reply({ error: error.status ? error.message : 'Não foi possível concluir a operação.' }, error.status || 500);
  }
});
server.listen(port, 'localhost', () => console.log('Tu Agendando em ' + origin));

