'use strict';

// Synthetic SmartAPI v2 packets. The offsets are the broker's documented ones, so a
// decoder regression fails here rather than silently producing a wrong price ladder.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MODE, PACKET_SIZE, parseAngelPacket, parseAngelPackets,
  classifySide, volumeDelta, depthSummary,
} = require('../src/sources/angel-tape');

function writeToken(buffer, token) {
  buffer.write(token, 2, 25, 'ascii');
}

function writeBestFive(buffer, bids, asks) {
  const rows = [...bids, ...asks];
  for (let i = 0; i < 10; i += 1) {
    const start = 147 + i * 20;
    const row = rows[i] || { price: 0, quantity: 0, orders: 0 };
    buffer.writeInt16LE(i < 5 ? 1 : 0, start);
    buffer.writeBigInt64LE(BigInt(Math.round(row.quantity || 0)), start + 2);
    buffer.writeBigInt64LE(BigInt(Math.round((row.price || 0) * 100)), start + 10);
    buffer.writeInt16LE(Number(row.orders || 0), start + 18);
  }
}

function snapQuote({ token = '3045', ltp = 100.5, volume = 1000, lastQty = 25, oi = 123456 } = {}) {
  const buffer = Buffer.alloc(PACKET_SIZE[MODE.SNAP_QUOTE]);
  buffer.writeUInt8(MODE.SNAP_QUOTE, 0);
  buffer.writeUInt8(1, 1);
  writeToken(buffer, token);
  buffer.writeBigInt64LE(7n, 27);
  buffer.writeBigInt64LE(1700000000000n, 35);
  buffer.writeBigInt64LE(BigInt(Math.round(ltp * 100)), 43);
  buffer.writeBigInt64LE(BigInt(lastQty), 51);
  buffer.writeBigInt64LE(10000n, 59);
  buffer.writeBigInt64LE(BigInt(volume), 67);
  buffer.writeDoubleLE(5000, 75);
  buffer.writeDoubleLE(4000, 83);
  buffer.writeBigInt64LE(9900n, 91);
  buffer.writeBigInt64LE(10100n, 99);
  buffer.writeBigInt64LE(9800n, 107);
  buffer.writeBigInt64LE(9950n, 115);
  buffer.writeBigInt64LE(1700000000000n, 123);
  buffer.writeBigInt64LE(BigInt(oi), 131);
  buffer.writeDoubleLE(0, 139);
  writeBestFive(
    buffer,
    [
      { price: 100.45, quantity: 300, orders: 2 },
      { price: 100.4, quantity: 500, orders: 3 },
      { price: 100.35, quantity: 700, orders: 4 },
      { price: 100.3, quantity: 900, orders: 5 },
      { price: 100.25, quantity: 1100, orders: 6 },
    ],
    [
      { price: 100.55, quantity: 200, orders: 1 },
      { price: 100.6, quantity: 400, orders: 2 },
      { price: 100.65, quantity: 600, orders: 3 },
      { price: 100.7, quantity: 800, orders: 4 },
      { price: 100.75, quantity: 1000, orders: 5 },
    ],
  );
  return buffer;
}

function depth20({ token = '3045' } = {}) {
  const buffer = Buffer.alloc(PACKET_SIZE[MODE.DEPTH]);
  buffer.writeUInt8(MODE.DEPTH, 0);
  buffer.writeUInt8(1, 1);
  writeToken(buffer, token);
  buffer.writeBigInt64LE(1700000000000n, 35);
  for (let i = 0; i < 20; i += 1) {
    const buyStart = 43 + i * 10;
    const sellStart = 43 + 200 + i * 10;
    buffer.writeInt32LE((i + 1) * 100, buyStart);
    buffer.writeInt32LE(Math.round((100 - (i + 1) * 0.05) * 100), buyStart + 4);
    buffer.writeInt16LE(i + 1, buyStart + 8);
    buffer.writeInt32LE((i + 1) * 100, sellStart);
    buffer.writeInt32LE(Math.round((100 + (i + 1) * 0.05) * 100), sellStart + 4);
    buffer.writeInt16LE(i + 1, sellStart + 8);
  }
  return buffer;
}

