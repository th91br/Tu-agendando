import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarIcs, overlappingAppointments } from '../public/calendar-utils.js';

test('overlap detects an appointment spanning another and excludes its own row', () => {
  const existing = { dbId: 'one', start: '2026-11-12T12:00:00.000Z', end: '2026-11-12T13:00:00.000Z' };
  const candidate = { start: '2026-11-12T12:30:00.000Z', end: '2026-11-12T13:30:00.000Z' };
  assert.equal(overlappingAppointments(candidate, [existing]).length, 1);
  assert.equal(overlappingAppointments(candidate, [existing], { dbId: 'one' }).length, 0);
  assert.equal(overlappingAppointments({ start: existing.end, end: '2026-11-12T14:00:00.000Z' }, [existing]).length, 0);
});

test('all-day events respect São Paulo day boundaries and do not flag a missed appointment', () => {
  const allDay = { start: '2026-11-12', end: '2026-11-13', allDay: true };
  assert.equal(overlappingAppointments(
    { start: '2026-11-13T01:00:00.000Z', end: '2026-11-13T02:00:00.000Z' }, [allDay]).length, 1);
  assert.equal(overlappingAppointments(
    { start: '2026-11-13T03:00:00.000Z', end: '2026-11-13T04:00:00.000Z' }, [allDay]).length, 0);
  assert.equal(overlappingAppointments(allDay, [{ ...allDay, attendanceStatus: 'missed' }]).length, 0);
});

test('ICS escapes user content, folds UTF-8 lines and keeps all-day exclusive end', () => {
  const value = calendarIcs([{
    id: 'abc-1', title: 'Reunião; PF, PJ\\Agenda', start: '2026-11-12', end: '2026-11-13',
    allDay: true, notes: 'linha 1\n' + 'á'.repeat(100), attendanceStatus: 'completed',
  }], new Date('2026-11-12T14:00:00.000Z'));
  assert.match(value, /DTSTART;VALUE=DATE:20261112\r\n/);
  assert.match(value, /DTEND;VALUE=DATE:20261113\r\n/);
  assert.match(value, /SUMMARY:Reunião\\; PF\\, PJ\\\\Agenda/);
  assert.match(value, /DESCRIPTION:Situação: Concluído\\nlinha 1\\n/);
  assert.ok(value.split('\r\n').every(line => Buffer.byteLength(line, 'utf8') <= 75));
});
