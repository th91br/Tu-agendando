const outcomes = {
  scheduled: 'Planejado', completed: 'Concluído', missed: 'Faltei',
  no_show: 'Não compareceu', rescheduled: 'Remarcado',
};

export function eventBounds(event) {
  // The app's calendar uses America/Sao_Paulo for day boundaries.
  const start = event.allDay ? Date.parse(event.start + 'T03:00:00Z') : Date.parse(event.start);
  const end = event.allDay ? Date.parse(event.end + 'T03:00:00Z') : Date.parse(event.end);
  return [start, end];
}

export function overlappingAppointments(candidate, others, current) {
  const [start, end] = eventBounds(candidate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  return others.filter(event => {
    if (current && (event.dbId && event.dbId === current.dbId ||
      event.googleEventId && event.googleEventId === current.googleEventId)) return false;
    if (['missed', 'no_show'].includes(event.attendanceStatus)) return false;
    const [otherStart, otherEnd] = eventBounds(event);
    return start < otherEnd && otherStart < end;
  });
}

function escapeIcs(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/\r\n|\n|\r/g, '\\n')
    .replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function fold(line) {
  const encoder = new TextEncoder();
  const parts = [];
  let current = '', bytes = 0;
  for (const char of line) {
    const length = encoder.encode(char).length;
    if (bytes + length > 75) {
      parts.push(current);
      current = ' ';
      bytes = 1;
    }
    current += char;
    bytes += length;
  }
  parts.push(current);
  return parts.join('\r\n');
}

const dateValue = value => value.replaceAll('-', '');
const utcValue = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

export function calendarIcs(events, generatedAt = new Date()) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tu Agendando//Agenda//PT-BR',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
  ];
  for (const [index, event] of events.entries()) {
    const [start, end] = eventBounds(event);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) continue;
    const id = String(event.dbId || event.id || index).replace(/[^A-Za-z0-9_-]/g, '');
    const notes = [outcomes[event.attendanceStatus] &&
      'Situação: ' + outcomes[event.attendanceStatus], event.notes].filter(Boolean).join('\n');
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + id + '@tu-agendando',
      'DTSTAMP:' + utcValue(generatedAt),
      event.allDay ? 'DTSTART;VALUE=DATE:' + dateValue(event.start) : 'DTSTART:' + utcValue(event.start),
      event.allDay ? 'DTEND;VALUE=DATE:' + dateValue(event.end) : 'DTEND:' + utcValue(event.end),
      'SUMMARY:' + escapeIcs(event.title),
    );
    if (event.location) lines.push('LOCATION:' + escapeIcs(event.location));
    if (notes) lines.push('DESCRIPTION:' + escapeIcs(notes));
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR', '');
  return lines.map(fold).join('\r\n');
}
