import test from 'node:test';
import assert from 'node:assert/strict';
import { themeForHour, THEME_KEY, THEME_SCRIPT } from '../lib/theme.js';

test('themeForHour returns dim between 18:00 and 06:00 IST', () => {
  assert.equal(themeForHour(18), 'dim');
  assert.equal(themeForHour(19), 'dim');
  assert.equal(themeForHour(23), 'dim');
  assert.equal(themeForHour(0), 'dim');
  assert.equal(themeForHour(5), 'dim');
});

test('themeForHour returns day between 06:00 and 18:00 IST', () => {
  assert.equal(themeForHour(6), 'day');
  assert.equal(themeForHour(12), 'day');
  assert.equal(themeForHour(17), 'day');
});

test('themeForHour handles invalid input', () => {
  assert.equal(themeForHour(NaN), 'day');
  assert.equal(themeForHour(null), 'day');
  assert.equal(themeForHour('x'), 'day');
  assert.equal(themeForHour(undefined), 'day');
});

test('THEME_SCRIPT references the correct localStorage key and time zone', () => {
  assert.ok(THEME_SCRIPT.includes(THEME_KEY));
  assert.ok(THEME_SCRIPT.includes('Asia/Kolkata'));
  assert.ok(THEME_SCRIPT.includes('data-theme'));
});

test('THEME_KEY is the expected string', () => {
  assert.equal(THEME_KEY, 'tf-theme');
});