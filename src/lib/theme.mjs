export function applySystemTheme(root = document.documentElement, prefersDark) {
  const isDark = typeof prefersDark === 'boolean'
    ? prefersDark
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = isDark ? 'dark' : 'light';
  root.setAttribute('data-theme', theme);
  return theme;
}
