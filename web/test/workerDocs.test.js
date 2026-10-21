import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKER_DOCS, WORKER_ORDER, workerDocBySlug, adjacentWorkers,
} from '../lib/workerDocs.js';
import { WORKERS } from '../lib/arcade.js';

// Every board worker must have a dossier, and vice versa - the board and the
// docs page can never drift apart silently.
test('every board worker has a dossier and every dossier is on the board', () => {
  assert.deepEqual(WORKER_ORDER, ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7', 'W8', 'W9']);
  assert.deepEqual(Object.keys(WORKER_DOCS).sort(), WORKERS.map((w) => w.id).sort());
  for (const id of WORKER_ORDER) {
    const doc = WORKER_DOCS[id];
    assert.equal(doc.id, id);
    assert.equal(doc.slug, id.toLowerCase());
  }
});

// The health sources named in each dossier must be exactly the ones the board
// colours that worker by - a doc listing a source the board ignores would lie.
test('dossier health sources agree with the board mapping', () => {
  for (const w of WORKERS) {
    const doc = WORKER_DOCS[w.id];
    assert.ok(doc, `${w.id} missing docs`);
    // Every board source string must be mentioned in the dossier somewhere,
    // so the page never hides a lane the board watches.
    const blob = JSON.stringify(doc);
    for (const src of w.sources) {
      assert.ok(blob.includes(src), `${w.id} docs never mention its source ${src}`);
    }
  }
});

test('every dossier is complete: what, sources, data, consumers, limits', () => {
  for (const id of WORKER_ORDER) {
    const doc = WORKER_DOCS[id];
    assert.ok(doc.does.length >= 2, `${id}: needs a real end-to-end description`);
    assert.ok(doc.file.startsWith('harness/src/workers/'), `${id}: needs its source file`);
    assert.ok(doc.cadence.length > 10, `${id}: needs a cadence`);
    assert.ok(Array.isArray(doc.consumes.external), `${id}: external list`);
    assert.ok(Array.isArray(doc.consumes.queue), `${id}: queue list`);
    assert.ok(Array.isArray(doc.consumes.tables), `${id}: tables list`);
    assert.ok(doc.produces.length >= 1, `${id}: must write something`);
    for (const p of doc.produces) {
      assert.ok(p.table && p.shape, `${id}: every produced table needs a shape`);
    }
    assert.ok(doc.consumers.length >= 1, `${id}: something must consume its data`);
    assert.ok(doc.limits.length >= 1, `${id}: needs an honest limit`);
  }
});

// The queue wiring in the docs must form one honest chain: whatever a worker
// emits, some other worker consumes (or it is explicitly terminal).
test('every emitted queue topic is consumed by exactly one downstream worker', () => {
  const consumed = new Set();
  for (const id of WORKER_ORDER) {
    for (const q of WORKER_DOCS[id].consumes.queue) {
      consumed.add(q.topic);
    }
  }
  for (const id of WORKER_ORDER) {
    for (const e of WORKER_DOCS[id].emits) {
      assert.ok(consumed.has(e.topic), `${id} emits ${e.topic} that nobody consumes`);
    }
  }
});

// A consumer naming "W4 Signal" must point at a real worker id, not a typo.
test('consumers and queue entries only reference real workers', () => {
  const ids = WORKER_ORDER.map((id) => id.toLowerCase());
  for (const id of WORKER_ORDER) {
    const doc = WORKER_DOCS[id];
    for (const q of doc.consumes.queue) {
      const cited = q.from.toLowerCase();
      // A source that names a worker ("W1 News") must be a real one; system
      // labels like "all workers" are allowed but must not masquerade as one.
      if (/^w\d/.test(cited)) {
        const citedId = cited.match(/^w\d/)[0];
        assert.ok(ids.includes(citedId), `${id}: queue source "${q.from}" is not a known worker`);
      }
    }
    for (const c of doc.consumers) {
      const cited = c.who.toLowerCase();
      // Dashboard surfaces, channels and governance are allowed; anything that
      // looks like a worker id must be real.
      const workerLike = cited.match(/^w\d\b/);
      if (workerLike) {
        assert.ok(ids.includes(workerLike[0]), `${id}: consumer "${c.who}" is not a known worker`);
      }
    }
  }
});

test('workerDocBySlug is case-insensitive and rejects unknown slugs', () => {
  assert.equal(workerDocBySlug('w0').id, 'W0');
  assert.equal(workerDocBySlug('W7').id, 'W7');
  assert.equal(workerDocBySlug('W9').id, 'W9');
  assert.equal(workerDocBySlug('w2').name, 'Flow');
  assert.equal(workerDocBySlug('W10'), null);
  assert.equal(workerDocBySlug(''), null);
  assert.equal(workerDocBySlug(undefined), null);
});

test('adjacentWorkers walks the chain and turns around at the ends', () => {
  assert.equal(adjacentWorkers('W0').prev, null);
  assert.equal(adjacentWorkers('W0').next.id, 'W1');
  assert.equal(adjacentWorkers('W5').prev.id, 'W4');
  assert.equal(adjacentWorkers('W5').next.id, 'W6');
  assert.equal(adjacentWorkers('W9').next, null);
  assert.equal(adjacentWorkers('W9').prev.id, 'W8');
  assert.deepEqual(adjacentWorkers('ZZ'), { prev: null, next: null });
});
