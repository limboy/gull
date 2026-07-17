import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RefreshCw } from 'lucide-react';
import { SettingsMenu } from '@/components/SettingsMenu';
import { LayoutMenu } from '@/components/LayoutMenu';
import { applyThemeMode } from '@/lib/theme.mjs';

import './reader/fonts.css';
import './reader/App.css';

const initialSettings = window.initialSettings || {};

function applyInitialAppearance() {
  let savedTheme = 'system';
  const rawTheme = localStorage.getItem('gull-theme');
  try {
    savedTheme = JSON.parse(rawTheme) || 'system';
  } catch {
    savedTheme = rawTheme || 'system';
  }
  applyThemeMode(initialSettings.theme || savedTheme);
  document.documentElement.classList.toggle(
    'native-scrollbar',
    initialSettings.chapterScrollbar === false
  );
}

function hasSavedBooksToRestore() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-open-books'));
    return Array.isArray(saved?.openBooks) && saved.openBooks.length > 0;
  } catch {
    return false;
  }
}

function applyInitialReadingStyle() {
  const defaults = {
    fontFamily: "'Charter', serif",
    fontSize: 16,
    lineHeight: 1.8,
    paraSpacing: 0.6,
  };

  try {
    const saved = JSON.parse(localStorage.getItem('gull-reading-style')) || {};
    Object.assign(defaults, saved);
  } catch {}

  const root = document.documentElement;
  root.style.setProperty('--book-font-family', defaults.fontFamily);
  root.style.setProperty('--book-font-size', `${defaults.fontSize}px`);
  root.style.setProperty('--book-line-height', String(defaults.lineHeight));
  root.style.setProperty('--book-para-spacing', `${defaults.paraSpacing}em`);
}

function applyInitialSidebarWidths() {
  try {
    const saved = JSON.parse(localStorage.getItem('gull-sidebar-widths')) || {};
    if (Number.isFinite(saved.left)) {
      document.documentElement.style.setProperty('--left-sidebar-width', `${saved.left}px`);
    }
    if (Number.isFinite(saved.right)) {
      document.documentElement.style.setProperty('--right-sidebar-width', `${saved.right}px`);
    }
  } catch {}
}

// Set persistent dimensions before React creates the grid so its first layout is final.
applyInitialAppearance();
applyInitialReadingStyle();
applyInitialSidebarWidths();
const isRestoringSavedBook = hasSavedBooksToRestore();

function ReaderApp() {
  useEffect(() => {
    import('./reader-runtime.js');
  }, []);

  // Read initial sidebar and scrollbar states synchronously from initialSettings to prevent visual layout flash
  const sidebarStates = initialSettings.sidebarStates || {};
  const leftHidden = !!sidebarStates.leftHidden;
  const rightHidden = !!sidebarStates.rightHidden;
  const nativeScrollbar = initialSettings.chapterScrollbar === false;
  const fullWidth = initialSettings.fullWidth === true;

  const layoutClasses = [
    'app-starting',
    leftHidden ? 'left-sidebar-hidden' : '',
    rightHidden ? 'right-sidebar-hidden' : '',
    nativeScrollbar ? 'native-scrollbar' : '',
    fullWidth ? 'full-width' : ''
  ].filter(Boolean).join(' ');

  return (
    <div id="app-layout" className={layoutClasses}>
      <aside id="left-sidebar">
        <div className="left-sidebar-header" aria-hidden="true" />
        <div id="tab-bar-tabs" role="tablist" aria-label="Open books" aria-orientation="vertical" />
        <div className="left-sidebar-footer">
          <SettingsMenu />
        </div>
      </aside>

      <div
        id="resize-left"
        className="resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize books sidebar"
        aria-orientation="vertical"
        aria-valuemin="250"
        aria-valuemax="500"
      />

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
          <button id="btn-update" className="update-pill" hidden title="Install update and restart" aria-label="Install update and restart">
            <RefreshCw aria-hidden="true" />
            <span>Update</span>
          </button>
          <LayoutMenu />
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
          <main id="content-area" aria-label="Book content">
            <div
              id="empty-state"
              className="empty-state"
              style={isRestoringSavedBook ? { display: 'none' } : undefined}
            >
              <div className="empty-state-content">
                <svg className="empty-icon" viewBox="0 0 24 24">
                  <path d="M4 3h13l3 3v15H4z" />
                  <path d="M17 3v3h3" />
                </svg>
                <div>Drop an e-book file here or use File &gt; Open</div>
                <div className="empty-hint">Supports drag-and-drop and Finder open-in actions.</div>
              </div>
            </div>
            {isRestoringSavedBook && <div className="book-content active">Loading…</div>}
          </main>
          <div id="chapter-scrollbar" aria-hidden="true" />
        </div>
      </div>

      <div
        id="resize-right"
        className="resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize navigation sidebar"
        aria-orientation="vertical"
        aria-valuemin="250"
        aria-valuemax="500"
      />

      <aside id="right-sidebar">
        <div className="sidebar-header">
          <div className="sidebar-tabs" role="tablist" aria-label="Sidebar Tabs">
            <button id="sidebar-tab-toc" className="sidebar-tab" role="tab" tabIndex={0} aria-selected="true" aria-controls="outline-panel" title="Table of Contents">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="8" y1="6" x2="21" y2="6" />
                <line x1="8" y1="12" x2="21" y2="12" />
                <line x1="8" y1="18" x2="21" y2="18" />
                <line x1="3" y1="6" x2="3.01" y2="6" />
                <line x1="3" y1="12" x2="3.01" y2="12" />
                <line x1="3" y1="18" x2="3.01" y2="18" />
              </svg>
            </button>
            <button id="sidebar-tab-highlights" className="sidebar-tab" role="tab" tabIndex={-1} aria-selected="false" aria-controls="highlights-panel" title="Highlights">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
                <path d="M5 3v4" />
                <path d="M19 17v4" />
                <path d="M3 5h4" />
                <path d="M17 19h4" />
              </svg>
            </button>
            <button id="sidebar-tab-search" className="sidebar-tab" role="tab" tabIndex={-1} aria-selected="false" aria-controls="search-panel" title="Search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </button>
          </div>

          <div id="sidebar-search-wrap" className="sidebar-search-wrap" hidden>
            <input id="sidebar-search-input" type="text" aria-label="Search current book" placeholder="Search current book..." />
            <button
              id="sidebar-search-clear"
              type="button"
              className="sidebar-search-clear"
              aria-label="Clear search"
              title="Clear search"
              hidden
            >
              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div id="outline-panel" className="outline-panel-content" role="tabpanel" aria-labelledby="sidebar-tab-toc" />
        <div id="search-panel" className="outline-panel-content" role="tabpanel" aria-labelledby="sidebar-tab-search" hidden />
        <div id="highlights-panel" className="outline-panel-content" role="tabpanel" aria-labelledby="sidebar-tab-highlights" hidden />
      </aside>

      <button id="selection-popup" className="selection-popup" type="button" aria-label="Highlight" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 11-6 6v3h9l3-3" />
          <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0L7.4 9.4a2 2 0 0 1 0-2.8L12 2" />
        </svg>
        <span className="selection-popup-label">Highlight</span>
      </button>

      <div id="footnote-popover" className="footnote-popover" hidden />

      <div className="file-drop-overlay" aria-hidden="true">
        <span>Drop book to open</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ReaderApp />);
