export function resolveHighlightOffsets(content, highlight) {
  const textContent = String(content || '');
  const start = Number(highlight.start);
  const end = Number(highlight.end);
  if (Number.isInteger(start) && Number.isInteger(end)
    && start >= 0 && end >= start
    && textContent.slice(start, end) === highlight.text) {
    return { start, end };
  }
  if (!highlight.text) return null;

  let bestStart = -1;
  let bestScore = -Infinity;
  let fromIndex = 0;
  while (fromIndex <= textContent.length) {
    const candidate = textContent.indexOf(highlight.text, fromIndex);
    if (candidate === -1) break;
    const candidateEnd = candidate + highlight.text.length;
    let score = 0;
    if (highlight.prefix && textContent.slice(
      Math.max(0, candidate - highlight.prefix.length),
      candidate
    ) === highlight.prefix) score += 2;
    if (highlight.suffix && textContent.slice(
      candidateEnd,
      candidateEnd + highlight.suffix.length
    ) === highlight.suffix) score += 2;
    if (Number.isInteger(start)) {
      score -= Math.abs(candidate - start) / Math.max(textContent.length, 1);
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = candidate;
    }
    fromIndex = candidate + Math.max(highlight.text.length, 1);
  }

  return bestStart === -1
    ? null
    : { start: bestStart, end: bestStart + highlight.text.length };
}
