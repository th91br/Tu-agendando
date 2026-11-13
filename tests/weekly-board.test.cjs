// DOM integration tests with simulated data. Run through npm test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { JSDOM } = require(process.env.JSDOM_MODULE || 'jsdom');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
const source = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8').replace(/^import[\s\S]*?from '[^']+';\s*/gm, '');
let checks = 0;
async function check(name, task) { await task(); checks++; process.stdout.write('PASS ' + name + '\n'); }
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(width = 1440) {
  const dom = new JSDOM(html, { url: 'http://test.invalid/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const database = [], writes = [];
  let writeMode = 'success', readFails = false;
  w.matchMedia = () => ({ matches: width <= 820, addEventListener() {} });
  w.crypto.randomUUID = randomUUID;
  w.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  w.HTMLDialogElement.prototype.close = function() { this.open = false; };
  w.HTMLElement.prototype.scrollTo = function(options) { this.scrollLeft = options.left; };
  w.setInterval = () => 0;
  w.isConfigured = () => true;
  w.getUser = () => null;
  w.signOut = async () => {}; 
  w.consumeRecoveryLink = () => false;
  Object.assign(w, await import('../public/calendar-utils.js'));
  w.accessToken = async () => 'test-only-token';
  w.callRpc = async () => {};
  w.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
  w.selectRows = async table => {
    if (table === 'calendars') return [{ id: 'pf-calendar', kind: 'pf' }, { id: 'pj-calendar', kind: 'pj' }];
    if (readFails) throw new Error('Erro de leitura simulado');
    return database.map(row => ({ ...row }));
  };
  w.updateRows = async (table, params, values) => {
    writes.push({ table, params: { ...params }, values: { ...values } });
    if (writeMode === 'network') throw new Error('Sem conexão');
    if (writeMode === 'conflict') return [];
    const row = database.find(row => params.id === 'eq.' + row.id && params.user_id === 'eq.' + row.user_id && params.etag === 'eq.' + row.etag);
    if (!row) return [];
    Object.assign(row, values, { etag: randomUUID() });
    return [{ ...row }];
  };
  w.insertRows = async (table, rows) => {
    const inserted = rows.map(row => ({ ...row, etag: randomUUID() }));
    database.push(...inserted);
    return inserted;
  };
  w.eval(source + `\nwindow.testApp = { startApp, showCalendar, choose, range, boardTime, eventOn, conflictsFor, rescheduleEvent, openEditor, persistEvent, dbEvent, fromDb, fromGoogle, iso, clock, shift, monday, today, render, load, field, get events() {return events}, get selected() {return selected}, get view(){return view}, get user(){return user}, get pendingStatus(){return pendingStatus} };`);
  await w.testApp.startApp({ id: 'test-owner', email: 'test@example.invalid' });
  return { dom, w, app: w.testApp, database, writes, writeMode: value => { writeMode = value; }, readFails: value => { readFails = value; } };
}
function row(app, id, day, start = '09:00', end = '10:00', extra = {}) {
  return { id, user_id: 'test-owner', calendar_id: 'pf-calendar', category: 'pf', title: id,
    start_at: app.iso(day + 'T' + start), end_at: app.iso(day + 'T' + end),
    all_day: false, attendance_status: 'scheduled', etag: randomUUID(), ...extra };
}
(async () => {
  const context = await setup();
  const { w, app, database, writes } = context;
  const monday = app.monday(app.today());
  database.push(row(app, 'late', monday, '14:00', '15:00'), row(app, 'early', monday, '09:00', '10:00'),
    row(app, 'overlap', monday, '09:30', '10:30', { category: 'pj' }),
    row(app, 'sunday', app.shift(monday, 6), '16:00', '17:00'),
    row(app, 'xss', monday, '11:00', '12:00', { title: '<img src=x onerror=alert(1)>' }));
  await check('Static hosting without Google backend still loads the agenda', async () => {
    assert.equal(w.document.querySelector('#auth-screen').hidden, true);
    assert.equal(w.document.querySelector('#dashboard-warning').hidden, true);
  });
  await check('Calendar opens the seven-day board and orders appointments by time', async () => {
    app.showCalendar(monday, 'board'); await tick();
    assert.equal(w.document.querySelectorAll('.board-day').length, 7);
    assert.deepEqual(Array.from(w.document.querySelectorAll('.board-day-heading h3'), n => n.textContent), ['Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado','Domingo']);
    assert.deepEqual(Array.from(w.document.querySelector('.board-day').querySelectorAll('.appointment-card'), n => n.dataset.eventId), ['early','overlap','xss','late']);
    assert.equal(w.document.querySelectorAll('.overlap-label').length, 2);
    assert.equal(w.document.querySelectorAll('.appointment-card img').length, 0);
    assert.match(w.document.querySelector('[data-event-id=xss] .appointment-title').textContent, /^<img/);
  });
  await check('Sunday has its own appointments and creation action', async () => {
    const sunday = w.document.querySelectorAll('.board-day')[6];
    assert.equal(sunday.querySelector('.appointment-title').textContent, 'sunday');
    sunday.querySelector('.board-add').click();
    assert.equal(app.field('start').value, app.shift(monday, 6) + 'T09:00');
    w.document.querySelector('#editor').close();
  });
  await check('Attendance writes only the owned row with concurrency protection', async () => {
    let select = w.document.querySelector('[data-event-id=early] .attendance-select');
    select.value = 'completed'; select.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(database.find(e => e.id === 'early').attendance_status, 'completed');
    assert.equal(w.document.querySelector('[data-event-id=early] .attendance-select').value, 'completed');
    assert.equal(writes.at(-1).params.user_id, 'eq.test-owner');
    assert.ok(writes.at(-1).params.etag.startsWith('eq.'));
    assert.deepEqual(writes.at(-1).values, { attendance_status: 'completed' });
    assert.equal(w.document.querySelector('[data-event-id=early] .attendance-select').disabled, false);
    await app.load();
    assert.equal(w.document.querySelector('[data-event-id=early] .attendance-select').value, 'completed');
  });
  await check('A stale row or network failure does not falsely confirm an attendance change', async () => {
    for (const mode of ['conflict','network']) {
      context.writeMode(mode);
      const select = w.document.querySelector('[data-event-id=late] .attendance-select');
      select.value = 'missed'; select.dispatchEvent(new w.Event('change')); await tick();
      assert.equal(select.value, 'scheduled'); assert.equal(select.disabled, false);
      assert.equal(database.find(e => e.id === 'late').attendance_status, 'scheduled');
    }
    context.writeMode('success');
  });
  await check('Drag rescheduling opens a review and preserves time across midnight', async () => {
    const original = app.fromDb(row(app, 'overnight', '2026-12-31', '23:30', '23:59', { end_at: app.iso('2027-01-01T01:00') }));
    const writesBefore = writes.length;
    app.rescheduleEvent(original, '2027-01-03');
    assert.equal(app.field('start').value, '2027-01-03T23:30');
    assert.equal(app.field('end').value, '2027-01-04T01:00');
    assert.equal(app.pendingStatus, 'rescheduled');
    assert.equal(writes.length, writesBefore);
    assert.match(w.document.querySelector('#form-message').textContent, /só será feita ao salvar/);
    w.document.querySelector('#editor').close();
  });
  await check('Selecting Remarcado reviews the schedule before any write', async () => {
    const select = w.document.querySelector('[data-event-id=late] .attendance-select');
    const writesBefore = writes.length;
    select.value = 'rescheduled'; select.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(select.value, 'scheduled');
    assert.equal(app.pendingStatus, 'rescheduled');
    assert.equal(w.document.querySelector('#editor').open, true);
    assert.equal(writes.length, writesBefore);
    w.document.querySelector('#editor').close();
  });
  await check('Saving a reviewed reschedule persists the new date, time and status together', async () => {
    const event = app.events.find(e => e.dbId === 'late');
    const target = app.shift(monday, 1);
    app.rescheduleEvent(event, target);
    w.document.querySelector('#event-form').dispatchEvent(new w.Event('submit', { cancelable: true }));
    await tick(); await tick();
    const saved = database.find(e => e.id === 'late');
    assert.equal(app.clock(saved.start_at), target + 'T14:00');
    assert.equal(app.clock(saved.end_at), target + 'T15:00');
    assert.equal(saved.attendance_status, 'rescheduled');
    assert.equal(w.document.querySelector('#editor').open, false);
  });
  await check('Multi-day and all-day end dates remain exclusive when rescheduled', async () => {
    const event = { id: 'trip', allDay: true, start: '2026-11-30', end: '2026-12-03', title: 'Trip', category: 'pf' };
    assert.equal(app.eventOn(event, '2026-12-02'), true);
    assert.equal(app.eventOn(event, '2026-12-03'), false);
    app.rescheduleEvent(event, '2026-12-05');
    assert.equal(app.field('start').value, '2026-12-05');
    assert.equal(app.field('end').value, '2026-12-07');
    w.document.querySelector('#editor').close();
    const overnight = app.fromDb(row(app, 'night', monday, '23:30', '23:59', { end_at: app.iso(app.shift(monday, 1) + 'T01:00') }));
    assert.equal(app.boardTime(overnight, monday), '23:30 – 24:00');
    assert.equal(app.boardTime(overnight, app.shift(monday, 1)), '00:00 – 01:00');
  });
  await check('Adjacent appointments do not count as overlaps; all-day and absent items are excluded', async () => {
    const values = [row(app, 'a', monday), row(app, 'b', monday, '10:00', '11:00'),
      row(app, 'c', monday, '09:30', '10:30', { attendance_status: 'missed' }),
      row(app, 'd', monday, '09:30', '10:30', { all_day: true })].map(app.fromDb);
    assert.equal(app.conflictsFor(values, monday).size, 0);
  });
  await check('Saving a new appointment preserves the selected attendance status', async () => {
    app.openEditor(null, monday);
    const body = { title: 'New appointment', category: 'pj', start: app.iso(monday + 'T18:00'), end: app.iso(monday + 'T19:00'), allDay: false, attendanceStatus: 'rescheduled' };
    const result = await app.persistEvent(body);
    assert.equal(result.row.attendance_status, 'rescheduled');
    assert.equal(result.row.user_id, 'test-owner');
    w.document.querySelector('#editor').close();
  });
  await check('Category filters and search apply to the board', async () => {
    const input = w.document.querySelector('#search'); input.value = 'sunday'; input.dispatchEvent(new w.Event('input'));
    assert.equal(w.document.querySelectorAll('.appointment-card').length, 1);
    input.value = ''; input.dispatchEvent(new w.Event('input'));
    w.document.querySelector('#filters input[value=pf]').checked = false;
    w.document.querySelector('#filters').dispatchEvent(new w.Event('change'));
    assert.equal(w.document.querySelectorAll('.appointment-card.pf').length, 0);
    w.document.querySelector('#filters input[value=pf]').checked = true;
    app.render();
  });
  await check('Week navigation crosses the year boundary and retains all seven days', async () => {
    app.choose('2026-12-31', 'board'); await tick();
    assert.deepEqual(Array.from(app.range()), ['2026-12-28', '2027-01-04']);
    w.document.querySelector('#forward').click(); await tick();
    assert.deepEqual(Array.from(app.range()), ['2027-01-04', '2027-01-11']);
  });
  await check('Day, week and month views remain available', async () => {
    for (const view of ['day','week','month']) {
      app.choose(monday, view); await tick();
      assert.ok(w.document.querySelector(view === 'month' ? '.month' : '.week-scroll'));
    }
  });
  await check('Read errors are visible instead of being shown as a free week', async () => {
    database.length = 0; context.readFails(true);
    app.choose('2027-02-01', 'board'); await tick();
    assert.match(w.document.querySelector('.day-meta').textContent, /Falha/);
    assert.equal(w.document.querySelector('#warning').hidden, false);
  });
  context.dom.window.close();
  for (const width of [820, 390]) {
    await check('All seven days and day picker remain navigable with compact state at ' + width, async () => {
      const ctx = await setup(width);
      ctx.app.showCalendar(ctx.app.today(), 'board'); await tick();
      assert.equal(ctx.w.document.querySelectorAll('.board-day-picker button').length, 7);
      assert.equal(ctx.w.document.querySelectorAll('.board-day').length, 7);
      ctx.w.document.querySelectorAll('.board-day-picker button')[6].click();
      assert.equal(ctx.app.selected, ctx.app.shift(ctx.app.monday(ctx.app.today()), 6));
      ctx.w.document.querySelector('#sidebar-toggle').click();
      assert.equal(ctx.w.document.querySelector('#shell').dataset.sidebarCollapsed, 'false');
      assert.equal(ctx.w.document.querySelector('#sidebar-toggle').getAttribute('aria-expanded'), 'true');
      ctx.dom.window.close();
    });
  }
  console.log(`${checks} integration checks passed. Responsive layout is not visually verified by these DOM tests.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
