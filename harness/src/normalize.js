'use strict';

// Normalization + rule-based scoring. Pure functions only (no network, no DB, no LLM),
// which is what makes them unit-testable and replayable.

const crypto = require('node:crypto');
const { SENTIMENT_TERMS, SEVERITY_CLASSES, ENTITY_ALIASES, MACRO_ENTITIES } = require('./lexicon');

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function stripHtml(input) {
  return String(input || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.delete('utm_source');
    u.searchParams.delete('utm_medium');
    u.searchParams.delete('utm_campaign');
    u.searchParams.delete('utm_content');
    u.searchParams.delete('utm_term');
    u.searchParams.delete('ncid');
    u.searchParams.delete('ref');
    let path = u.pathname.replace(/\/+$/, '');
    u.pathname = path;
    return u.toString().toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

function dedupeHash({ url, source, title }) {
  const basis = canonicalUrl(url) || `${(source || '').toLowerCase()}|${stripHtml(title).toLowerCase()}`;
  return crypto.createHash('sha256').update(basis).digest('hex');
}

function resolveEntities(text) {
  const haystack = ` ${String(text || '').toLowerCase()} `;
  const found = new Set();
  for (const [symbol, aliases] of Object.entries(ENTITY_ALIASES)) {
    for (const alias of aliases) {
      const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
      if (pattern.test(haystack)) {
        found.add(symbol);
        break;
      }
    }
  }
  for (const macro of MACRO_ENTITIES) {
    if (haystack.includes(` ${macro} `)) found.add(macro.toUpperCase());
  }
  return [...found];
}

function scoreSentiment(text) {
  const haystack = String(text || '');
  let raw = 0;
  const hits = [];
  for (const [pattern, weight] of SENTIMENT_TERMS) {
    const match = haystack.match(pattern);
    if (match) {
      raw += weight;
      hits.push(match[0]);
    }
  }
  // squash to [-1, 1] so a single loud headline cannot dominate an ensemble
  const score = +(raw / (1 + Math.abs(raw))).toFixed(3);
  return { score, hits };
}

function classifySeverity(text) {
  const haystack = String(text || '');
  for (const [level, patterns] of SEVERITY_CLASSES) {
    if (patterns.some((p) => p.test(haystack))) return level;
  }
  return 'LOW';
}

function scoreRelevance({ entities, severity, publishedAt, now = Date.now() }) {
  const entityWeight = clamp(entities.length * 0.18, 0, 0.5);
  const severityWeight = { LOW: 0.1, MEDIUM: 0.25, HIGH: 0.4, CRITICAL: 0.5 }[severity] ?? 0.1;
  const ts = Date.parse(publishedAt || '');
  const ageMinutes = Number.isFinite(ts) ? Math.max(0, (now - ts) / 60000) : 720;
  const recencyWeight = clamp(1 - ageMinutes / 720, 0, 1) * 0.4; // decays over 12h
  const score = clamp(entityWeight + severityWeight + recencyWeight, 0, 1);
  return +score.toFixed(3);
}

// Turns a raw feed entry into the canonical news object used across the pipeline.
function toNewsItem(raw, options = {}) {
  const { now = Date.now() } = options;
  const source = raw.source || 'unknown';
  const title = stripHtml(raw.title);
  const summary = stripHtml(raw.summary).slice(0, 800);
  const text = `${title} ${summary}`;
  const entities = resolveEntities(text);
  const sentiment = scoreSentiment(text);
  const severity = classifySeverity(text);
  const publishedAt = raw.publishedAt && Number.isFinite(Date.parse(raw.publishedAt))
    ? new Date(raw.publishedAt).toISOString()
    : new Date(now).toISOString();

  return {
    source,
    url: raw.url || null,
    title,
    summary,
    publishedAt,
    entities,
    sentiment: sentiment.score,
    sentimentHits: sentiment.hits,
    severity,
    relevance: scoreRelevance({ entities, severity, publishedAt, now }),
    dedupeHash: dedupeHash({ url: raw.url, source, title }),
  };
}

module.exports = {
  stripHtml,
  canonicalUrl,
  dedupeHash,
  resolveEntities,
  scoreSentiment,
  classifySeverity,
  scoreRelevance,
  toNewsItem,
};
