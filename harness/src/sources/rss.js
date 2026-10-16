'use strict';

// Dependency-free RSS 2.0 / Atom reader. The repo intentionally avoids extra packages
// (the existing app runs on Node built-ins), so this is a small tolerant parser covering
// <item> (RSS) and <entry> (Atom). It is deliberately forgiving: a malformed field is
// skipped rather than aborting the whole feed.

const config = require('../config');
const log = require('../logger').child({ module: 'rss' });

function decodeEntities(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function pickTag(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]) : '';
}

function pickLink(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (href) return decodeEntities(href[1]);
  return pickTag(block, 'link');
}

function splitEntries(xml) {
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
  if (items && items.length) return items;
  const entries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi);
  return entries || [];
}

async function fetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(config.rss.timeoutMs),
    headers: {
      'user-agent': 'TradingFactoryHarness/0.1 (+personal research)',
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
  });
  if (!response.ok) throw new Error(`RSS ${url} responded HTTP ${response.status}`);
  return response.text();
}

function parseFeed(xml, source) {
  const blocks = splitEntries(xml);
  const items = [];
  for (const block of blocks.slice(0, config.rss.maxItemsPerFeed)) {
    const title = pickTag(block, 'title');
    if (!title) continue;
    items.push({
      source,
      title,
      url: pickLink(block) || null,
      summary: pickTag(block, 'description') || pickTag(block, 'summary') || pickTag(block, 'content'),
      publishedAt: pickTag(block, 'pubDate') || pickTag(block, 'published') || pickTag(block, 'updated') || null,
    });
  }
  return items;
}

function sourceNameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

async function fetchAll() {
  const results = [];
  for (const url of config.rss.feeds) {
    try {
      const xml = await fetchText(url);
      const items = parseFeed(xml, sourceNameFromUrl(url));
      results.push(...items);
    } catch (error) {
      log.warn('feed fetch failed', { url, error: error.message });
    }
  }
  return results;
}

module.exports = { fetchAll, parseFeed, decodeEntities, pickTag, pickLink, sourceNameFromUrl };
