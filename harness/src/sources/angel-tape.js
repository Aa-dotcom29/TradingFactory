'use strict';

// Angel One SmartAPI WebSocket v2 packet decoder.
//
// The broker's stream is binary and little-endian. The field offsets below are the ones
// documented for LTP (51 bytes), Quote (123), Snap Quote (379) and 20-Depth (443). The
// decoder is deliberately pure: it takes a Buffer and returns a plain object, so the
// offsets can be tested against synthetic packets without a live broker session.
//
// The important limitation is recorded here rather than hidden in the UI: Snap Quote
// carries five book levels, and Depth mode carries twenty levels for NSE cash only. No
// retail feed exposes the exchange's full anonymous order book, and the packet has no
// exchange aggressor flag. `classifySide` therefore infers the taker side from the print
// price against the prevailing best bid/ask. That is an estimate, not an exchange fact.

const MODE = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3, DEPTH: 4 };
const EXCHANGE = { NSE_CM: 1, NSE_FO: 2, BSE_CM: 3, BSE_FO: 4, MCX_FO: 5 };
const PACKET_SIZE = { 1: 51, 2: 123, 3: 379, 4: 443 };

function tokenAt(buffer) {
  return buffer.subarray(2, 27).toString('ascii').replace(/\0/g, '').trim();
}

function epochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  // The feed uses milliseconds today. A seconds value is normalised rather than
  // silently becoming a 1970 timestamp.
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString();
}

function price(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}

