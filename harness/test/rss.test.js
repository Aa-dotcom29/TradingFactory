'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFeed, decodeEntities } = require('../src/sources/rss');

const RSS = `<rss version="2.0"><channel>
  <item>
    <title>Sensex &amp; Nifty end higher</title>
    <link>https://example.com/a</link>
    <description><![CDATA[<p>Markets <b>rise</b> on FII buying</p>]]></description>
    <pubDate>Tue, 14 Oct 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Rupee steady</title>
    <link>https://example.com/b</link>
    <description>Flat session</description>
    <pubDate>Tue, 14 Oct 2026 11:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Banks lead rally</title>
    <link href="https://example.com/atom/1" />
    <summary>Financials gain</summary>
    <updated>2026-10-14T12:00:00Z</updated>
  </entry>
</feed>`;

test('parses RSS items', () => {
  const items = parseFeed(RSS, 'example.com');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Sensex & Nifty end higher');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.equal(items[0].source, 'example.com');
  assert.ok(items[0].summary.includes('Markets'));
  assert.ok(items[0].summary.includes('FII buying'));
  assert.ok(items[0].publishedAt.includes('Oct 2026'));
});

test('parses Atom entries', () => {
  const items = parseFeed(ATOM, 'example.com');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Banks lead rally');
  assert.equal(items[0].url, 'https://example.com/atom/1');
  assert.equal(items[0].publishedAt, '2026-10-14T12:00:00Z');
});

test('decodeEntities handles named and numeric entities', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &#8377;'), 'a & b <c> \u20b9');
});

test('returns empty array for malformed input', () => {
  assert.deepEqual(parseFeed('not xml at all', 'x'), []);
});
