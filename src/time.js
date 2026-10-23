// Dates are exchanged as instants (UTC). The club plays in Slovakia, so "the
// day of a match" means the day in Europe/Bratislava.

const ZONE = 'Europe/Bratislava';

const partsFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The wall-clock parts of an instant in Slovakia. */
export function slovakParts(date) {
  const parts = {};
  for (const { type, value } of partsFormat.formatToParts(date)) {
    if (type !== 'literal') parts[type] = Number(value);
  }
  return parts;
}

/** "2026-10-17" for the Slovak day of [date]. */
export function slovakDay(date) {
  const p = slovakParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The instant at which the Slovak day of [date] begins. */
export function slovakMidnight(date) {
  const p = slovakParts(date);
  const utcMidnight = Date.UTC(p.year, p.month - 1, p.day);
  // Slovakia is 2 hours ahead of UTC in summer and 1 hour in winter.
  for (const offset of [120, 60]) {
    const candidate = new Date(utcMidnight - offset * 60000);
    const q = slovakParts(candidate);
    if (q.day === p.day && q.hour === 0 && q.minute === 0) return candidate;
  }
  return new Date(utcMidnight - 60 * 60000);
}

/** The hour (0-23) in Slovakia. */
export function slovakHour(date) {
  return slovakParts(date).hour;
}
