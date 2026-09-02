// Entry point for the pdf.js worker.
//
// The polyfill has to be installed before pdf.js loads: the worker is where
// font tables are built, and that code calls `Math.sumPrecise` (see
// `lib/math-sum-precise.mjs`). Vite inlines this whole module as a blob worker,
// which is the only kind the production renderer can create from `file://`.
import './lib/math-sum-precise.mjs';
import 'pdfjs-dist/build/pdf.worker.min.mjs';
