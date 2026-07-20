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

export function isOverlappingHighlight(h1, h2) {
  if (!h1 || !h2) return false;
  if (h1.chapterId !== h2.chapterId) return false;
  const s1 = Number(h1.start);
  const e1 = Number(h1.end);
  const s2 = Number(h2.start);
  const e2 = Number(h2.end);
  return Number.isInteger(s1) && Number.isInteger(e1) &&
         Number.isInteger(s2) && Number.isInteger(e2) &&
         s1 <= e2 && e1 >= s2;
}

export function mergeOverlappingHighlights(highlights, textContentGetter = null) {
  if (!Array.isArray(highlights) || highlights.length === 0) return [];

  const byChapter = {};
  for (const h of highlights) {
    if (!byChapter[h.chapterId]) byChapter[h.chapterId] = [];
    byChapter[h.chapterId].push(h);
  }

  const result = [];

  for (const chapterId of Object.keys(byChapter)) {
    const chapterHighlights = byChapter[chapterId];
    chapterHighlights.sort((a, b) => Number(a.start) - Number(b.start));

    let current = null;
    for (const h of chapterHighlights) {
      if (!current) {
        current = { ...h };
      } else if (isOverlappingHighlight(current, h)) {
        current.end = Math.max(Number(current.end), Number(h.end));
        current.createdAt = Math.max(current.createdAt || 0, h.createdAt || 0);
        if (textContentGetter) {
          const textContent = textContentGetter(chapterId);
          if (textContent) {
            current.text = textContent.slice(current.start, current.end);
          }
        }
      } else {
        result.push(current);
        current = { ...h };
      }
    }
    if (current) result.push(current);
  }

  return result;
}


