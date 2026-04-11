// Settings navigation
document.querySelectorAll('.settings-nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const section = item.dataset.section;

    // Update nav active state
    document.querySelectorAll('.settings-nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.section === section);
    });

    // Update panel visibility
    document.querySelectorAll('.settings-section').forEach(el => {
      el.classList.toggle('active', el.dataset.panel === section);
    });
  });
});

// Font size slider display
const fontSizeSlider = document.getElementById('setting-font-size');
const fontSizeDisplay = document.getElementById('font-size-display');
fontSizeSlider.addEventListener('input', () => {
  fontSizeDisplay.textContent = fontSizeSlider.value + 'px';
});

// --- Theme ---
const themeSelect = document.getElementById('setting-theme');

function applyTheme(theme) {
  const t = theme || 'dark';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('gull-theme', t);
}

themeSelect.addEventListener('change', () => {
  const theme = themeSelect.value;
  applyTheme(theme);
  window.settings.set('theme', theme);
});

// Listen for theme changes from other windows
window.settings.onThemeChanged((theme) => {
  applyTheme(theme);
  themeSelect.value = theme;
});

// Load saved settings on init
async function loadSettings() {
  const settings = await window.settings.getAll();
  if (settings.theme) {
    themeSelect.value = settings.theme;
    applyTheme(settings.theme);
  }
}

loadSettings();
