const THEME_MODES = new Set(['system', 'light', 'dark']);

export function normalizeThemeMode(value) {
  return THEME_MODES.has(value) ? value : 'system';
}

export function resolveThemeMode(value, prefersDark = false) {
  const mode = normalizeThemeMode(value);
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

export function applyThemeMode(value, root = document.documentElement, prefersDark) {
  const mode = normalizeThemeMode(value);
  const isDark = typeof prefersDark === 'boolean'
    ? prefersDark
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.setAttribute('data-theme', resolveThemeMode(mode, isDark));
  return mode;
}
