const test = require('node:test');
const assert = require('node:assert');

let sumPrecise;

test.before(async () => {
  ({ sumPrecise } = await import('../src/lib/math-sum-precise.mjs'));
});

test('sums exactly where naive addition drifts', () => {
  // 0.1 + 0.2 + 0.3 is 0.6000000000000001 left to right.
  assert.strictEqual(sumPrecise([0.1, 0.2, 0.3]), 0.6);
  assert.strictEqual(sumPrecise([1e20, 1, -1e20]), 1);
});

test('sums the integer lists pdf.js builds font tables from', () => {
  assert.strictEqual(sumPrecise([12, 44, 8, 132]), 196);
  assert.strictEqual(sumPrecise([]), -0);
});

test('propagates non-finite values instead of compensating them', () => {
  assert.strictEqual(sumPrecise([1, Infinity]), Infinity);
  assert.strictEqual(sumPrecise([Infinity, -Infinity]), NaN);
  assert.strictEqual(sumPrecise([1, NaN]), NaN);
});

test('rejects values that are not numbers', () => {
  assert.throws(() => sumPrecise([1, '2']), TypeError);
});

test('installs itself on Math when the engine has no implementation', () => {
  assert.strictEqual(typeof Math.sumPrecise, 'function');
  assert.strictEqual(Math.sumPrecise([1, 2, 3]), 6);
});
