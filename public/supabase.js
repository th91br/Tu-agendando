const config = window.TU_AGENDANDO_CONFIG || {};
const baseUrl = String(config.url || '').replace(/\/$/, '');
const publishableKey = String(config.publishableKey || '');
const sessionKey = 'tu-agendando.auth.session.v1';
let current = restore();
let recoveryToken = null;

function restore() {
  try {
    const value = JSON.parse(sessionStorage.getItem(sessionKey));
    return value?.access_token && value?.refresh_token && value?.user?.id ? value : null;
  } catch { return null; }
}
function store(value) {
  if (!value?.access_token || !value?.refresh_token || !value?.user?.id) {
    current = null;
    sessionStorage.removeItem(sessionKey);
    return null;
  }
  current = {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: value.expires_at ? value.expires_at * 1000 : Date.now() + (value.expires_in || 3600) * 1000,
    user: { id: value.user.id, email: value.user.email || '' },
  };
  sessionStorage.setItem(sessionKey, JSON.stringify(current));
  return current;
}
function clear() {
  current = null;
  sessionStorage.removeItem(sessionKey);
}
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
  if (response.status === 401) throw new Error('Sua sess�o expirou. Entre novamente.');
  if (response.status === 403) throw new Error('A conta n�o tem acesso a esses dados.');
  if (response.status === 409 || value.code === '23505') throw new Error('Este compromisso j� existe ou foi alterado em outra sess�o. Atualize a agenda.');
  if (response.status >= 500) throw new Error('O servi�o da agenda est� temporariamente indispon�vel.');
  const text = value.msg || value.message || value.error_description || value.error;
  throw new Error(text && text.length < 220 ? text : 'Confira os dados e tente novamente.');
}
async function authRequest(path, body) {
  if (!baseUrl || !publishableKey) throw new Error('A conex�o com o Supabase n�o est� configurada.');
  let response;
  try {
    response = await fetch(baseUrl + '/auth/v1/' + path, {
      method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body), cache: 'no-store',
    });
  } catch { throw new Error('Sem conex�o com o servi�o de autentica��o.'); }
  return readResponse(response);
}
export function isConfigured() { return Boolean(baseUrl && publishableKey); }
export function getUser() { return current?.user || null; }
export function getSession() { return current; }
export async function signIn(email, password) {
  try {
    const value = await authRequest('token?grant_type=password', { email, password });
    store(value);
    return { user: current.user, confirmationRequired: false };
  } catch (error) {
    if (/invalid login credentials|invalid_grant/i.test(error.message)) throw new Error('E-mail ou senha incorretos.');
    throw error;
  }
}
export async function signUp(email, password) {
  const value = await authRequest('signup', { email, password });
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
async function renew() {
  if (!current?.refresh_token) { clear(); throw new Error('Sua sess�o expirou. Entre novamente.'); }
  try {
    const value = await authRequest('token?grant_type=refresh_token', { refresh_token: current.refresh_token });
    store(value);
    return current.access_token;
  } catch {
    clear();
    throw new Error('Sua sess�o expirou. Entre novamente.');
  }
}
export async function accessToken() {
  if (!current) throw new Error('Entre na sua conta para continuar.');
  if (current.expires_at > Date.now() + 60_000) return current.access_token;
  return renew();
}
export async function signOut() {
  if (current?.access_token) {
    try {
      await fetch(baseUrl + '/auth/v1/logout?scope=local', {
        method: 'POST', headers: jsonHeaders(current.access_token), cache: 'no-store',
      });
    } catch { /* A sess�o local � removida mesmo sem rede. */ }
  }
  clear();
}
async function rest(path, method = 'GET', body, prefer = '') {
  if (!isConfigured()) throw new Error('A conex�o com o Supabase n�o est� configurada.');
  const token = await accessToken();
  let response;
  try {
    response = await fetch(baseUrl + '/rest/v1/' + path, {
      method, cache: 'no-store',
      headers: {
        ...jsonHeaders(token),
        ...(prefer && { Prefer: prefer }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  } catch { throw new Error('Sem conex�o com o banco da agenda. Verifique a internet e tente novamente.'); }
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

