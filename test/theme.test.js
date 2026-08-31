'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('applies the current system theme', async () => {
  const { applySystemTheme } = await import('../src/lib/theme.mjs');
  const root = {
    setAttribute(name, value) {
      this[name] = value;
    },
  };

  assert.equal(applySystemTheme(root, true), 'dark');
  assert.equal(root['data-theme'], 'dark');
  assert.equal(applySystemTheme(root, false), 'light');
  assert.equal(root['data-theme'], 'light');
});
