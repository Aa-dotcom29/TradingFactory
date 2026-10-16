'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { toNewsItem, scoreSentiment, classifySeverity, resolveEntities, dedupeHash, canonicalUrl } = require('../src/normalize');

test('canonicalUrl strips tracking and hash', () => {
  assert.equal(
    canonicalUrl('https://Example.com/Path/?utm_source=x&ncid=1#frag'),
    'https://example.com/path',
  );
});

test('dedupeHash ignores tracking parameters', () => {
  const a = dedupeHash({ url: 'https://e.com/a?utm_source=news', title: 'T' });
  const b = dedupeHash({ url: 'https://e.com/a', title: 'T' });
  assert.equal(a, b);
});

test('resolveEntities maps aliases to symbols', () => {
  const entities = resolveEntities('Reliance Industries, Infy and Tata Consultancy Services rally');
  assert.ok(entities.includes('RELIANCE'));
  assert.ok(entities.includes('INFY'));
  assert.ok(entities.includes('TCS'));
});

test('positive sentiment is greater than zero', () => {
  const { score } = scoreSentiment('Company beats estimates, profit surges to record high');
  assert.ok(score > 0);
});

test('negative sentiment is less than zero', () => {
  const { score } = scoreSentiment('Profit falls as probe begins and penalty imposed');
  assert.ok(score < 0);
});

test('severity detects critical events', () => {
  assert.equal(classifySeverity('Promoter arrested in fraud case'), 'CRITICAL');
  assert.equal(classifySeverity('Firm wins large order'), 'LOW');
});

test('toNewsItem produces a bounded, typed record', () => {
  const item = toNewsItem({
    source: 'example.com',
    title: 'HDFC Bank reports strong results',
    summary: 'Profit up on strong demand',
    url: 'https://example.com/hdfc',
    publishedAt: '2026-10-14T10:00:00.000Z',
  });
  assert.equal(item.source, 'example.com');
  assert.ok(item.entities.includes('HDFCBANK'));
  assert.ok(item.relevance >= 0 && item.relevance <= 1);
  assert.match(item.dedupeHash, /^[0-9a-f]{64}$/);
  assert.equal(item.publishedAt, '2026-10-14T10:00:00.000Z');
});

test('toNewsItem falls back to now for an invalid date', () => {
  const item = toNewsItem({ source: 's', title: 't', url: 'u', publishedAt: 'not-a-date' });
  assert.ok(!Number.isNaN(Date.parse(item.publishedAt)));
});
