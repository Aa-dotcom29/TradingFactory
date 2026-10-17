'use strict';

// The exchange session clock. One source of truth, shared by the risk gate (slice 5) and the
// bias meter (slice 3's price component). Pure: an explicit IST offset, never the host timezone,
// no network and no database.
//
// NSE trades in IST. Public holidays are not modelled: a holiday simply produces no fresh
// evidence upstream, so no candidate is raised in the first place.

const DEFAULT_SESSION = {
  enforce: true,
  openMinutes: 555, // 09:15 IST
  closeMinutes: 930, // 15:30 IST
  weekdaysOnly: true,
};

function istClock(now = Date.now()) {
  const shifted = new Date(new Date(now).getTime() + 5.5 * 3600 * 1000);
  return {
    weekday: shifted.getUTCDay(), // 0 = Sunday
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    date: shifted.toISOString().slice(0, 10),
  };
}

const hhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function marketSession(now = Date.now(), session = DEFAULT_SESSION) {
  const clock = istClock(now);
  const window = `${hhmm(session.openMinutes)}-${hhmm(session.closeMinutes)} IST`;
  if (session.weekdaysOnly && (clock.weekday === 0 || clock.weekday === 6)) {
    return { ...clock, open: false, reason: `NSE is closed at the weekend (session ${window})` };
  }
  if (clock.minutes < session.openMinutes) {
    return { ...clock, open: false, reason: `before the NSE open (session ${window})` };
  }
  if (clock.minutes >= session.closeMinutes) {
    return { ...clock, open: false, reason: `after the NSE close (session ${window})` };
  }
  return { ...clock, open: true, reason: null };
}

const isMarketOpen = (now = Date.now(), session = DEFAULT_SESSION) =>
  marketSession(now, session).open;

// Midnight IST for the calendar day `now` falls in, as an ISO string. This is the boundary the
// daily-loss control resets on: the Indian trading day, not the UTC day (which would roll over at
// 05:30 IST, part-way through the morning, wiping a losing day's tally before the market even opens
// and carrying last night's after-hours losses into the new one).
function istDayStart(now = Date.now()) {
  const clock = istClock(now);
  return new Date(Date.parse(`${clock.date}T00:00:00.000+05:30`)).toISOString();
}

module.exports = {
  DEFAULT_SESSION,
  istClock,
  hhmm,
  marketSession,
  isMarketOpen,
  istDayStart,
};
