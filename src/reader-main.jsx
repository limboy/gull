import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ALargeSmall, Sun, Moon } from 'lucide-react';

import './reader/fonts.css';
import './reader/App.css';

function ReaderApp() {
  useEffect(() => {
    import('./reader-runtime.js');
  }, []);

  return (
    <div id="app-layout">
      <aside id="left-sidebar">
        <div className="left-sidebar-header" aria-hidden="true" />
        <div id="tab-bar-tabs" />
      </aside>

      <div id="resize-left" className="resize-handle" />

      <div id="main-area">
        <div id="tab-bar">
          <button id="toggle-left-sidebar" title="Toggle Files Sidebar" aria-label="Toggle Files Sidebar">
            <svg className="sidebar-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
            <svg className="sidebar-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M15 4v16" />
            </svg>
          </button>
          <div className="tab-bar-drag" />
          <div className="theme-switcher">
            <button id="btn-theme-light" className="theme-btn" title="Light Theme" aria-label="Light Theme">
              <Sun aria-hidden="true" />
            </button>
            <button id="btn-theme-dark" className="theme-btn" title="Dark Theme" aria-label="Dark Theme">
              <Moon aria-hidden="true" />
            </button>
          </div>
          <button id="btn-style" title="Reading Style" aria-label="Reading Style">
            <ALargeSmall aria-hidden="true" />
          </button>
          <button id="toggle-right-sidebar" title="Toggle Sidebar" aria-label="Toggle Sidebar">
            <svg className="sidebar-open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M15 4v16" />
            </svg>
            <svg className="sidebar-closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="16" rx="2" />
              <path d="M9 4v16" />
            </svg>
          </button>
        </div>

        <div id="content-wrapper">
          <div id="content-area">
            <div id="empty-state" className="empty-state">
              <div className="empty-state-content">
                <svg className="empty-icon" viewBox="0 0 24 24">
                  <path d="M4 3h13l3 3v15H4z" />
                  <path d="M17 3v3h3" />
                </svg>
                <div>Drop an EPUB file here or use File &gt; Open</div>
                <div className="empty-hint">Supports drag-and-drop and Finder open-in actions.</div>
              </div>
            </div>
          </div>
          <div id="chapter-scrollbar" />
        </div>
      </div>

      <div id="resize-right" className="resize-handle" />

      <aside id="right-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-tabs" role="tablist" aria-label="Sidebar Tabs">
            <button id="sidebar-tab-toc" className="sidebar-tab" role="tab" aria-selected="true" title="Table of Contents">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
            <button id="sidebar-tab-search" className="sidebar-tab" role="tab" aria-selected="false" title="Search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
          </div>

          <div id="sidebar-search-wrap" className="sidebar-search-wrap" hidden>
            <input id="sidebar-search-input" type="text" placeholder="Search current book..." />
          </div>
        </div>

        <div id="outline-panel" className="outline-panel-content" />
        <div id="search-panel" className="outline-panel-content" hidden />
      </aside>

      <div id="style-popover" role="dialog" aria-label="Reading Style">
        <div className="style-row">
          <label htmlFor="style-font">Font</label>
          <select id="style-font" defaultValue="Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif">
            <option value="Charter, 'Iowan Old Style', Georgia, 'Times New Roman', serif">Serif</option>
            <option value="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">System Sans</option>
            <option value="'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">Inter</option>
            <option value="'Open Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">Open Sans</option>
            <option value="'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif">Geist</option>
            <option value="'Geist Mono', ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace">Monospace</option>
          </select>
        </div>

        <div className="style-row">
          <label>Font Size</label>
          <div className="style-stepper">
            <button type="button" data-step="font-size" data-dir="-1" aria-label="Decrease font size">-</button>
            <span id="style-font-size-val">16px</span>
            <button type="button" data-step="font-size" data-dir="1" aria-label="Increase font size">+</button>
          </div>
        </div>

        <div className="style-row">
          <label>Line Height</label>
          <div className="style-stepper">
            <button type="button" data-step="line-height" data-dir="-1" aria-label="Decrease line height">-</button>
            <span id="style-line-height-val">1.8</span>
            <button type="button" data-step="line-height" data-dir="1" aria-label="Increase line height">+</button>
          </div>
        </div>

        <div className="style-row">
          <label>Paragraphs</label>
          <div className="style-stepper">
            <button type="button" data-step="para-spacing" data-dir="-1" aria-label="Decrease paragraph spacing">-</button>
            <span id="style-para-spacing-val">0.6em</span>
            <button type="button" data-step="para-spacing" data-dir="1" aria-label="Increase paragraph spacing">+</button>
          </div>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ReaderApp />);
