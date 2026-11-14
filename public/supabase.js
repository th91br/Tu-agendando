const config = window.TU_AGENDANDO_CONFIG || {};
const baseUrl = String(config.url || '').replace(/\/$/, '');
const publishableKey = String(config.publishableKey || '');
const sessionKey = 'tu-agendando.auth.session.v1';
let current = restore();
let recoveryToken = null;
let refreshPromise = null;
let authRevision = 0;

function sessionValue(value) {
  if (typeof value?.access_token !== 'string' || !value.access_token ||
      typeof value?.refresh_token !== 'string' || !value.refresh_token ||
      typeof value?.user?.id !== 'string' || !value.user.id) return null;
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: Number.isFinite(value.expires_at) ? value.expires_at : 0,
    user: { id: value.user.id, email: typeof value.user.email === 'string' ? value.user.email : '' },
  };
}
function readSession(storage) {
  try { return sessionValue(JSON.parse(window[storage].getItem(sessionKey))); }
  catch { return null; }
}
function removeSession(storage) {
  try { window[storage].removeItem(sessionKey); } catch { /* Storage can be unavailable. */ }
}
function restore() {
  const saved = readSession('localStorage');
  if (saved) { removeSession('sessionStorage'); return saved; }
  const legacy = readSession('sessionStorage');
  if (!legacy) { removeSession('localStorage'); return null; }
  // Existing tab sessions already use milliseconds. Migrate without converting twice.
  try {
    localStorage.setItem(sessionKey, JSON.stringify(legacy));
    removeSession('sessionStorage');
  } catch { /* Keep the open tab session if persistent storage is unavailable. */ }
  return legacy;
}
function store(value) {
  const session = sessionValue({
    ...value,
    expires_at: Number.isFinite(value?.expires_at) ? value.expires_at * 1000 :
      Date.now() + (Number(value?.expires_in) || 3600) * 1000,
  });
  if (!session) throw new Error('O serviço não confirmou a sessão. Tente novamente.');
  try { localStorage.setItem(sessionKey, JSON.stringify(session)); }
  catch { throw new Error('Não foi possível manter seu login neste dispositivo. Confira as permissões de armazenamento do navegador.'); }
  current = session;
  removeSession('sessionStorage');
  return current;
}
function notifyAuth(reason) {
  window.dispatchEvent(new CustomEvent('tu-agendando:auth', { detail: { user: current?.user || null, reason } }));
}
function clear(reason = 'signed_out') {
  authRevision++;
  current = null;
  recoveryToken = null;
  removeSession('localStorage');
  removeSession('sessionStorage');
  notifyAuth(reason);
}
function syncStoredSession() {
  const saved = readSession('localStorage');
  const changed = current?.user.id !== saved?.user.id;
  current = saved;
  if (changed) {
    authRevision++;
    notifyAuth(current ? 'signed_in' : 'signed_out');
  }
  return current;
}
window.addEventListener('storage', event => {
  if (event.key !== null && event.key !== sessionKey) return;
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (!readSession('localStorage')) authRevision++;
  removeSession('sessionStorage');
  syncStoredSession();
});
function jsonHeaders(token = '') {
  return {
    apikey: publishableKey,
    ...(token && { Authorization: 'Bearer ' + token }),
    'Content-Type': 'application/json',
  };
}
async function readResponse(response) {
  const value = await response.json().catch(() => ({}));
  if (response.ok) return value;
  let text = value.msg || value.message || value.error_description || value.error;
  if (response.status === 401) text = 'Sua sessão expirou. Entre novamente.';
  else if (response.status === 403) text = 'A conta não tem acesso a esses dados.';
  else if (response.status === 409 || value.code === '23505') text = 'Este compromisso já existe ou foi alterado em outra sessão. Atualize a agenda.';
  else if (response.status >= 500) text = 'O serviço da agenda está temporariamente indisponível.';
  const error = new Error(typeof text === 'string' && text.length < 220 ? text : 'Confira os dados e tente novamente.');
  error.status = response.status;
  error.code = value.error_code || value.code;
  throw error;
}
async function authRequest(path, body) {
  if (!baseUrl || !publishableKey) throw new Error('A conexão com o Supabase não está configurada.');
  let response;
  try {
    response = await fetch(baseUrl + '/auth/v1/' + path, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body), cache: 'no-store',
    });
  } catch { throw new Error('Sem conexão com o serviço de autenticação.'); }
  return readResponse(response);
}
export function isConfigured() { return Boolean(baseUrl && publishableKey); }
export function getUser() { return current?.user || null; }
export function getSession() { return current; }
export async function signIn(email, password) {
  const revision = ++authRevision;
  try {
    const value = await authRequest('token?grant_type=password', { email, password });
    if (revision !== authRevision) throw new Error('Esta entrada foi cancelada. Entre novamente.');
    store(value);
    return { user: current.user, confirmationRequired: false };
  } catch (error) {
    if (/invalid login credentials|invalid_grant/i.test(error.message)) throw new Error('E-mail ou senha incorretos.');
    throw error;
  }
}
export async function signUp(email, password) {
  const revision = ++authRevision;
  const value = await authRequest('signup', { email, password });
  if (revision !== authRevision) throw new Error('Esta entrada foi cancelada. Entre novamente.');
  if (value.access_token) {
    store(value);
    return { user: current.user, confirmationRequired: false };
  }
  return { user: value.user || null, confirmationRequired: true };
}
export async function requestPasswordReset(email) {
  await authRequest('recover?redirect_to=' + encodeURIComponent(location.origin + '/'), { email });
}
export function consumeRecoveryLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get('type') !== 'recovery' || !params.get('access_token')) return false;
  recoveryToken = params.get('access_token');
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
export async function updateRecoveryPassword(password) {
  if (!recoveryToken) throw new Error('O link expirou. Solicite outro e-mail de recuperação.');
  let response;
  try {
    response = await fetch(baseUrl + '/auth/v1/user', {
      method: 'PUT', headers: jsonHeaders(recoveryToken),
      body: JSON.stringify({ password }), cache: 'no-store',
    });
  } catch { throw new Error('Sem conexão com o serviço de autenticação.'); }
  await readResponse(response);
  recoveryToken = null;
}
async function renew(force = false) {
  if (refreshPromise) return refreshPromise;
  const revision = authRevision;
  const originalToken = current?.access_token;
  const refresh = async () => {
    syncStoredSession();
    if (!current || revision !== authRevision) throw new Error('Sua sessão foi encerrada. Entre novamente.');
    if ((!force || current.access_token !== originalToken) && current.expires_at > Date.now() + 60_000) return current.access_token;
    const previous = current;
    try {
      const value = await authRequest('token?grant_type=refresh_token', { refresh_token: previous.refresh_token });
      const saved = readSession('localStorage');
      if (revision !== authRevision || !saved || saved.user.id !== previous.user.id) {
        syncStoredSession();
        throw new Error('Sua sessão foi encerrada. Entre novamente.');
      }
      if (saved.refresh_token !== previous.refresh_token && saved.expires_at > Date.now() + 60_000) {
        current = saved;
        return current.access_token;
      }
      store(value);
      return current.access_token;
    } catch (error) {
      // Network errors, rate limiting and server outages must not erase a usable refresh token.
      if (revision === authRevision && [400, 401, 403].includes(error.status)) {
        const saved = readSession('localStorage');
        if (saved && saved.user.id === previous.user.id && saved.refresh_token !== previous.refresh_token) {
          current = saved;
          if (current.expires_at > Date.now() + 60_000) return current.access_token;
        } else if (saved?.user.id === previous.user.id) {
          clear('expired');
          throw new Error('Sua sessão expirou. Entre novamente.');
        } else syncStoredSession();
      }
      throw error;
    }
  };
  // Web Locks serialize token rotation across tabs and installed windows of the same origin.
  refreshPromise = navigator.locks?.request
    ? navigator.locks.request(sessionKey + '.refresh', refresh) : refresh();
  try { return await refreshPromise; }
  finally { refreshPromise = null; }
}
export async function accessToken() {
  syncStoredSession();
  if (!current) throw new Error('Entre na sua conta para continuar.');
  if (current.expires_at > Date.now() + 60_000) return current.access_token;
  return renew();
}
export async function signOut() {
  const token = current?.access_token;
  // Clear first: closing the PWA or a slow logout request must not restore the session.
  clear();
  if (token) {
    try {
      await fetch(baseUrl + '/auth/v1/logout?scope=local', {
        method: 'POST', headers: jsonHeaders(token), cache: 'no-store',
      });
    } catch { /* The device stays signed out even without a network connection. */ }
  }
}
async function rest(path, method = 'GET', body, prefer = '') {
  if (!isConfigured()) throw new Error('A conexão com o Supabase não está configurada.');
  const send = async token => {
    try {
      return await fetch(baseUrl + '/rest/v1/' + path, {
        method, cache: 'no-store',
        headers: { ...jsonHeaders(token), ...(prefer && { Prefer: prefer }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch { throw new Error('Sem conexão com o banco da agenda. Verifique a internet e tente novamente.'); }
  };
  let response = await send(await accessToken());
  if (response.status === 401) response = await send(await renew(true));
  return readResponse(response);
}
export function selectRows(table, params = {}) {
  const query = new URLSearchParams(params);
  return rest(encodeURIComponent(table) + (query.size ? '?' + query : ''));
}
export function insertRows(table, rows, params = {}, prefer = 'return=representation') {
  const query = new URLSearchParams(params);
  return rest(encodeURIComponent(table) + (query.size ? '?' + query : ''), 'POST', rows, prefer);
}
export function updateRows(table, params, values, prefer = 'return=representation') {
  const query = new URLSearchParams(params);
  return rest(encodeURIComponent(table) + '?' + query, 'PATCH', values, prefer);
}
export function deleteRows(table, params, prefer = 'return=representation') {
  const query = new URLSearchParams(params);
  return rest(encodeURIComponent(table) + '?' + query, 'DELETE', undefined, prefer);
}
export function callRpc(name, body = {}) {
  return rest('rpc/' + encodeURIComponent(name), 'POST', body, 'return=minimal');
}
export async function importRows(table, rows) {
  const params = new URLSearchParams({ on_conflict: 'id' });
  return rest(encodeURIComponent(table) + '?' + params, 'POST', rows,
    'resolution=ignore-duplicates,return=minimal');
}
