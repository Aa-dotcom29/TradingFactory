import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compact,
  num,
  pct,
  signed,
  isNum,
  readTone,
  sentimentTone,
  severityTone,
  directionTone,
  scoreTone,
  stageTone,
  candidateStatusTone,
  decisionTone,
  publishModeTone,
  provenanceTone,
  provenanceLabel,
  outcomeTone,
  resultTone,
  resultLabel,
  istStamp,
  timeAgo,
} from '../lib/format.js';

test('compact uses Indian lakh/crore units', () => {
  assert.equal(compact(2500), '2.5K');
  assert.equal(compact(1500000), '15.00L');
  assert.equal(compact(12345678), '1.23Cr');
  assert.equal(compact(-97000), '-97.0K');
  assert.equal(compact(null), '-');
});

test('missing values render as "-" rather than 0', () => {
  assert.equal(compact(null), '-');
  assert.equal(num(null), '-');
  assert.equal(pct(undefined), '-');
  assert.equal(signed(''), '-');
  assert.equal(isNum(null), false);
  assert.equal(isNum(''), false);
  assert.equal(isNum(0), true);
  assert.equal(num(0), '0');
});

test('pct and signed add explicit direction', () => {
  assert.equal(pct(3.456), '+3.5%');
  assert.equal(pct(-2), '-2.0%');
  assert.equal(signed(1500), '+1,500');
  assert.equal(signed(-42), '-42');
});

test('readTone maps build-up quadrants to colour tones', () => {
  assert.equal(readTone('LONG BUILDUP'), 'up');
  assert.equal(readTone('SHORT COVERING'), 'up');
  assert.equal(readTone('SHORT BUILDUP'), 'down');
  assert.equal(readTone('LONG UNWINDING'), 'down');
  assert.equal(readTone('NO CHANGE'), 'muted');
});

test('sentiment, severity and direction tones', () => {
  assert.equal(sentimentTone(0.9), 'up');
  assert.equal(sentimentTone(-0.5), 'down');
  assert.equal(sentimentTone(0.1), 'muted');
  assert.equal(severityTone('CRITICAL'), 'down');
  assert.equal(severityTone('HIGH'), 'warn');
  assert.equal(directionTone('BULLISH'), 'up');
  assert.equal(directionTone('BEARISH'), 'down');
  // A score inside the dead-band must not read as a direction.
  assert.equal(scoreTone(0.42), 'up');
  assert.equal(scoreTone(-0.42), 'down');
  assert.equal(scoreTone(0.02), 'muted');
  assert.equal(scoreTone(-0.02), 'muted');
  assert.equal(scoreTone(null), 'muted');
});

test('stage and candidate tones keep READY distinct from "forming"', () => {
  assert.equal(stageTone('READY'), 'up');
  assert.equal(stageTone('BUILDING'), 'warn');
  assert.equal(stageTone('WATCH'), 'muted');
  assert.equal(stageTone('ACTIVE'), 'accent');
  assert.equal(stageTone('BLOCKED'), 'down');
  assert.equal(stageTone('EXITED'), 'muted');
  assert.equal(stageTone(undefined), 'muted');

  assert.equal(candidateStatusTone('pending_risk'), 'warn');
  assert.equal(candidateStatusTone('approved'), 'up');
  assert.equal(candidateStatusTone('rejected'), 'down');
  assert.equal(candidateStatusTone('superseded'), 'muted');
});

test('risk decisions colour only an approval as a green light', () => {
  assert.equal(decisionTone('APPROVED'), 'up');
  assert.equal(decisionTone('REJECTED'), 'down');
  // A deferral is "nothing failed, the market is shut" - neither a pass nor a failure.
  assert.equal(decisionTone('DEFERRED'), 'warn');
  assert.equal(decisionTone(undefined), 'muted');
  assert.equal(publishModeTone('shadow'), 'warn');
  assert.equal(publishModeTone('live'), 'accent');
});

test('provenance never dresses a delayed read up as a live one', () => {
  assert.equal(provenanceTone('angel-live'), 'accent');
  assert.equal(provenanceTone('yahoo-delayed'), 'warn');
  assert.equal(provenanceTone(null), 'muted');
  assert.equal(provenanceTone('something-else'), 'muted');
  assert.equal(provenanceLabel('angel-live'), 'live feed');
  assert.equal(provenanceLabel('yahoo-delayed'), 'delayed quotes');
  assert.equal(provenanceLabel(null), 'source unknown');
});

// Slice 7: a settled position. Green only for a profit, red only for a loss, and TIME is its own
// colour because "the window ran out" is neither until you read the P&L.
test('outcome tones separate profit, loss and a flat close', () => {
  assert.equal(outcomeTone(10), 'up');
  assert.equal(outcomeTone(-4.2), 'down');
  assert.equal(outcomeTone(0), 'muted');
  assert.equal(outcomeTone(null), 'muted');
  assert.equal(outcomeTone('not-a-number'), 'muted');
});

test('exit reasons colour by what ended the trade, not by profit', () => {
  assert.equal(resultTone('TARGET'), 'up');
  assert.equal(resultTone('STOP'), 'down');
  assert.equal(resultTone('TIME'), 'warn');
  assert.equal(resultTone(undefined), 'muted');
  assert.equal(resultLabel('TARGET'), 'target hit');
  assert.equal(resultLabel('STOP'), 'stopped out');
  assert.equal(resultLabel('TIME'), 'window ended');
  assert.equal(resultLabel(null), 'open');
});

test('istStamp renders in Asia/Kolkata, not local time', () => {
  // 10:00 UTC is 15:30 IST.
  const out = istStamp('2026-10-16T10:00:00.000Z');
  assert.match(out, /15:30/);
  assert.match(out, /Oct/);
});

test('timeAgo produces coarse buckets and handles bad input', () => {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(timeAgo(ago(30 * 1000)), '30s ago');
  assert.equal(timeAgo(ago(90 * 60 * 1000)), '1h ago');
  assert.equal(timeAgo(ago(48 * 60 * 60 * 1000)), '2d ago');
  assert.equal(timeAgo('not-a-date'), '-');
});

test('formatters stay ASCII (no mojibake)', () => {
  const samples = [compact(12345678), pct(1.2), signed(5), istStamp('2026-10-16T10:00:00Z')];
  for (const s of samples) assert.match(s, /^[\x20-\x7E]+$/);
});
