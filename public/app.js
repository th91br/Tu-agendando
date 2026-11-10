import {
  accessToken, callRpc, deleteRows, getUser, importRows, insertRows, isConfigured,
  selectRows, signIn, signOut, signUp, updateRows, consumeRecoveryLink,
  requestPasswordReset, updateRecoveryPassword,
} from './supabase.js';

const $ = id => document.getElementById(id);
const icons = {
  search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
  cloud: '<rect x="4" y="6" width="16" height="15" rx="3"/><path d="M4 11h16M8 3v5m8-5v5m-6 8 1.5 1.5L15 14"/>',
  left: '<path d="m14 6-6 6 6 6"/>', right: '<path d="m10 6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', close: '<path d="m6 6 12 12m0-12L6 18"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M5 9a8 8 0 0 1 13-4l2 6M4 13l2 6a8 8 0 0 0 13-4"/>',
  eye: '<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  eyeOff: '<path d="M3 3l18 18M9.8 5.8A11 11 0 0 1 12 6c6.4 0 10 6 10 6a16 16 0 0 1-3.2 3.7M6 6.7C3.4 8.2 2 12 2 12s3.6 6 10 6c1.2 0 2.3-.2 3.3-.5"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
};
for (const el of document.querySelectorAll('[data-icon]')) {
  el.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + icons[el.dataset.icon] + '</svg>';
}

