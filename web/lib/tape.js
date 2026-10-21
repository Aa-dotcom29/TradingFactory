// Pure helpers for the live tape panels. The database returns strings for numeric
// columns, and the browser must not decide a footprint from a string comparison.
// Nothing here touches the network or the clock: the caller passes the rows and the
// reference time.

function num(value) {
  if (value === null || value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function round(value, places = 6) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

// A bucket wide enough to keep a footprint readable without merging distinct
// trades. Index levels move in points; a stock at 100 needs a much finer bucket.
export function priceBucketFor(price) {
  const value = Math.abs(num(price));
  if (!Number.isFinite(value) || value <= 0) return 0.05;
  if (value >= 20000) return 10;
  if (value >= 5000) return 5;
  if (value >= 1000) return 1;
  if (value >= 100) return 0.5;
  if (value >= 10) return 0.05;
  return 0.01;
}

function barStartMs(value, barMs) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / barMs) * barMs;
}

function levelKey(price, bucket) {
  return round(Math.round(price / bucket) * bucket, 6);
}

function addLevel(levelMap, price, side, volume) {
  const key = String(price);
  const level = levelMap.get(key) || { price, buy: 0, sell: 0, unknown: 0, total: 0, delta: 0, prints: 0 };
  if (side === 'BUY') level.buy += volume;
  else if (side === 'SELL') level.sell += volume;
  else level.unknown += volume;
  level.total += volume;
  level.delta = level.buy - level.sell;
  level.prints += 1;
  levelMap.set(key, level);
}

// Turn raw tape rows into minute bars and a price-level matrix. `volume_delta` is
// the cumulative-volume difference between two broker packets; `last_qty` is the
// fallback when the cumulative series is missing. A print with no volume is not a
// print and is skipped rather than counted as a zero.
export function aggregateFootprint(ticks = [], options = {}) {
  const rows = Array.isArray(ticks) ? ticks : [];
  const barMs = Math.max(1000, Number(options.barMs) || 60000);
  const maxBars = Math.max(1, Number(options.maxBars) || 12);
  const maxLevels = Math.max(3, Number(options.maxLevels) || 14);
  const latest = rows.length ? num(rows[rows.length - 1].ltp) : NaN;
  const bucket = Math.max(0.0001, Number(options.bucket) || priceBucketFor(latest));

  const barMap = new Map();
  const allLevels = new Map();
  let buy = 0;
  let sell = 0;
  let unknown = 0;
  let prints = 0;

  for (const row of rows) {
    const price = num(row.ltp);
    const volume = Math.max(0, num(row.volume_delta) || num(row.last_qty) || 0);
    const start = barStartMs(row.captured_at || row.exchange_at, barMs);
    if (!Number.isFinite(price) || price <= 0 || !volume || start === null) continue;

    const side = row.side === 'BUY' || row.side === 'SELL' ? row.side : 'UNKNOWN';
    const key = levelKey(price, bucket);
    let bar = barMap.get(start);
    if (!bar) {
      bar = { start, levels: new Map(), buy: 0, sell: 0, unknown: 0, volume: 0, prints: 0 };
      barMap.set(start, bar);
    }
    addLevel(bar.levels, key, side, volume);
    addLevel(allLevels, key, side, volume);
    if (side === 'BUY') buy += volume;
    else if (side === 'SELL') sell += volume;
    else unknown += volume;
    bar.volume += volume;
    bar.prints += 1;
    if (side === 'BUY') bar.buy += volume;
    else if (side === 'SELL') bar.sell += volume;
    else bar.unknown += volume;
    bar.delta = bar.buy - bar.sell;
    prints += 1;
  }

  const bars = [...barMap.values()]
    .sort((a, b) => a.start - b.start)
    .slice(-maxBars)
    .map((bar) => ({
      at: new Date(bar.start).toISOString(),
      buy: bar.buy,
      sell: bar.sell,
      unknown: bar.unknown,
      volume: bar.volume,
      delta: bar.delta,
      prints: bar.prints,
      levels: Object.fromEntries([...bar.levels.entries()].map(([key, value]) => [key, value])),
    }));

  const selected = [...allLevels.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, maxLevels)
    .sort((a, b) => b.price - a.price);

  const matrix = selected.map((level) => ({
    price: level.price,
    buy: level.buy,
    sell: level.sell,
    unknown: level.unknown,
    total: level.total,
    delta: level.delta,
    cells: bars.map((bar) => bar.levels[String(level.price)] || null),
  }));

  const totalVolume = buy + sell + unknown;
  return {
    bucket,
    bars,
    rows: matrix,
    totals: {
      buy,
      sell,
      unknown,
      volume: totalVolume,
      delta: buy - sell,
      prints,
      buyShare: buy + sell ? buy / (buy + sell) : null,
    },
    largePrints: largePrints(rows, 6),
  };
}

export function largePrints(ticks = [], limit = 6) {
  return (Array.isArray(ticks) ? ticks : [])
    .map((row) => ({
      at: row.captured_at || row.exchange_at || null,
      price: num(row.ltp),
      volume: Math.max(0, num(row.volume_delta) || num(row.last_qty) || 0),
      side: row.side === 'BUY' || row.side === 'SELL' ? row.side : 'UNKNOWN',
      confidence: row.side_confidence || 'NONE',
    }))
    .filter((row) => Number.isFinite(row.price) && row.volume > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, Math.max(1, limit));
}

// Normalise a stored book snapshot. The database may return JSONB as an array or a
// string depending on the driver, so parse defensively rather than render "[object]".
function asLevels(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function normaliseDepth(depth) {
  if (!depth) return null;
  const bids = asLevels(depth.bids)
    .map((row) => ({ price: num(row.price), quantity: num(row.quantity), orders: num(row.orders) }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.quantity))
    .sort((a, b) => b.price - a.price);
  const asks = asLevels(depth.asks)
    .map((row) => ({ price: num(row.price), quantity: num(row.quantity), orders: num(row.orders) }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.quantity))
    .sort((a, b) => a.price - b.price);
  const bidQty = bids.reduce((sum, row) => sum + row.quantity, 0);
  const askQty = asks.reduce((sum, row) => sum + row.quantity, 0);
  const total = bidQty + askQty;
  const bestBid = bids.length ? bids[0].price : null;
  const bestAsk = asks.length ? asks[0].price : null;
  return {
    capturedAt: depth.captured_at || null,
    exchangeAt: depth.exchange_at || null,
    levels: Number(depth.levels) || Math.max(bids.length, asks.length),
    bids,
    asks,
    bestBid,
    bestAsk,
    bidQty,
    askQty,
    imbalance: total ? (bidQty - askQty) / total : null,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
  };
}

export function depthImbalanceSeries(history = []) {
  return (Array.isArray(history) ? history : [])
    .map((row) => num(row.imbalance))
    .filter(Number.isFinite);
}

// A short, factual lean. It is not a trade instruction and the component says so.
export function tapeRead({ delta = 0, imbalance = null } = {}) {
  const d = num(delta) || 0;
  const i = num(imbalance);
  if (Number.isFinite(i) && i > 0.15 && d > 0) return 'BUYERS IN CONTROL';
  if (Number.isFinite(i) && i < -0.15 && d < 0) return 'SELLERS IN CONTROL';
  if (d > 0) return 'BUYERS ACTIVE';
  if (d < 0) return 'SELLERS ACTIVE';
  return 'BALANCED';
}
