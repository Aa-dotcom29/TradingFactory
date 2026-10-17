'use strict';

// Angel One credential preflight.
//
//   npm run harness:angel-check
//
// Use this the moment the four SmartAPI values are in .env. It answers one question: "will the
// live feed actually work?", and it answers it before a market session, without touching the
// database or the queue. It never prints a secret.
//
// Steps, each reported separately so a failure points at the cause:
//   1. are all four values present?
//   2. does login + TOTP succeed?
//   3. does the instrument master download and resolve the indices?
//   4. does a FULL quote return rows - with the exchange timestamp the bias meter ages on?
//   5. (best effort) does an option premium come back for the at-the-money contract, which is what
//      makes an option-premium position scorable?
//   6. (best effort) does the option-Greek endpoint answer for the nearest NIFTY expiry?

const config = require('../src/config');
const { AngelClient } = require('../src/sources/angel-client');
const { parseAngelTime } = require('../src/sources/angel-quote');
const { matchOptionToken } = require('../src/contract');

const REQUIRED = ['ANGEL_CLIENT_ID', 'ANGEL_API_KEY', 'ANGEL_PASSWORD', 'ANGEL_TOTP_SECRET'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function pass(label, detail) {
  console.log(`PASS  ${label}${detail ? `  - ${detail}` : ''}`);
}
function fail(label, detail) {
  console.log(`FAIL  ${label}${detail ? `  - ${detail}` : ''}`);
}
function info(label, detail) {
  console.log(`      ${label}${detail ? `  - ${detail}` : ''}`);
}

// Angel writes expiry both as ISO (2025-06-26) and as DDMMMYYYY (26JUN2025); try both.
function expiryIso(value) {
  const text = String(value || '').toUpperCase().trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = text.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (compact) {
    const month = MONTHS.indexOf(compact[2]) + 1;
    if (!month) return null;
    return `${compact[3]}-${String(month).padStart(2, '0')}-${compact[1]}`;
  }
  return null;
}

function nearestExpiry(instruments) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dates = new Set();
  for (const row of instruments) {
    if (String(row.exch_seg).toUpperCase() !== 'NFO') continue;
    if (String(row.instrumenttype).toUpperCase() !== 'OPTIDX') continue;
    if (String(row.name).toUpperCase() !== 'NIFTY') continue;
    const iso = expiryIso(row.expiry);
    if (iso) dates.add(iso);
  }
  return [...dates]
    .filter((iso) => new Date(`${iso}T00:00:00Z`).getTime() >= today.getTime())
    .sort()[0] || null;
}