function quantity(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function readBestFive(buffer) {
  const bids = [];
  const asks = [];
  for (let i = 0; i < 10; i += 1) {
    const start = 147 + i * 20;
    const flag = buffer.readInt16LE(start);
    const qty = quantity(buffer.readBigInt64LE(start + 2));
    const px = price(buffer.readBigInt64LE(start + 10));
    const orders = buffer.readInt16LE(start + 18);
    if (px === null || qty === null || qty === 0) continue;
    const level = { price: px, quantity: qty, orders: Number.isFinite(orders) ? orders : null };
    // The documented sequence is five bids followed by five asks. Position is more
    // reliable than the flag in practice, but the flag is retained for diagnosis.
    if (i < 5) bids.push({ ...level, flag });
    else asks.push({ ...level, flag });
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function readDepth20(buffer) {
  const bids = [];
  const asks = [];
  for (let i = 0; i < 20; i += 1) {
    const buyStart = 43 + i * 10;
    const sellStart = 43 + 200 + i * 10;
    const buy = {
      quantity: quantity(buffer.readInt32LE(buyStart)),
      price: price(buffer.readInt32LE(buyStart + 4)),
      orders: buffer.readInt16LE(buyStart + 8),
    };
    const sell = {
      quantity: quantity(buffer.readInt32LE(sellStart)),
      price: price(buffer.readInt32LE(sellStart + 4)),
      orders: buffer.readInt16LE(sellStart + 8),
    };
    if (buy.price !== null && buy.quantity) bids.push(buy);
    if (sell.price !== null && sell.quantity) asks.push(sell);
  }
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);
  return { bids, asks };
}

function parseAngelPacket(input) {
  if (!Buffer.isBuffer(input)) return null;
  const buffer = input;
  if (buffer.length < 43) return null;
  const mode = buffer.readUInt8(0);
  const exchangeType = buffer.readUInt8(1);
  if (!PACKET_SIZE[mode]) return null;

  const packet = {
    mode,
    exchangeType,
    token: tokenAt(buffer),
    sequence: null,
    exchangeAt: null,
    ltp: null,
    lastQty: null,
    avgPrice: null,
    volume: null,
    totalBuyQty: null,
    totalSellQty: null,
    open: null,
    high: null,
    low: null,
    close: null,
    lastTradeAt: null,
    openInterest: null,
    bids: [],
    asks: [],
    levels: 0,
  };

  if (mode === MODE.DEPTH) {
    // Depth mode replaces the sequence with the packet-received time and carries no LTP.
    packet.exchangeAt = epochMs(buffer.readBigInt64LE(35));
    const depth = readDepth20(buffer);
    packet.bids = depth.bids;
    packet.asks = depth.asks;
    packet.levels = Math.max(depth.bids.length, depth.asks.length);
    return packet;
  }

  packet.sequence = Number(buffer.readBigInt64LE(27));
  packet.exchangeAt = epochMs(buffer.readBigInt64LE(35));
  packet.ltp = price(buffer.readBigInt64LE(43));

  if (mode === MODE.LTP) return packet;

  packet.lastQty = quantity(buffer.readBigInt64LE(51));
  packet.avgPrice = price(buffer.readBigInt64LE(59));
  packet.volume = quantity(buffer.readBigInt64LE(67));
  packet.totalBuyQty = quantity(buffer.readDoubleLE(75));
  packet.totalSellQty = quantity(buffer.readDoubleLE(83));
  packet.open = price(buffer.readBigInt64LE(91));
  packet.high = price(buffer.readBigInt64LE(99));
  packet.low = price(buffer.readBigInt64LE(107));
  packet.close = price(buffer.readBigInt64LE(115));

  if (mode === MODE.QUOTE) return packet;

  packet.lastTradeAt = epochMs(buffer.readBigInt64LE(123));
  packet.openInterest = quantity(buffer.readBigInt64LE(131));
  const depth = readBestFive(buffer);
  packet.bids = depth.bids;
  packet.asks = depth.asks;
  packet.levels = Math.max(depth.bids.length, depth.asks.length);
  return packet;
}

// Split a WebSocket message into complete packets. Angel normally sends one packet per
// message, but the length check makes a concatenated frame harmless instead of a decode
// error.
function parseAngelPackets(input) {
  if (!Buffer.isBuffer(input)) return [];
  const packets = [];
  let offset = 0;
  while (offset + 43 <= input.length) {
    const mode = input.readUInt8(offset);
    const size = PACKET_SIZE[mode];
    if (!size || offset + size > input.length) break;
    const packet = parseAngelPacket(input.subarray(offset, offset + size));
    if (packet) packets.push(packet);
    offset += size;
  }
  return packets;
}

function bestPrices(packet) {
  const bestBid = packet && packet.bids && packet.bids.length ? packet.bids[0].price : null;
  const bestAsk = packet && packet.asks && packet.asks.length ? packet.asks[0].price : null;
  return { bestBid, bestAsk };
}

// Estimate the taker side of one print. High confidence means the print traded at or
// through the visible best quote. Medium means it was on one side of the mid. Low means
// only the previous print gives a direction. Unknown is left unknown on purpose.
function classifySide({ ltp, bestBid, bestAsk, previousLtp } = {}) {
  const priceValue = Number(ltp);
  if (!Number.isFinite(priceValue)) return { side: 'UNKNOWN', confidence: 'NONE' };
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (Number.isFinite(ask) && ask > 0 && priceValue >= ask) return { side: 'BUY', confidence: 'HIGH' };
  if (Number.isFinite(bid) && bid > 0 && priceValue <= bid) return { side: 'SELL', confidence: 'HIGH' };
  if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0) {
    const mid = (bid + ask) / 2;
    if (priceValue > mid) return { side: 'BUY', confidence: 'MEDIUM' };
    if (priceValue < mid) return { side: 'SELL', confidence: 'MEDIUM' };
  }
  const previous = Number(previousLtp);
  if (Number.isFinite(previous) && previous > 0) {
    if (priceValue > previous) return { side: 'BUY', confidence: 'LOW' };
    if (priceValue < previous) return { side: 'SELL', confidence: 'LOW' };
  }
  return { side: 'UNKNOWN', confidence: 'NONE' };
}

// The broker's cumulative day volume is the reliable measure of how much traded between
// two packets. `lastQty` is only the last print, so it is a fallback when the cumulative
// value is missing or moved backwards (a reconnect can reset it).
function volumeDelta(previousVolume, currentVolume, lastQty) {
  const current = Number(currentVolume);
  const previous = Number(previousVolume);
  if (Number.isFinite(current) && Number.isFinite(previous) && current >= previous) {
    return current - previous;
  }
  const last = Number(lastQty);
  return Number.isFinite(last) && last > 0 ? last : 0;
}

function depthSummary(packet) {
  const { bestBid, bestAsk } = bestPrices(packet);
  const bids = Array.isArray(packet && packet.bids) ? packet.bids : [];
  const asks = Array.isArray(packet && packet.asks) ? packet.asks : [];
  const bidQty = bids.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const askQty = asks.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0);
  const total = bidQty + askQty;
  return {
    bestBid,
    bestAsk,
    bidQty,
    askQty,
    imbalance: total ? (bidQty - askQty) / total : null,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    levels: Math.max(bids.length, asks.length),
  };
}

module.exports = {
  MODE,
  EXCHANGE,
  PACKET_SIZE,
  parseAngelPacket,
  parseAngelPackets,
  bestPrices,
  classifySide,
  volumeDelta,
  depthSummary,
};
