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
