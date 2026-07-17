'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('normalizes and resolves persisted theme modes', async () => {
  const { normalizeThemeMode, resolveThemeMode } = await import('../src/lib/theme.mjs');
  assert.equal(normalizeThemeMode('system'), 'system');
  assert.equal(normalizeThemeMode('sepia'), 'system');
  assert.equal(resolveThemeMode('system', true), 'dark');
  assert.equal(resolveThemeMode('system', false), 'light');
  assert.equal(resolveThemeMode('light', true), 'light');
});
