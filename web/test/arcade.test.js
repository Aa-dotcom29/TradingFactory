import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArcadeWorkers, WORKERS, statusTone, arcadeTotals, BOARD, BOARD_W, BOARD_H, NODE_W, NODE_H } from '../lib/arcade.js';

const row = (source, status, detail = '', checked_at = '2026-10-21T12:00:00.000Z') => (
  { source, status, detail, checked_at }
);

test('every worker keeps its own sources and stays in run order', () => {
  assert.equal(WORKERS.length, 10);
  assert.deepEqual(WORKERS.map((w) => w.id), ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9']);
  // W0 owns every ingest source; no other worker repeats one.
  const flat = WORKERS.flatMap((w) => w.sources);
  assert.equal(new Set(flat).size, flat.length);
  assert.ok(WORKERS[0].sources.includes('rss'));
  assert.ok(WORKERS[0].sources.includes('angel-options'));
  assert.deepEqual(WORKERS[8].sources, ['harness-supervisor']);
  assert.deepEqual(WORKERS[9].sources, ['angel-tape']);
});

test('buildArcadeWorkers returns every node even with no health rows', () => {
  const workers = buildArcadeWorkers([]);
  assert.equal(workers.length, WORKERS.length);
  for (const w of workers) {
    assert.equal(w.status, 'UNREPORTED');
    assert.equal(w.tone, 'muted');
    assert.equal(w.checkedAt, null);
    assert.match(w.detail, /not run/);
  }
});

test('a worker shows the worst status of its own sources, not a neighbours', () => {
  const workers = buildArcadeWorkers([
    row('rss', 'HEALTHY'),
    row('yahoo-quotes', 'WARNING', 'slow'),
    row('nse-oi-spurts', 'HEALTHY'),
    // W1 news-scoring deliberately healthy, isolating it from W0 warning.
    row('news-scoring', 'HEALTHY'),
  ]);

  const w0 = workers.find((w) => w.id === 'W0');
  const w1 = workers.find((w) => w.id === 'W1');
  assert.equal(w0.status, 'WARNING');
  assert.equal(w0.tone, 'warn');
  assert.equal(w0.detail, 'slow');
  assert.equal(w1.status, 'HEALTHY');
  assert.equal(w1.tone, 'up');
});

test('error outranks warning, and disabled or idle stay quiet not failing', () => {
  const workers = buildArcadeWorkers([
    row('bias-meter', 'IDLE'),
  ]);
  const w3 = workers.find((w) => w.id === 'W3');
  assert.equal(w3.status, 'IDLE');
  assert.equal(w3.tone, 'muted');

  const w7 = buildArcadeWorkers([
    row('evaluator', 'HEALTHY'),
    row('evaluator', 'ERROR', 'bad row'),
  ]).find((w) => w.id === 'W7');
  assert.equal(w7.status, 'ERROR');
  assert.equal(w7.tone, 'down');
});

test('checkedAt is the newest row the worker owns', () => {
  const workers = buildArcadeWorkers([
    row('rss', 'HEALTHY', '', '2026-10-21T12:00:00.000Z'),
    row('yahoo-quotes', 'HEALTHY', '', '2026-10-21T12:05:00.000Z'),
  ]);
  const w0 = workers.find((w) => w.id === 'W0');
  assert.equal(w0.checkedAt, '2026-10-21T12:05:00.000Z');
});

test('statusTone covers every status we emit and unknowns stay muted', () => {
  for (const status of ['HEALTHY', 'OK', 'LIVE', 'WARNING', 'STALE', 'DEGRADED', 'IDLE', 'DISABLED', 'ERROR', 'DOWN', 'FAILED']) {
    assert.notEqual(statusTone(status), undefined);
  }
  assert.equal(statusTone('WHATEVER'), 'muted');
});

test('arcadeTotals counts every worker exactly once', () => {
  const workers = buildArcadeWorkers([]);
  const totals = arcadeTotals(workers);
  assert.equal(totals.up + totals.warn + totals.down + totals.muted, WORKERS.length);
  assert.equal(totals.muted, WORKERS.length);
});

test('board geometry places every worker inside the canvas without overlap', () => {
  for (const w of WORKERS) {
    assert.ok(BOARD[w.id], `${w.id} has a board position`);
  }
  assert.equal(Object.keys(BOARD).length, WORKERS.length);

  const boxes = WORKERS.map((w) => {
    const { x, y } = BOARD[w.id];
    assert.ok(x >= 0 && y >= 0, `${w.id} origin is on-canvas`);
    assert.ok(x + NODE_W <= BOARD_W, `${w.id} fits horizontally`);
    assert.ok(y + NODE_H <= BOARD_H, `${w.id} fits vertically`);
    return { id: w.id, x1: x, y1: y, x2: x + NODE_W, y2: y + NODE_H };
  });

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const separate = a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1;
      assert.ok(separate, `${a.id} and ${b.id} must not overlap`);
    }
  }
});
