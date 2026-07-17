'use strict';

const STRIP_CSS_PROPS = new Set([
  'font-family', 'color', 'background', 'background-color',
  'background-image', 'border-color',
  'font-size', 'line-height',
  'position', 'top', 'right', 'bottom', 'left',
  'inset', 'inset-block', 'inset-block-start', 'inset-block-end',
  'inset-inline', 'inset-inline-start', 'inset-inline-end',
  'transform', 'z-index', '-webkit-app-region',
  'behavior', '-moz-binding',
]);

const HTML_VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
  'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const BLOCKED_ELEMENTS = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed',
  'portal', 'webview', 'base', 'form', 'input', 'button', 'select',
  'textarea', 'option', 'audio', 'video', 'track', 'source',
  'foreignobject',
]);

const URL_ATTRIBUTES = new Set([
  'href', 'src', 'xlink:href', 'poster', 'action', 'formaction',
]);

const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i;

function hasUnsafeCssValue(value) {
  return /(?:url\s*\(|expression\s*\(|javascript\s*:|vbscript\s*:|@import\b)/i.test(value);
}

function filterInlineStyle(style, preserveMetrics = false) {
  return String(style || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map(s => s.trim())
    .filter(s => {
      const colonAt = s.indexOf(':');
      if (colonAt <= 0 || hasUnsafeCssValue(s)) return false;
      const prop = s.slice(0, colonAt).trim().toLowerCase();
      if (preserveMetrics && (prop === 'font-size' || prop === 'line-height')) {
        return true;
      }
      return !STRIP_CSS_PROPS.has(prop);
    })
    .join('; ');
}

function filterEpubCss(css) {
  const withoutActiveContent = String(css || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@(?:import|charset)\b[^;]*;/gi, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '');

  return withoutActiveContent.replace(/([^{]*)\{([^}]*)\}/g, (match, selector, block) => {
    if (hasUnsafeCssValue(selector) || hasUnsafeCssValue(block)) return '';
    const normalizedSelector = selector.trim();
    if (!normalizedSelector) return '';
    const isDropCap = /drop-?cap/i.test(normalizedSelector);
    const filtered = filterInlineStyle(block, isDropCap);
    return filtered ? `${selector}{ ${filtered}; }` : '';
  });
}

function normalizeXhtmlFragment(html) {
  return String(html || '').replace(
    /<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g,
    (match, tagName, attrs = '') => {
      if (HTML_VOID_TAGS.has(tagName.toLowerCase())) {
        return `<${tagName}${attrs}>`;
      }
      return `<${tagName}${attrs}></${tagName}>`;
    }
  );
}

function getScheme(value) {
  const compact = String(value || '').replace(/[\u0000-\u0020\u007f]+/g, '');
  const match = compact.match(/^([a-z][a-z0-9+.-]*):/i);
  return match ? match[1].toLowerCase() : null;
}

function isSafePublicationUrl(value, { tagName, attributeName }) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('//')) return false;

  const scheme = getScheme(trimmed);
  if (!scheme) return true;

  const tag = String(tagName || '').toLowerCase();
  const attribute = String(attributeName || '').toLowerCase();
  const isImageReference = (tag === 'img' || tag === 'image')
    && (attribute === 'src' || attribute === 'href' || attribute === 'xlink:href');
  if (scheme === 'data') return isImageReference && DATA_IMAGE_PATTERN.test(trimmed);
  if (tag === 'a' && attribute === 'href') return LINK_SCHEMES.has(scheme);
  return false;
}

function sanitizePublicationDocument($) {
  $('*').each((_, element) => {
    const tagName = String(element.tagName || element.name || '').toLowerCase();
    const $element = $(element);

    if (BLOCKED_ELEMENTS.has(tagName)) {
      $element.remove();
      return;
    }

    if (tagName === 'meta' && $element.attr('http-equiv')) {
      $element.remove();
      return;
    }

    for (const [rawName, rawValue] of Object.entries(element.attribs || {})) {
      const attributeName = rawName.toLowerCase();
      if (attributeName.startsWith('on') || attributeName === 'srcdoc') {
        $element.removeAttr(rawName);
        continue;
      }
      if (attributeName === 'target') {
        $element.removeAttr(rawName);
        continue;
      }
      if (URL_ATTRIBUTES.has(attributeName)
        && !isSafePublicationUrl(rawValue, { tagName, attributeName })) {
        $element.removeAttr(rawName);
      }
    }
  });
}

module.exports = {
  filterEpubCss,
  filterInlineStyle,
  isSafePublicationUrl,
  normalizeXhtmlFragment,
  sanitizePublicationDocument,
};
