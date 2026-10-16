'use strict';

// Slice 5 Telegram publisher. The formatter is pure and the client is shadow-first, so these
// run with no network and no credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatSignal, istDateTime, TelegramClient } = require('../src/telegram');

const signal = {
  horizon: 'SWING',
  symbol: 'NIFTY',
  direction: 'BULLISH',
  kind: 'OPTION',
  instrument: 'NIFTY 27OCT2026 25000 CE',
  strike: 25000,
  option_type: 'CE',
  expiry: '27OCT2026',
  entry: 120,
  stop: 84,
  target: 192,
  rr: 2,
  confidence: 0.62,
  strategy_version: 'signal-v1',
  reasons: ['bias BULLISH at 0.62 confidence with a tradeable OPTION plan', 'spot 25000 (nse-underlying)'],
};

test('istDateTime renders IST on an explicit offset', () => {
  assert.equal(istDateTime('2026-10-14T05:00:00Z'), '14 Oct 2026, 10:30');
  assert.equal(istDateTime('2026-10-14T20:15:00Z'), '15 Oct 2026, 01:45');
  assert.equal(istDateTime('nonsense'), '-');
});

test('formatSignal names the trade, the levels and the contract', () => {
  const text = formatSignal(signal, { mode: 'live', now: '2026-10-14T05:00:00Z' });
  assert.equal(text.includes('SWING NIFTY - BULLISH'), true);
  assert.equal(text.includes('NIFTY 27OCT2026 25000 CE'), true);
  assert.equal(text.includes('Entry: 120.00'), true);
  assert.equal(text.includes('Stop: 84.00'), true);
  assert.equal(text.includes('Target: 192.00'), true);
  assert.equal(text.includes('R:R 2.00 | Confidence 62%'), true);
  assert.equal(text.includes('Decided: 14 Oct 2026, 10:30 IST'), true);
});

test('formatSignal labels shadow mode without pretending it was delivered', () => {
  const text = formatSignal(signal, { mode: 'shadow', now: '2026-10-14T05:00:00Z' });
  assert.equal(text.startsWith('TRADING FACTORY - SIGNAL (SHADOW)'), true);
  assert.equal(text.includes('SHADOW MODE: composed only'), true);
  const live = formatSignal(signal, { mode: 'live', now: '2026-10-14T05:00:00Z' });
  assert.equal(live.startsWith('TRADING FACTORY - SIGNAL\n'), true);
  assert.equal(live.includes('SHADOW MODE'), false);
});

test('formatSignal is strict ASCII so the alert channel cannot carry mojibake', () => {
  const text = formatSignal(signal, { mode: 'shadow' });
  // eslint-disable-next-line no-control-regex
  assert.equal(/[^\x00-\x7F]/.test(text), false);
});

test('formatSignal always carries the manual-execution disclaimer', () => {
  const text = formatSignal(signal, { mode: 'live' });
  assert.equal(text.includes('Execution is always manual'), true);
});

test('formatSignal survives missing levels and a spot plan', () => {
  const text = formatSignal({
    horizon: 'INTRADAY', symbol: 'RELIANCE', direction: 'BEARISH', kind: 'SPOT', entry: null, stop: null, target: null, rr: null, confidence: null,
  }, { mode: 'live' });
  assert.equal(text.includes('RELIANCE spot / futures'), true);
  assert.equal(text.includes('Entry: -'), true);
  assert.equal(text.includes('Confidence -'), true);
});

test('a shadow client never touches the network', async () => {
  let called = false;
  const client = new TelegramClient({
    token: 'x', chatId: 'y', mode: 'shadow',
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  const result = await client.send('hello');
  assert.equal(called, false);
  assert.equal(result.delivered, false);
  assert.equal(result.skipped, 'shadow');
  assert.equal(client.shadow, true);
});

test('a live client posts to sendMessage and reports delivery', async () => {
  const calls = [];
  const client = new TelegramClient({
    token: 'tok', chatId: '42', apiRoot: 'https://api.telegram.org', mode: 'live',
    fetchImpl: async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200 }; },
  });
  const result = await client.send('hello');
  assert.equal(result.delivered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.telegram.org/bottok/sendMessage');
  assert.equal(JSON.parse(calls[0].options.body).chat_id, '42');
});

test('a live client reports a failed delivery instead of throwing', async () => {
  const client = new TelegramClient({
    token: 'tok', chatId: '42', mode: 'live',
    fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'chat not found' }),
  });
  const result = await client.send('hello');
  assert.equal(result.delivered, false);
  assert.equal(result.error.includes('400'), true);
});

test('a live client that is not configured skips without a request', async () => {
  const client = new TelegramClient({ token: '', chatId: '', mode: 'live' });
  assert.equal(client.configured(), false);
  const result = await client.send('hello');
  assert.equal(result.delivered, false);
  assert.equal(result.skipped, 'not-configured');
});