async function main() {
  console.log('Trading Factory - Angel One preflight');
  console.log(`  apiRoot=${config.angel.apiRoot}`);

  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (!config.angel.configured()) {
    fail('credentials configured', `missing ${missing.join(', ')}`);
    info('next step', 'copy the four SmartAPI values into .env (see docs/angel-one-onboarding.md)');
    return 1;
  }
  pass('credentials configured', REQUIRED.map((name) => `${name}=set`).join(' '));
  info('note', 'SmartAPI requires the calling public IP to be registered as the primary IP on the app');

  const client = new AngelClient();

  try {
    await client.login();
    pass('login + TOTP', 'access token acquired');
  } catch (error) {
    fail('login + TOTP', error.message);
    info('common causes', 'wrong client code/pin, a TOTP secret whose clock has drifted, or an unregistered public IP');
    return 1;
  }

  let instruments;
  try {
    instruments = await client.ensureInstruments();
    pass('instrument master', `${instruments.length} rows`);
  } catch (error) {
    fail('instrument master', error.message);
    return 1;
  }

  const tokens = client.resolveIndexTokens();
  if (!tokens.length) {
    fail('index tokens', 'none of the configured indices were found in the master');
    return 1;
  }
  pass('index tokens', tokens.map((t) => `${t.name}=${t.token}`).join(' '));

  const niftyToken = (tokens.find((t) => t.name === 'NIFTY 50') || {}).token || null;
  let quotes = [];
  try {
    quotes = await client.quote('FULL', { NSE: tokens.map((t) => t.token) });
    if (!quotes.length) {
      fail('FULL quote', 'no rows returned');
      return 1;
    }
    const stamped = quotes.filter((q) => parseAngelTime(q.exchFeedTime || q.exchTradeTime)).length;
    pass('FULL quote', `${quotes.length} row(s), ${stamped} with an exchange timestamp`);
    for (const q of quotes) {
      const when = parseAngelTime(q.exchFeedTime || q.exchTradeTime);
      info('quote', `${q.tradingSymbol || q.symbolToken} ltp=${q.ltp} close=${q.close} exchFeedTime=${q.exchFeedTime} -> ${when}`);
    }
    if (!stamped) {
      info('warning', 'no exchange timestamp on any row; the bias meter would fall back to capture time');
    }
  } catch (error) {
    fail('FULL quote', error.message);
    return 1;
  }

  const expiry = nearestExpiry(instruments);

  // The option-premium path: this is what makes an option-premium position scorable rather than
  // settled with no verdict. Resolve the at-the-money CE for the nearest expiry through the same
  // matcher W0 uses, then quote it on the derivatives exchange.
  const niftyLtp = Number((quotes.find((q) => String(q.symbolToken) === String(niftyToken)) || {}).ltp) || null;
  if (!expiry) {
    info('option quote', 'no current NIFTY OPTIDX expiry in the master; skipped');
  } else if (!niftyLtp) {
    info('option quote', 'no NIFTY spot price to anchor an at-the-money strike');
  } else {
    const series = instruments.filter((r) => String(r.exch_seg).toUpperCase() === 'NFO'
      && String(r.instrumenttype).toUpperCase() === 'OPTIDX'
      && String(r.name).toUpperCase() === 'NIFTY'
      && expiryIso(r.expiry) === expiry
      && String(r.symbol).toUpperCase().endsWith('CE'));
    const atm = series.reduce((best, r) => (
      best === null || Math.abs(Number(r.strike) / 100 - niftyLtp) < Math.abs(Number(best.strike) / 100 - niftyLtp) ? r : best
    ), null);
    const match = atm
      ? matchOptionToken(instruments, { symbol: 'NIFTY 50', expiry, strike: Number(atm.strike) / 100, optionType: 'CE' })
      : null;
    if (!match) {
      info('option quote', `no at-the-money CE contract resolved for ${expiry}`);
    } else {
      try {
        const rows = await client.quote('FULL', { NFO: [match.token] });
        if (!rows.length) {
          info('option quote', `no premium returned for ${match.tradingSymbol}`);
        } else {
          const q = rows[0];
          const when = parseAngelTime(q.exchFeedTime || q.exchTradeTime);
          pass('option quote', `${match.tradingSymbol} ltp=${q.ltp} openInterest=${q.opnInterest} -> ${when}`);
        }
      } catch (error) {
        info('option quote', `unavailable for ${match.tradingSymbol}: ${error.message}`);
      }
    }
  }

  if (!expiry) {
    info('option greeks', 'no current NIFTY OPTIDX expiry in the master; skipped');
  } else {
    try {
      const greeks = await client.optionGreeks('NIFTY', expiry);
      pass('option greeks', `${greeks.length} contract(s) for ${expiry}`);
    } catch (error) {
      // Not a FAIL: greeks are only used for context, and Angel commonly answers "No Data
      // Available" outside market hours. Surface the reason instead of hiding it.
      const hint = /no data available/i.test(error.message) ? ' (Angel serves greeks only around market hours)' : '';
      info('option greeks', `unavailable for ${expiry}: ${error.message}${hint}`);
    }
  }

  console.log('\nAngel One is ready. Set HARNESS_ROLE=all (or w0) and the pipeline will prefer it over Yahoo.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`FAIL  unexpected error: ${error.message}`);
    process.exit(1);
  });
