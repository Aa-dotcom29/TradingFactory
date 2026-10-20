'use strict';

// The exchange session clock. One source of truth, shared by the risk gate (slice 5), the bias
// meter (slice 3's price and flow components), the ingestion gates (slice 9) and the supervisor's
// feed freshness. Pure: an explicit IST offset, never the host timezone, no network and no
// database.
//
// NSE trades in IST, on weekdays, between two wall-clock times, and not on a published holiday.
//
// The holiday list used to be missing, on the reasoning that a holiday simply produces no fresh
// evidence upstream so nothing downstream would fire. A live Dussehra disproved it: with the clock
// reporting an open market, the bias meter did not age the previous session's prices, the signal
// builder composed tradeable plans from them, and the risk gate - seeing a normal open session -
// approved. Every one of those steps was behaving correctly given a clock that was wrong. So the
// list is here now.
//
// It is year-specific, which makes it data rather than a guarantee. It lives below so the harness
// is correct out of the box, and a `risk` config row may replace it wholesale via
// `gates.session.holidays`. It has to be refreshed each year. A stale list fails safe in the only
// direction that matters: a date from a past year never matches today, so the clock degrades to
// the old weekend-and-hours behaviour rather than inventing a closed market.
//
// Source: the NSE/BSE trading-holiday list for 2026, weekdays only. Holidays that fall on a
// Saturday or Sunday are omitted because the weekend rule already covers them, and clearing-only
// holidays are omitted because on those the member banks shut but the exchange trades.
const NSE_HOLIDAYS_2026 = [
  '2026-01-15', // Municipal Corporation Election, Maharashtra
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
];

// Muhurat trading - the one-hour evening session held on Diwali Laxmi Pujan - is deliberately not
// modelled. It is a single discretionary hour, its timing is announced late, and treating it as an
// ordinary session would do more harm than standing down for it.

const DEFAULT_SESSION = {
  enforce: true,
  openMinutes: 555, // 09:15 IST
  closeMinutes: 930, // 15:30 IST
  weekdaysOnly: true,
  holidays: NSE_HOLIDAYS_2026,
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
  const holidays = Array.isArray(session.holidays) ? session.holidays : [];
  if (holidays.includes(clock.date)) {
    return {
      ...clock,
      open: false,
      holiday: clock.date,
      reason: `NSE is closed for a holiday on ${clock.date} (session ${window})`,
    };
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
  NSE_HOLIDAYS_2026,
  istClock,
  hhmm,
  marketSession,
  isMarketOpen,
  istDayStart,
};