const zone = 'America/Sao_Paulo';
const localClock = new Intl.DateTimeFormat('sv-SE', { timeZone: zone, year: 'numeric',
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clock = value => localClock.format(new Date(value)).replace(' ', 'T');
const date = value => new Date(value + 'T12:00:00Z');
const dateId = value => value.toISOString().slice(0, 10);
const today = () => clock(Date.now()).slice(0, 10);
function shift(value, days) {
  const d = date(value);
  d.setUTCDate(d.getUTCDate() + days);
  return dateId(d);
}
function monthStep(value, count) {
  const d = date(value);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + count);
  return dateId(d);
}
const monday = value => shift(value, -((date(value).getUTCDay() + 6) % 7));
const format = (value, options) => date(value).toLocaleDateString('pt-BR', { ...options, timeZone: 'UTC' });
const monthLabel = value => format(value, { month: 'long', year: 'numeric' });
const cap = text => text[0].toUpperCase() + text.slice(1);

function iso(value) {
  const wall = Date.parse(value + 'Z');
  if (!Number.isFinite(wall)) return '';
  const read = Date.parse(clock(wall) + 'Z');
  const corrected = new Date(wall + wall - read).toISOString();
  return clock(corrected) === value ? corrected : '';
}
const wallTime = (day, hour = '00:00') => day + 'T' + hour;
const slotMinutes = 30;
const timeLabel = minute => String(Math.floor(minute / 60)).padStart(2, '0') +
  ':' + String(minute % 60).padStart(2, '0');
const slotTime = (day, minute) => wallTime(shift(day, Math.floor(minute / 1440)), timeLabel(minute % 1440));
const seven = start => Array.from({ length: 7 }, (_, i) => shift(start, i));
const fortyTwo = start => Array.from({ length: 42 }, (_, i) => shift(start, i));

let selected = today(), miniMonth = monthStep(selected, 0);
let view = 'week', screen = 'dashboard', events = [], active = null, draftId = null, status = { ready: false, connected: false };
let user = null, calendars = {}, googleLinkId = null, legacyCount = 0, authMode = 'signin';
let request = 0, noticeTimer, installPrompt, loaded = false, currentWindow = '';
let deleteArmed = false, pendingStatus = 'scheduled', attendanceEvent = null;
const attendanceNames = {
  scheduled: 'Planejado', completed: 'Concluído', missed: 'Faltei',
  no_show: 'Não compareceu', rescheduled: 'Remarcado',
};
const categoryNames = { pf: 'PF', pj: 'PJ', '': 'Sem categoria' };
const daysOfWeek = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const editor = $('editor'), form = $('event-form'), field = name => form.elements.namedItem(name);
const calendar = $('calendar');
const compact = window.matchMedia('(max-width: 820px)');

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function button(text, callback, className) {
  const el = make('button', className, text);
  el.type = 'button';
  el.addEventListener('click', callback);
  return el;
}
function message(id, text) {
  $(id).textContent = text;
  $(id).hidden = !text;
}
function notify(text) {
  clearTimeout(noticeTimer);
  message('notice', text);
  noticeTimer = setTimeout(() => message('notice', ''), 4800);
}
async function api(path, method = 'GET', body) {
  const token = await accessToken();
  const result = await fetch('/api/' + path, {
    method, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + token, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const data = await result.json().catch(() => ({}));
  if (!result.ok) {
    const error = new Error(data.error || 'Não foi possível concluir a operação.');
    error.status = result.status;
    throw error;
  }
  return data;
}
function dbEvent(event, id, extra = {}) {
  const calendar = calendars[event.category];
  if (!calendar) throw new Error('A agenda PF ou PJ não está inicializada. Saia e entre novamente.');
  return {
    id, user_id: user.id, calendar_id: calendar.id, category: event.category,
    title: event.title.trim(), start_at: event.allDay ? iso(wallTime(event.start)) : event.start,
    end_at: event.allDay ? iso(wallTime(event.end)) : event.end, all_day: event.allDay,
    time_zone: zone, location: event.location || null, notes: event.notes || null,
    source: extra.source || 'local', sync_status: extra.syncStatus || 'local_only',
    google_link_id: extra.googleLinkId || null, google_event_id: extra.googleEventId || null,
    google_etag: extra.googleEtag || null, last_sync_error: extra.lastSyncError || null,
    attendance_status: event.attendanceStatus || 'scheduled',
  };
}
function fromDb(row) {
  const allDay = Boolean(row.all_day);
  return {
    id: row.google_event_id && status.connected ? row.google_event_id : row.id,
    dbId: row.id, dbEtag: row.etag, calendarId: row.calendar_id,
    googleEventId: row.google_event_id, googleEtag: row.google_etag, googleLinkId: row.google_link_id,
    syncStatus: row.sync_status, source: row.google_event_id && status.connected ? 'google' : 'local',
    title: row.title, category: row.category, start: allDay ? clock(row.start_at).slice(0, 10) : row.start_at,
    end: allDay ? clock(row.end_at).slice(0, 10) : row.end_at, allDay,
    notes: row.notes || '', location: row.location || '', etag: row.google_etag || row.etag,
    recurring: false, locked: false, attendanceStatus: row.attendance_status || 'scheduled',
  };
}
function fromGoogle(remote, row = null) {
  return {
    id: remote.id, dbId: row?.id || null, dbEtag: row?.etag || null,
    calendarId: row?.calendar_id || calendars[remote.category]?.id || null,
    googleEventId: remote.id, googleEtag: remote.etag, googleLinkId: row?.google_link_id || googleLinkId,
    syncStatus: row?.sync_status || 'synced', source: 'google',
    title: remote.title, category: remote.category || row?.category || '',
    start: remote.start, end: remote.end, allDay: remote.allDay,
    notes: remote.notes || '', location: remote.location || '', etag: remote.etag,
    recurring: remote.recurring, locked: remote.locked,
    attendanceStatus: row?.attendance_status || 'scheduled',
  };
}
async function ensureGoogleLink() {
  if (googleLinkId) return googleLinkId;
  if (!user || !status.connected) return null;
  const connectionRows = await selectRows('google_connections', {
    select: 'id', user_id: 'eq.' + user.id, limit: '1',
  });
  let connection = connectionRows[0];
  const connectionValues = {
    user_id: user.id, account_email: status.email || null,
    scopes: ['https://www.googleapis.com/auth/calendar.events.owned'], is_connected: true,
  };
  if (connection) {
    const updated = await updateRows('google_connections', {
      id: 'eq.' + connection.id, user_id: 'eq.' + user.id,
    }, connectionValues);
    connection = updated[0] || connection;
  } else {
    connection = (await insertRows('google_connections', [connectionValues]))[0];
  }
  if (!connection?.id) throw new Error('Não foi possível registrar a conexão do Google.');
  const links = await selectRows('google_calendar_links', {
    select: 'id', user_id: 'eq.' + user.id, connection_id: 'eq.' + connection.id,
    external_calendar_id: 'eq.primary', limit: '1',
  });
  if (links[0]) {
    const updated = await updateRows('google_calendar_links', {
      id: 'eq.' + links[0].id, user_id: 'eq.' + user.id,
    }, { sync_enabled: true, sync_direction: 'bidirectional', external_calendar_name: 'Google Agenda principal' });
    googleLinkId = updated[0]?.id || links[0].id;
  } else {
    const inserted = await insertRows('google_calendar_links', [{
      user_id: user.id, calendar_id: null, connection_id: connection.id,
      external_calendar_id: 'primary', external_calendar_name: 'Google Agenda principal',
      sync_direction: 'bidirectional', sync_enabled: true,
    }]);
    googleLinkId = inserted[0]?.id || null;
  }
  if (!googleLinkId) throw new Error('Não foi possível registrar o calendário do Google.');
  return googleLinkId;
}
function googleBodyFromRow(row) {
  const allDay = Boolean(row.all_day);
  return {
    title: row.title, category: row.category, allDay,
    start: allDay ? clock(row.start_at).slice(0, 10) : row.start_at,
    end: allDay ? clock(row.end_at).slice(0, 10) : row.end_at,
    notes: row.notes || '', location: row.location || '',
  };
}
async function syncPendingEvents() {
  if (!status.connected || !user) return;
  const pending = await selectRows('events', {
    select: '*', user_id: 'eq.' + user.id, sync_status: 'eq.pending',
    google_event_id: 'not.is.null', limit: '100',
  });
  for (const row of pending) {
    try {
      const remote = await api('google/events/' + encodeURIComponent(row.google_event_id), 'PATCH', {
        ...googleBodyFromRow(row), etag: row.google_etag,
      });
      await updateRows('events', { id: 'eq.' + row.id, user_id: 'eq.' + user.id, etag: 'eq.' + row.etag },
        { source: 'google', sync_status: 'synced', google_etag: remote.etag, last_sync_error: null });
    } catch (error) {
      await updateRows('events', { id: 'eq.' + row.id, user_id: 'eq.' + user.id },
        { sync_status: 'error', last_sync_error: error.message.slice(0, 1000) });
    }
  }
}
function range() {
  if (screen === 'dashboard') return [today(), shift(today(), 8)];
  if (view === 'day') return [selected, shift(selected, 1)];
  if (view === 'week') return [monday(selected), shift(monday(selected), 7)];
  const start = monday(monthStep(selected, 0));
  return [start, shift(start, 42)];
}
async function load() {
  if (!user) return;
  const key = ++request;
  const [start, end] = range();
  const windowId = start + end;
  if (windowId !== currentWindow) {
    currentWindow = windowId;
    events = [];
    loaded = false;
    message('warning', '');
  }
  render();
  try {
    const from = iso(wallTime(start)), to = iso(wallTime(end));
    const rows = await selectRows('events', {
      select: '*', user_id: 'eq.' + user.id, start_at: 'lt.' + to, end_at: 'gt.' + from,
      order: 'start_at.asc', limit: '1000',
    });
    if (key !== request) return;
    events = rows.map(fromDb);
    message('warning', '');
    if (status.connected) {
      try {
        const result = await api('google/events?' + new URLSearchParams({ from, to }));
        if (key !== request) return;
        const byGoogleId = new Map(rows.filter(row => row.google_event_id).map(row => [row.google_event_id, row]));
        const remote = (result.events || []).map(item => fromGoogle(item, byGoogleId.get(item.id) || null));
        const remoteIds = new Set((result.events || []).map(item => item.id));
        events = [...remote, ...rows.filter(row => !row.google_event_id || !remoteIds.has(row.google_event_id)).map(fromDb)];
      } catch (error) {
        if (key !== request) return;
        message('warning', 'Agenda salva; não foi possível atualizar o Google agora. ' + error.message);
      }
    }
  } catch (error) {
    if (key !== request) return;
    message('warning', error instanceof TypeError ? 'Sem conexão com a agenda. Verifique se o Tu Agendando está em execução.' : error.message);
  }
  loaded = true;
  render();
}
function choose(day, nextView = view) {
  selected = day;
  miniMonth = monthStep(day, 0);
  view = nextView;
  load();
}
function showCalendar(day = selected, nextView = 'day') {
  selected = day;
  miniMonth = monthStep(day, 0);
  view = nextView;
  screen = 'calendar';
  $('shell').dataset.screen = screen;
  $('dashboard-screen').hidden = true;
  $('calendar-screen').hidden = false;
  $('dashboard-tab').removeAttribute('aria-current');
  $('calendar-tab').setAttribute('aria-current', 'page');
  $('search').placeholder = 'Buscar neste período';
  $('search').setAttribute('aria-label', 'Buscar neste período');
  load();
}
function showDashboard() {
  screen = 'dashboard';
  selected = today();
  $('shell').dataset.screen = screen;
  $('calendar-screen').hidden = true;
  $('dashboard-screen').hidden = false;
  $('calendar-tab').removeAttribute('aria-current');
  $('dashboard-tab').setAttribute('aria-current', 'page');
  $('search').placeholder = 'Buscar nos próximos 7 dias';
  $('search').setAttribute('aria-label', 'Buscar nos próximos 7 dias');
  load();
}
function updateSidebarToggle() {
  const collapsed = $('shell').dataset.sidebarCollapsed === 'true';
  const label = collapsed ? 'Mostrar coluna lateral' : 'Recolher coluna lateral';
  $('sidebar-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('sidebar-toggle').setAttribute('aria-label', label);
  $('sidebar-toggle').title = label;
}
$('sidebar-toggle').onclick = () => {
  $('shell').dataset.sidebarCollapsed = String($('shell').dataset.sidebarCollapsed !== 'true');
  updateSidebarToggle();
};
updateSidebarToggle();
function visible() {
  const query = $('search').value.trim().toLocaleLowerCase('pt-BR');
  const enabled = [...document.querySelectorAll('#filters input:checked')].map(el => el.value);
  return events.filter(e => enabled.includes(e.category) &&
    (e.title + ' ' + e.location + ' ' + e.notes).toLocaleLowerCase('pt-BR').includes(query))
    .sort((a, b) => a.start.localeCompare(b.start));
}
function eventOn(e, day) {
  return e.allDay ? e.start <= day && day < e.end
    : Date.parse(e.start) < Date.parse(iso(wallTime(shift(day, 1)))) && Date.parse(e.end) > Date.parse(iso(wallTime(day)));
}
function labelTime(e) {
  return e.allDay ? 'Dia inteiro' : clock(e.start).slice(11) + ' – ' + clock(e.end).slice(11);
}
function eventButton(e) {
  const duration = e.allDay ? 1440 : Math.max(0, (Date.parse(e.end) - Date.parse(e.start)) / 60000);
  const density = duration < 60 ? ' short-event' : duration < 90 ? ' medium-event' : '';
  const el = button('', () => openEditor(e), 'event ' + e.category + density);
  el.append(make('strong', '', e.title), make('small', '', labelTime(e) + ' · ' + categoryNames[e.category]));
  el.dataset.attendance = e.attendanceStatus || 'scheduled';
  if (e.attendanceStatus && e.attendanceStatus !== 'scheduled') {
    el.append(make('span', 'event-status', attendanceNames[e.attendanceStatus]));
  }
  el.setAttribute('aria-label', e.title + ', ' + labelTime(e) + ', ' + categoryNames[e.category]);
  el.title = e.title + ' · ' + categoryNames[e.category];
  return el;
}
function mini() {
  $('mini-title').textContent = monthLabel(miniMonth);
  const el = $('mini');
  el.replaceChildren(...daysOfWeek.map(d => make('span', '', d.slice(0, 2))));
  for (const day of fortyTwo(monday(miniMonth))) {
    const item = button(String(Number(day.slice(-2))), () => openEditor(null, day), day.slice(0, 7) === miniMonth.slice(0, 7) ? '' : 'outside');
    item.setAttribute('aria-label', 'Novo compromisso em ' + format(day, { dateStyle: 'full' }));
    item.classList.toggle('selected', day === selected);
    if (day === today()) item.setAttribute('aria-current', 'date');
    el.append(item);
  }
}
function dayHeader(days, dayPicker) {
  const header = make('div', 'week-head' + (dayPicker ? ' day-picker' : ''));
  if (!dayPicker) header.append(make('span', '', 'GMT−3'));
  for (const day of days) {
    const el = button('', () => {
      if (!dayPicker) return openEditor(null, day);
      selected = day;
      render();
      calendar.querySelector('.day-picker [aria-pressed=true]')?.focus();
    }, day === today() ? 'current' : '');
    el.setAttribute('aria-label', (dayPicker ? 'Ver horários de ' : 'Novo compromisso em ') + format(day, { dateStyle: 'full' }));
    if (dayPicker) el.setAttribute('aria-pressed', day === selected);
    el.append(make('small', '', format(day, { weekday: 'short' }).replace('.', '')), make('b', '', day.slice(-2)));
    header.append(el);
  }
  return header;
}
function minutes(value) {
  const [h, m] = clock(value).slice(11).split(':').map(Number);
  return 60 * h + m;
}
function timeSlots(day) {
  const slots = make('div', 'slots');
  const dateLabel = format(day, { dateStyle: 'full' });
  for (let minute = 0; minute < 1440; minute += slotMinutes) {
    const time = timeLabel(minute);
    const item = button('', () => openEditor(null, day, minute), 'time-slot');
    item.append(make('span', '', time));
    item.setAttribute('aria-label', 'Novo compromisso em ' + dateLabel + ' às ' + time);
    item.tabIndex = minute === 8 * 60 ? 0 : -1;
    slots.append(item);
  }
  slots.addEventListener('keydown', event => {
    const current = event.target;
    const next = {
      ArrowUp: current.previousElementSibling,
      ArrowDown: current.nextElementSibling,
      Home: slots.firstElementChild,
      End: slots.lastElementChild,
    }[event.key];
    if (!next) return;
    event.preventDefault();
    slots.querySelector('[tabindex="0"]').tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  });
  return slots;
}
function timedColumn(items, day) {
  const col = make('div', 'column' + (day === today() ? ' current' : ''));
  col.append(timeSlots(day));
  const entries = items.map(e => ({
    e, start: clock(e.start).slice(0, 10) < day ? 0 : minutes(e.start),
    end: clock(e.end).slice(0, 10) > day ? 1440 : minutes(e.end),
  })).sort((a, b) => a.start - b.start);
  let group = [], lanes = [], groupEnd = 0;
  function flush() {
    for (const row of group) {
      const el = eventButton(row.e);
      el.style.setProperty('--start', String(row.start / slotMinutes));
      el.style.setProperty('--height', String(Math.max(28, row.end - row.start) / slotMinutes));
      el.style.setProperty('--offset', 'calc(' + (100 * row.lane / lanes.length) + '% + 2px)');
      el.style.setProperty('--width', 'calc(' + (100 / lanes.length) + '% - 4px)');
      col.append(el);
    }
    group = []; lanes = []; groupEnd = 0;
  }
  for (const row of entries) {
    if (row.start >= groupEnd) flush();
    row.end = Math.max(row.end, row.start + 28);
    const free = lanes.findIndex(end => end <= row.start);
    row.lane = free < 0 ? lanes.length : free;
    lanes[row.lane] = row.end;
    group.push(row);
    groupEnd = Math.max(groupEnd, row.end);
  }
  flush();
  return col;
}
function timeline(items) {
  const weekDays = seven(monday(selected));
  const singleDay = view === 'day' || compact.matches;
  const days = singleDay ? [selected] : weekDays;
  const gridClass = singleDay ? 'time-grid single-day' : 'time-grid';
  const allDay = make('div', gridClass + ' all-day');
  allDay.append(make('span', '', 'Dia inteiro'));
  const hours = make('div', 'hours');
  for (let h = 0; h < 24; h++) hours.append(make('span', 'hour', timeLabel(h * 60)));
  const grid = make('div', gridClass);
  grid.append(hours);
  let all = false;
  for (const day of days) {
    const matches = items.filter(e => eventOn(e, day));
    const box = make('div');
    box.append(...matches.filter(e => e.allDay).map(eventButton));
    allDay.append(box);
    all ||= Boolean(box.childElementCount);
    grid.append(timedColumn(matches.filter(e => !e.allDay), day));
  }
  const scroll = make('div', 'week-scroll');
  scroll.setAttribute('tabindex', '0');
  scroll.setAttribute('aria-label', 'Grade de horários');
  scroll.append(grid);
  const old = calendar.querySelector('.week-scroll')?.scrollTop;
  const header = view === 'day' ? [] : [dayHeader(weekDays, singleDay)];
  calendar.replaceChildren(...header, ...(all ? [allDay] : []), scroll);
  const slotHeight = scroll.querySelector('.time-slot').offsetHeight;
  scroll.scrollTop = old ?? (8 * 60 / slotMinutes) * slotHeight;
}
function month(items) {
  const grid = make('div', 'month');
  grid.append(...daysOfWeek.map(day => make('span', 'day-name', day)));
  for (const day of fortyTwo(range()[0])) {
    const cell = make('div', 'month-cell' + (day.slice(0, 7) !== selected.slice(0, 7) ? ' outside' : ''));
    const dateButton = button(day.slice(-2), () => openEditor(null, day), 'date-btn' + (day === today() ? ' current' : ''));
    dateButton.setAttribute('aria-label', 'Novo compromisso em ' + format(day, { dateStyle: 'full' }));
    cell.append(dateButton);
    const matches = items.filter(e => eventOn(e, day));
    cell.append(...matches.slice(0, 2).map(eventButton));
    if (matches.length > 2) cell.append(button('+' + (matches.length - 2), () => choose(day, 'day'), 'more'));
    grid.append(cell);
  }
  calendar.replaceChildren(grid);
}
function dashboardEvent(e, dateLabel = '') {
  const item = button('', () => openEditor(e), 'dashboard-event');
  const heading = make('strong', '', e.title);
  const detail = make('span', 'dashboard-event-detail',
    [dateLabel, labelTime(e), e.location].filter(Boolean).join(' · '));
  const category = make('span', 'category-label ' + (e.category || 'unassigned'),
    e.category ? categoryNames[e.category] : 'Sem categoria');
  item.append(heading, detail, category);
  const row = make('div', 'dashboard-event-row');
  row.dataset.attendance = e.attendanceStatus || 'scheduled';
  const action = button(attendanceNames[e.attendanceStatus || 'scheduled'], () => showAttendance(e), 'status-trigger');
  action.setAttribute('aria-label', 'Situação de ' + e.title + ': ' + attendanceNames[e.attendanceStatus || 'scheduled']);
  row.append(item, action);
  return row;
}
function renderDashboard() {
  const day = today();
  const items = visible();
  const upcomingItems = items.filter(e => !['completed', 'missed', 'no_show'].includes(e.attendanceStatus));
  const days = seven(day);
  const todayItems = items.filter(e => eventOn(e, day));
  const running = upcomingItems.find(e => !e.allDay &&
    Date.parse(e.start) <= Date.now() && Date.parse(e.end) > Date.now());
  const allDayRunning = upcomingItems.find(e => e.allDay && e.start <= day && day < e.end);
  const next = running || allDayRunning || upcomingItems.find(e => e.allDay
    ? e.start >= day && e.start < shift(day, 8)
    : Date.parse(e.end) > Date.now() && clock(e.start).slice(0, 10) < shift(day, 8));

  $('dashboard-date').textContent = cap(format(day, { dateStyle: 'full' }));
  $('today-date').textContent = cap(format(day, { dateStyle: 'full' }));
  $('dashboard-warning').textContent = loaded ? $('warning').textContent : '';
  $('dashboard-warning').hidden = !loaded || !$('warning').textContent;

  const nextPanel = $('next-appointment');
  nextPanel.classList.toggle('in-progress', Boolean(running || allDayRunning));
  nextPanel.replaceChildren();
  const nextLabel = make('span', 'next-label',
    running || allDayRunning ? 'Em andamento' : 'Próximo compromisso');
  nextPanel.append(nextLabel);
  if (next) {
    const nextButton = button('', () => openEditor(next), 'next-event');
    nextButton.append(
      make('strong', '', next.title),
      make('span', '', [
        next.allDay ? cap(format(next.start, { weekday: 'long', day: 'numeric', month: 'long' })) :
          clock(next.start).slice(0, 10) === day ? 'Hoje' :
            cap(format(clock(next.start).slice(0, 10), { weekday: 'long', day: 'numeric', month: 'long' })),
        labelTime(next), categoryNames[next.category],
      ].join(' · ')),
      ...(next.location ? [make('span', '', next.location)] : []),
    );
    nextPanel.append(nextButton);
    nextPanel.append(button('Situação: ' + attendanceNames[next.attendanceStatus || 'scheduled'],
      () => showAttendance(next), 'next-status'));
  } else {
    nextPanel.append(make('p', 'next-empty',
      loaded ? 'Nenhum compromisso nos próximos 7 dias.' : 'Carregando sua agenda…'));
  }

  $('today-events').replaceChildren();
  $('today-events').classList.toggle('event-list', todayItems.length > 0);
  if (todayItems.length) {
    for (const event of todayItems) $('today-events').append(dashboardEvent(event));
  } else {
    const empty = make('div', 'dashboard-empty',
      loaded ? 'Hoje está livre. Seus compromissos novos aparecem aqui.' : 'Carregando os compromissos de hoje…');
    $('today-events').append(empty);
  }

  const strip = $('week-strip');
  strip.replaceChildren();
  for (const dateIdValue of days) {
    const dayItems = items.filter(e => eventOn(e, dateIdValue));
    const buttonDay = button('', () => showCalendar(dateIdValue, 'day'),
      'week-day' + (dateIdValue === day ? ' is-today' : ''));
    buttonDay.setAttribute('aria-label',
      cap(format(dateIdValue, { dateStyle: 'full' })) + ', ' +
      (dayItems.length === 1 ? '1 compromisso' : dayItems.length + ' compromissos'));
    buttonDay.append(
      make('span', 'week-day-name', dateIdValue === day ? 'Hoje' :
        format(dateIdValue, { weekday: 'short' }).replace('.', '')),
      make('strong', '', dateIdValue.slice(-2)),
      make('span', 'week-day-count', dayItems.length ?
        (dayItems.length === 1 ? '1 compromisso' : dayItems.length + ' compromissos') : 'Livre'),
    );
    strip.append(buttonDay);
  }
}
function render() {
  if (screen === 'dashboard') {
    renderDashboard();
    return;
  }
  mini();
  const [start, end] = range();
  const final = shift(end, -1);
  $('range').textContent = view === 'day' ? cap(format(selected, { dateStyle: 'long' })) :
    view === 'month' ? cap(monthLabel(selected)) :
      format(start, { day: 'numeric', month: 'short' }).replace('.', '') + ' – ' + format(final, { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '');
  for (const el of document.querySelectorAll('[data-view]')) el.setAttribute('aria-pressed', el.dataset.view === view);
  const items = visible();
  $('subtitle').textContent = !loaded ? 'Carregando agenda…' : items.length === 1 ? '1 compromisso no período' : items.length + ' compromissos no período';
  const next = items.find(e => !['completed', 'missed', 'no_show'].includes(e.attendanceStatus) &&
    (e.allDay ? e.start >= today() : Date.parse(e.start) >= Date.now()));
  $('upcoming').replaceChildren(next ? button(next.title + ' · ' + labelTime(next), () => openEditor(next)) :
    make('p', '', 'Nenhum compromisso à frente neste período.'));
  $('calendar-hint').textContent = view === 'month' ? 'Selecione um dia para marcar.' : 'Selecione um horário na grade para marcar.';
  if (view === 'month') month(items);
  else timeline(items);
}
function setDateFields(allDay, start, end) {
  field('start').type = field('end').type = allDay ? 'date' : 'datetime-local';
  field('start').value = start;
  field('end').value = end;
  $('end-label').querySelector('span').textContent = allDay ? 'Último dia' : 'Fim';
}
function openEditor(event = null, day = selected, startMinute = 9 * 60) {
  active = event;
  pendingStatus = event?.attendanceStatus || 'scheduled';
  draftId = crypto.randomUUID();
  deleteArmed = false;
  form.reset();
  const locked = Boolean(event?.locked);
  for (const el of form.querySelectorAll('input,textarea')) el.disabled = locked;
  $('editor-title').textContent = event ? 'Editar compromisso' : 'Novo compromisso';
  $('source').textContent = event?.recurring ? 'Alteração desta ocorrência · Google Agenda' :
    locked ? 'Este compromisso é gerenciado pelo Google Agenda' :
      event?.syncStatus === 'error' ? 'Salvo na sua conta; sincronização pendente com o Google' :
        (event ? event.source === 'google' : status.connected) ? 'Google Agenda · calendário principal' : 'Salvo na sua conta';
  field('title').value = event?.title || '';
  field('category').value = event?.category || (event ? 'pf' : '');
  if (!event) {
    const filters = [...document.querySelectorAll('#filters input:checked')].map(el => el.value);
    if (filters.length === 1 && filters[0]) field('category').value = filters[0];
  }
  field('notes').value = event?.notes || '';
  field('location').value = event?.location || '';
  field('allDay').checked = event?.allDay || false;
  setDateFields(field('allDay').checked, event ? event.allDay ? event.start : clock(event.start) : slotTime(day, startMinute),
    event ? event.allDay ? shift(event.end, -1) : clock(event.end) : slotTime(day, startMinute + slotMinutes));
  $('delete').hidden = !event || locked;
  $('editor-attendance-row').hidden = !event;
  $('editor-attendance').textContent = attendanceNames[pendingStatus];
  $('delete').textContent = 'Excluir';
  $('save').hidden = locked;
  message('form-message', '');
  editor.showModal();
}
$('editor-attendance').onclick = () => showAttendance(active);
function showAttendance(event) {
  if (!event) return;
  attendanceEvent = event;
  $('attendance-event-title').textContent = event.title;
  message('attendance-error', '');
  for (const item of document.querySelectorAll('.attendance-options button[data-attendance]')) {
    item.setAttribute('aria-pressed',
      item.dataset.attendance === (event === active && editor.open ? pendingStatus : event.attendanceStatus || 'scheduled'));
  }
  $('attendance-dialog').showModal();
}
async function saveAttendance(event, value) {
  if (event.dbId) {
    const saved = await updateRows('events', {
      id: 'eq.' + event.dbId, user_id: 'eq.' + user.id, etag: 'eq.' + event.dbEtag,
    }, { attendance_status: value });
    if (!saved.length) throw new Error('Este compromisso mudou. Atualize a agenda e tente novamente.');
  } else if (event.googleEventId) {
    const category = calendars[event.category] ? event.category : 'pf';
    const link = await ensureGoogleLink();
    const body = {
      title: event.title, category, start: event.start, end: event.end,
      allDay: event.allDay, location: event.location, notes: event.notes, attendanceStatus: value,
    };
    await insertRows('events', [dbEvent(body, crypto.randomUUID(), {
      source: 'google', syncStatus: 'synced', googleLinkId: link,
      googleEventId: event.googleEventId, googleEtag: event.googleEtag,
    })]);
  } else throw new Error('Não foi possível identificar o compromisso.');
}
for (const choice of document.querySelectorAll('button[data-attendance]')) choice.onclick = async () => {
  const event = attendanceEvent;
  const value = choice.dataset.attendance;
  if (value === 'rescheduled') {
    if (event.locked) { message('attendance-error', 'Este compromisso não pode ser remarcado aqui.'); return; }
    $('attendance-dialog').close();
    if (!editor.open || active !== event) openEditor(event);
    pendingStatus = 'rescheduled';
    $('editor-attendance').textContent = attendanceNames.rescheduled;
    message('form-message', 'Altere a data ou o horário e salve para remarcar.');
    field('start').focus();
    return;
  }
  choice.disabled = true;
  message('attendance-error', '');
  try {
    await saveAttendance(event, value);
    $('attendance-dialog').close();
    if (editor.open) editor.close();
    notify('Situação atualizada: ' + attendanceNames[value] + '.');
    await load();
  } catch (error) { message('attendance-error', error.message); }
  finally { choice.disabled = false; }
};
function busy(value) {
  $('save').disabled = $('delete').disabled = value;
  for (const el of editor.querySelectorAll('[data-close]')) el.disabled = value;
}
field('allDay').addEventListener('change', () => {
  const start = field('start').value.slice(0, 10) || selected;
  const end = field('end').value.slice(0, 10) || start;
  setDateFields(field('allDay').checked, field('allDay').checked ? start : wallTime(start, '09:00'),
    field('allDay').checked ? end : wallTime(end, '09:30'));
});
editor.addEventListener('cancel', e => { if ($('save').disabled) e.preventDefault(); });
async function persistEvent(body) {
  if (!calendars[body.category]) throw new Error('Selecione uma agenda pessoal ou profissional.');
  if (active?.dbId) {
    const extra = {
      source: active.googleEventId ? 'google' : 'local',
      syncStatus: active.googleEventId ? 'pending' : 'local_only',
      googleLinkId: active.googleLinkId, googleEventId: active.googleEventId,
      googleEtag: active.googleEtag, lastSyncError: null,
    };
    const saved = await updateRows('events', {
      id: 'eq.' + active.dbId, user_id: 'eq.' + user.id, etag: 'eq.' + active.dbEtag,
    }, dbEvent(body, active.dbId, extra));
    if (!saved.length) throw new Error('Este compromisso mudou em outra sessão. Atualize a agenda e tente novamente.');
    let row = saved[0];
    if (active.googleEventId && status.connected) {
      try {
        const remote = await api('google/events/' + encodeURIComponent(active.googleEventId), 'PATCH', {
          ...body, etag: active.googleEtag,
        });
        const synced = await updateRows('events', {
          id: 'eq.' + row.id, user_id: 'eq.' + user.id, etag: 'eq.' + row.etag,
        }, { source: 'google', sync_status: 'synced', google_etag: remote.etag, last_sync_error: null });
        row = synced[0] || row;
      } catch (error) {
        await updateRows('events', { id: 'eq.' + row.id, user_id: 'eq.' + user.id },
          { sync_status: 'error', last_sync_error: error.message.slice(0, 1000) });
        return { warning: 'Compromisso salvo na sua conta, mas o Google não sincronizou: ' + error.message };
      }
    }
    return { row };
  }
  if (active?.source === 'google' && active.googleEventId) {
    const remote = await api('google/events/' + encodeURIComponent(active.googleEventId), 'PATCH', {
      ...body, etag: active.googleEtag,
    });
    const linkId = await ensureGoogleLink();
    const row = (await insertRows('events', [dbEvent(body, draftId, {
      source: 'google', syncStatus: 'synced', googleLinkId: linkId,
      googleEventId: remote.id, googleEtag: remote.etag,
    })]))[0];
    if (!row) throw new Error('O compromisso foi atualizado no Google, mas não pôde ser registrado na sua conta.');
    return { row };
  }
  const inserted = (await insertRows('events', [dbEvent(body, draftId)]))[0];
  if (!inserted) throw new Error('O compromisso não foi confirmado pelo banco de dados.');
  if (!status.connected) return { row: inserted };
  try {
    const linkId = await ensureGoogleLink();
    const remote = await api('google/events', 'POST', { ...body, id: draftId.replaceAll('-', '') });
    const synced = await updateRows('events', {
      id: 'eq.' + inserted.id, user_id: 'eq.' + user.id, etag: 'eq.' + inserted.etag,
    }, {
      source: 'google', sync_status: 'synced', google_link_id: linkId,
      google_event_id: remote.id, google_etag: remote.etag, last_sync_error: null,
    });
    if (!synced.length) throw new Error('O evento foi criado no Google, mas o vínculo não foi confirmado.');
    return { row: synced[0] };
  } catch (error) {
    await updateRows('events', { id: 'eq.' + inserted.id, user_id: 'eq.' + user.id },
      { sync_status: 'error', last_sync_error: error.message.slice(0, 1000) });
    return { row: inserted, warning: 'Compromisso salvo na sua conta, mas o Google não sincronizou: ' + error.message };
  }
}
form.addEventListener('submit', async e => {
  e.preventDefault();
  const allDay = field('allDay').checked;
  const body = {
    title: field('title').value, category: field('category').value, notes: field('notes').value,
    location: field('location').value, allDay, attendanceStatus: pendingStatus,
    start: allDay ? field('start').value : iso(field('start').value),
    end: allDay ? shift(field('end').value, 1) : iso(field('end').value) };
  if (!body.start || !body.end || body.start >= body.end) {
    message('form-message', 'Confira o intervalo. O fim precisa ser posterior ao início.');
    return;
  }
  if (active && active.attendanceStatus !== 'rescheduled' && pendingStatus === 'rescheduled' &&
      body.start === active.start && body.end === active.end) {
    message('form-message', 'Para remarcar, escolha uma nova data ou horário.');
    return;
  }
  busy(true);
  message('form-message', '');
  try {
    const result = await persistEvent(body);
    editor.close();
    notify(result.warning || 'Compromisso salvo.');
    const savedDay = field('start').value.slice(0, 10);
    if (screen === 'dashboard') {
      selected = savedDay;
      load();
    } else {
      choose(savedDay);
    }
  } catch (error) { message('form-message', error.message); }
  finally { busy(false); }
});
$('delete').onclick = async () => {
  if (!deleteArmed) {
    deleteArmed = true;
    $('delete').textContent = 'Confirmar exclusão';
    message('form-message', 'Excluir este compromisso' + (active.source === 'google' ? ' também do Google Agenda?' : '?'));
    return;
  }
  busy(true);
  try {
    if (active.googleEventId) {
      if (!status.connected) throw new Error('Reconecte o Google Agenda para excluir também o compromisso sincronizado.');
      await api('google/events/' + encodeURIComponent(active.googleEventId), 'DELETE', { etag: active.googleEtag });
    }
    if (active.dbId) {
      const deleted = await deleteRows('events', {
        id: 'eq.' + active.dbId, user_id: 'eq.' + user.id, etag: 'eq.' + active.dbEtag,
      });
      if (!deleted.length) throw new Error('Este compromisso mudou em outra sessão. Atualize a agenda e tente novamente.');
    }
    editor.close(); notify('Compromisso excluído.'); load();
  } catch (error) { message('form-message', error.message); }
  finally { busy(false); }
};

function settings() {
  $('google-label').textContent = status.connected ? 'Google conectado' : 'Google Agenda';
  $('connect').textContent = status.connected ? 'Desconectar' : 'Conectar ao Google';
  $('connect').disabled = !status.ready;
  $('google-info').textContent = status.connected
    ? 'Compromissos novos e vinculados são sincronizados com seu calendário principal. Os dados também ficam salvos na sua conta Tu Agendando.'
    : status.ready ? 'Conecte uma conta para sincronizar compromissos com o calendário principal. Seus dados ficam salvos na sua conta Tu Agendando.'
      : 'Configure as credenciais OAuth seguindo o README para ativar a sincronização. A agenda Tu Agendando já salva seus compromissos na nuvem.';
}
$('google').onclick = () => { settings(); $('settings').showModal(); };
$('connect').onclick = async () => {
  $('connect').disabled = true;
  message('google-error', '');
  try {
    if (status.connected) {
      await api('google/disconnect', 'POST');
      status.connected = false;
      const connections = await selectRows('google_connections', {
        select: 'id', user_id: 'eq.' + user.id, limit: '1',
      });
      if (connections[0]) {
        await updateRows('google_connections', { id: 'eq.' + connections[0].id, user_id: 'eq.' + user.id },
          { is_connected: false });
        const links = await selectRows('google_calendar_links', {
          select: 'id', user_id: 'eq.' + user.id, connection_id: 'eq.' + connections[0].id,
        });
        for (const link of links) {
          await updateRows('google_calendar_links', { id: 'eq.' + link.id, user_id: 'eq.' + user.id },
            { sync_enabled: false });
        }
      }
      googleLinkId = null;
      settings(); load();
    } else {
      const result = await api('google/connect', 'POST');
      location.assign(result.url);
    }
  } catch (error) { message('google-error', error.message); }
  finally { $('connect').disabled = !status.ready; }
};
for (const el of document.querySelectorAll('[data-close]')) el.onclick = () => $(el.dataset.close).close();
for (const el of document.querySelectorAll('[data-view]')) el.onclick = () => choose(selected, el.dataset.view);
$('today').onclick = () => choose(today());
$('new').onclick = () => openEditor();
$('dashboard-new').onclick = () => openEditor(null, today());
$('dashboard-tab').onclick = showDashboard;
$('calendar-tab').onclick = () => showCalendar(today(), 'week');
$('today-calendar').onclick = () => showCalendar(today(), 'day');
$('reload').onclick = load;
$('filters').onchange = render;
$('search').oninput = render;
compact.addEventListener('change', render);
$('mini-back').onclick = () => { miniMonth = monthStep(miniMonth, -1); mini(); };
$('mini-next').onclick = () => { miniMonth = monthStep(miniMonth, 1); mini(); };
function navigate(step) {
  choose(view === 'month' ? monthStep(selected, step) : shift(selected, view === 'week' ? 7 * step : step));
}
$('back').onclick = () => navigate(-1);
$('forward').onclick = () => navigate(1);
 document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
setInterval(() => { if (!document.hidden && status.connected) load(); }, 60000);
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; $('install').hidden = false; });
$('install').onclick = async () => { if (installPrompt) await installPrompt.prompt(); $('install').hidden = true; };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
const outcome = new URLSearchParams(location.search).get('google');
if (outcome) history.replaceState(null, '', '/');
function setAuthMode(mode) {
  authMode = mode;
  const recovering = mode === 'recover', resetting = mode === 'reset';
  $('auth-title').textContent = recovering ? 'Recuperar senha' : resetting ? 'Crie uma nova senha' :
    mode === 'signup' ? 'Crie sua conta' : 'Entre na sua agenda';
  $('auth-description').textContent = recovering
    ? 'Enviaremos um link de recuperação para o seu e-mail.'
    : resetting ? 'Escolha uma nova senha para sua conta.'
      : mode === 'signup' ? 'Seus compromissos pessoais e profissionais ficam privados na sua conta.'
        : 'Acesse sua agenda pessoal e profissional com segurança.';
  $('auth-submit').textContent = recovering ? 'Enviar link' : resetting ? 'Salvar nova senha' :
    mode === 'signup' ? 'Criar conta' : 'Entrar';
  $('auth-toggle').textContent = mode === 'signin' ? 'Criar uma conta' :
    mode === 'signup' ? 'Já tenho uma conta' : 'Voltar ao login';
  $('auth-email').closest('label').hidden = resetting;
  $('auth-email').required = !resetting;
  $('auth-password-label').hidden = recovering;
  $('auth-password').required = !recovering;
  $('auth-confirm-label').hidden = !resetting;
  $('auth-confirm').required = resetting;
  $('auth-recover').hidden = mode !== 'signin';
  $('auth-password').autocomplete = mode === 'signup' || resetting ? 'new-password' : 'current-password';
  $('auth-password').type = 'password';
  $('password-visibility').setAttribute('aria-pressed', 'false');
  $('password-visibility').setAttribute('aria-label', 'Mostrar senha');
  $('password-visibility').querySelector('svg').innerHTML = icons.eye;
}
$('password-visibility').onclick = () => {
  const visible = $('auth-password').type === 'password';
  $('auth-password').type = visible ? 'text' : 'password';
  $('password-visibility').setAttribute('aria-pressed', String(visible));
  $('password-visibility').setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
  $('password-visibility').querySelector('svg').innerHTML = icons[visible ? 'eyeOff' : 'eye'];
};
$('auth-recover').onclick = () => {
  setAuthMode('recover');
  message('auth-message', '');
};
async function startApp(account) {
  user = account;
  events = [];
  calendars = {};
  googleLinkId = null;
  status = { ready: false, connected: false };
  active = null;
  currentWindow = '';
  loaded = false;
  screen = 'dashboard';
  $('shell').dataset.screen = screen;
  $('auth-screen').hidden = true;
  $('shell').hidden = false;
  $('user-email').textContent = account.email || '';
  try {
    await callRpc('initialize_user');
    const rows = await selectRows('calendars', {
      select: 'id,kind,is_default', user_id: 'eq.' + user.id, is_default: 'eq.true',
    });
    calendars = Object.fromEntries(rows.map(row => [row.kind, row]));
    if (!calendars.pf || !calendars.pj) throw new Error('As agendas pessoal e profissional não foram inicializadas.');
    status = await api('google/status');
    if (status.connected) {
      try { await ensureGoogleLink(); } catch (error) {
        message('warning', 'O Google está conectado, mas o vínculo não pôde ser atualizado: ' + error.message);
      }
      try { await syncPendingEvents(); } catch { /* Compromissos locais continuam acessíveis. */ }
    }
    await refreshLegacy();
    await load();
    if (outcome) notify(outcome === 'connected' ? 'Google Agenda conectado.' : 'Conexão com o Google não concluída.');
  } catch (error) {
    loaded = true;
    message('warning', error.message);
    render();
  }
}
async function refreshLegacy() {
  try {
    const result = await api('legacy/meta');
    legacyCount = Number(result.count) || 0;
    const info = $('legacy-info');
    const button = $('legacy-import');
    info.hidden = legacyCount === 0;
    button.hidden = legacyCount === 0 || result.claimed || result.claimedByCurrentUser;
    if (result.claimedByCurrentUser) info.textContent = 'Os compromissos antigos deste computador já foram importados para esta conta.';
    else if (result.claimed) info.textContent = 'Os compromissos antigos deste computador já foram vinculados a outra conta.';
    else if (legacyCount) info.textContent = 'Foram encontrados ' + legacyCount + ' compromissos salvos anteriormente neste computador. Você pode importá-los para sua conta.';
  } catch {
    legacyCount = 0;
    $('legacy-info').hidden = true;
    $('legacy-import').hidden = true;
  }
}
async function legacyUuid(value) {
  const source = new TextEncoder().encode(user.id + ':legacy:' + String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', source));
  const hex = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = (parseInt(hex[16], 16) & 3 | 8).toString(16);
  const compactId = hex.join('');
  return compactId.slice(0, 8) + '-' + compactId.slice(8, 12) + '-' +
    compactId.slice(12, 16) + '-' + compactId.slice(16, 20) + '-' + compactId.slice(20);
}
function legacyInstant(value) {
  if (typeof value !== 'string') return '';
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/);
  return match ? iso(wallTime(match[1], match[2] || '00:00')) : '';
}
async function importLegacy() {
  const importButton = $('legacy-import');
  importButton.disabled = true;
  message('google-error', '');
  try {
    const result = await api('legacy/claim', 'POST');
    const oldEvents = Array.isArray(result.events) ? result.events : [];
    const rows = [];
    for (let index = 0; index < oldEvents.length; index++) {
      const old = oldEvents[index] || {};
      const allDay = old.allDay === true;
      const category = ['pf', 'pj'].includes(old.category) ? old.category : 'pf';
      const start = allDay ? String(old.start || '').slice(0, 10) : legacyInstant(old.start);
      const end = allDay ? String(old.end || '').slice(0, 10) : legacyInstant(old.end);
      if (!start || !end || start >= end) throw new Error('O compromisso antigo ' + (index + 1) + ' tem horário inválido.');
      const body = {
        title: String(old.title || 'Compromisso importado').trim().slice(0, 180) || 'Compromisso importado',
        category, start, end, allDay, location: String(old.location || '').slice(0, 300),
        notes: String(old.notes || '').slice(0, 4000),
      };
      rows.push(dbEvent(body, await legacyUuid(old.id || index)));
    }
    for (let index = 0; index < rows.length; index += 100) {
      await importRows('events', rows.slice(index, index + 100));
    }
    await api('legacy/complete', 'POST', { count: oldEvents.length });
    await refreshLegacy();
    $('settings').close();
    notify(oldEvents.length ? oldEvents.length + ' compromissos importados.' : 'Não havia compromissos antigos para importar.');
    await load();
  } catch (error) {
    message('google-error', error.message);
  } finally {
    importButton.disabled = false;
  }
}
$('auth-toggle').onclick = () => {
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
  message('auth-message', '');
};
$('auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!isConfigured()) {
    message('auth-message', 'Configure SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY no arquivo .env.');
    return;
  }
  const submit = $('auth-submit');
  submit.disabled = true;
  message('auth-message', '');
  try {
    const email = $('auth-email').value.trim().toLowerCase();
    const password = $('auth-password').value;
    if (authMode === 'recover') {
      await requestPasswordReset(email);
      message('auth-message', 'Se o e-mail estiver cadastrado, você receberá um link para redefinir a senha.');
      return;
    }
    if (authMode === 'reset') {
      if (password !== $('auth-confirm').value) {
        message('auth-message', 'As senhas não coincidem.');
        return;
      }
      await updateRecoveryPassword(password);
      $('auth-password').value = '';
      $('auth-confirm').value = '';
      setAuthMode('signin');
      message('auth-message', 'Senha atualizada. Entre com a nova senha.');
      return;
    }
    const result = authMode === 'signup' ? await signUp(email, password) : await signIn(email, password);
    if (result.confirmationRequired) {
      setAuthMode('signin');
      message('auth-message', 'Confira seu e-mail para confirmar a conta e depois entre na agenda.');
      return;
    }
    await startApp(result.user);
  } catch (error) {
    message('auth-message', error.message);
  } finally {
    submit.disabled = false;
  }
});
$('sign-out').onclick = async () => {
  await signOut();
  user = null;
  calendars = {};
  googleLinkId = null;
  events = [];
  status = { ready: false, connected: false };
  active = null;
  loaded = false;
  request++;
  $('shell').hidden = true;
  $('auth-screen').hidden = false;
  $('auth-email').value = '';
  $('auth-password').value = '';
  message('auth-message', '');
};
$('legacy-import').onclick = importLegacy;
if (consumeRecoveryLink()) setAuthMode('reset');
else if (!isConfigured()) message('auth-message', 'A autenticação ainda precisa ser configurada no arquivo .env.');
else if (getUser()) startApp(getUser());

