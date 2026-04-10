import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import './settings/App.css';

function SettingsApp() {
  useEffect(() => {
    import('./legacy/settings-legacy.js');
  }, []);

  return (
    <div id="settings-layout">
      <div id="settings-title-bar" />

      <aside id="settings-sidebar">
        <div className="settings-nav-item active" data-section="appearance">
          <span>Appearance</span>
        </div>
        <div className="settings-nav-item" data-section="reading">
          <span>Reading</span>
        </div>
      </aside>

      <main id="settings-content">
        <div className="settings-section-title">Settings</div>

        <section className="settings-section active" data-panel="appearance">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-text">Theme</div>
              <div className="setting-label-desc">Choose your preferred application theme.</div>
            </div>
            <select id="setting-theme" className="setting-select" defaultValue="dark">
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
        </section>

        <section className="settings-section" data-panel="reading">
          <div className="setting-row">
            <div className="setting-label">
              <div className="setting-label-text">Base Font Size</div>
              <div className="setting-label-desc">Sets the default reading font size.</div>
            </div>
            <div className="font-size-control">
              <input id="setting-font-size" type="range" min="12" max="24" defaultValue="16" />
              <span id="font-size-display" className="font-size-value">16px</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<SettingsApp />);