test('Snap Quote decodes price, size, OI and five book levels', () => {
  const packet = parseAngelPacket(snapQuote());
  assert.equal(packet.mode, MODE.SNAP_QUOTE);
  assert.equal(packet.token, '3045');
  assert.equal(packet.ltp, 100.5);
  assert.equal(packet.lastQty, 25);
  assert.equal(packet.volume, 1000);
  assert.equal(packet.totalBuyQty, 5000);
  assert.equal(packet.totalSellQty, 4000);
  assert.equal(packet.openInterest, 123456);
  assert.equal(packet.exchangeAt, '2023-11-14T22:13:20.000Z');
  assert.equal(packet.bids.length, 5);
  assert.equal(packet.asks.length, 5);
  assert.equal(packet.bids[0].price, 100.45);
  assert.equal(packet.asks[0].price, 100.55);
  assert.equal(packet.bids[0].quantity, 300);
  assert.equal(packet.levels, 5);
});

test('Depth mode decodes twenty levels without inventing an LTP', () => {
  const packet = parseAngelPacket(depth20());
  assert.equal(packet.mode, MODE.DEPTH);
  assert.equal(packet.ltp, null);
  assert.equal(packet.bids.length, 20);
  assert.equal(packet.asks.length, 20);
  assert.equal(packet.bids[0].price, 99.95);
  assert.equal(packet.asks[0].price, 100.05);
  assert.equal(packet.bids[19].price, 99);
  assert.equal(packet.asks[19].price, 101);
  assert.equal(packet.levels, 20);
});

test('parseAngelPackets splits concatenated frames', () => {
  const packets = parseAngelPackets(Buffer.concat([snapQuote(), depth20()]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].mode, MODE.SNAP_QUOTE);
  assert.equal(packets[1].mode, MODE.DEPTH);
});

test('classifySide uses the visible quote before guessing from the previous print', () => {
  assert.deepEqual(classifySide({ ltp: 100.55, bestBid: 100.45, bestAsk: 100.55 }), { side: 'BUY', confidence: 'HIGH' });
  assert.deepEqual(classifySide({ ltp: 100.45, bestBid: 100.45, bestAsk: 100.55 }), { side: 'SELL', confidence: 'HIGH' });
  assert.deepEqual(classifySide({ ltp: 100.52, bestBid: 100.45, bestAsk: 100.55 }), { side: 'BUY', confidence: 'MEDIUM' });
  assert.deepEqual(classifySide({ ltp: 100.48, bestBid: 100.45, bestAsk: 100.55 }), { side: 'SELL', confidence: 'MEDIUM' });
  assert.deepEqual(classifySide({ ltp: 101, previousLtp: 100 }), { side: 'BUY', confidence: 'LOW' });
  assert.deepEqual(classifySide({ ltp: 99, previousLtp: 100 }), { side: 'SELL', confidence: 'LOW' });
  assert.deepEqual(classifySide({}), { side: 'UNKNOWN', confidence: 'NONE' });
});

test('volumeDelta prefers the cumulative series and survives a reset', () => {
  assert.equal(volumeDelta(100, 150, 10), 50);
  assert.equal(volumeDelta(150, 100, 10), 10);
  assert.equal(volumeDelta(undefined, 100, 10), 10);
  assert.equal(volumeDelta(100, 100, 10), 0);
  assert.equal(volumeDelta(null, null, null), 0);
});

test('depthSummary aggregates size and imbalance across the ladder', () => {
  const summary = depthSummary(parseAngelPacket(snapQuote()));
  assert.equal(summary.bestBid, 100.45);
  assert.equal(summary.bestAsk, 100.55);
  assert.equal(summary.bidQty, 3500);
  assert.equal(summary.askQty, 3000);
  assert.equal(summary.imbalance, 500 / 6500);
  assert.equal(summary.levels, 5);
});
