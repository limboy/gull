// `Math.sumPrecise` is a TC39 proposal that pdf.js 6 uses while building font
// tables and laying out text. Chromium has not shipped it yet (146 at the time
// of writing), and pdf.js swallows the resulting TypeError as "cannot
// substitute the font", which renders those PDFs with the wrong metrics.
//
// Importing this module installs a stand-in when the engine has none. It uses
// Neumaier compensated summation rather than the proposal's exact algorithm —
// pdf.js sums small lists of table sizes and column widths, where compensated
// summation is already exact.

export function sumPrecise(values) {
  const list = [];
  for (const value of values) {
    if (typeof value !== 'number') {
      throw new TypeError('Math.sumPrecise: every value must be a number');
    }
    list.push(value);
  }
  if (list.length === 0) return -0;
  // Infinities and NaN have no meaningful compensation term.
  if (!list.every(Number.isFinite)) return list.reduce((total, value) => total + value, 0);

  let sum = 0;
  let compensation = 0;
  for (const value of list) {
    const next = sum + value;
    compensation += Math.abs(sum) >= Math.abs(value)
      ? (sum - next) + value
      : (value - next) + sum;
    sum = next;
  }
  return sum + compensation;
}

if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = sumPrecise;
}
