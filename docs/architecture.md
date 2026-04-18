---
summary: "How the Electron main process, preload bridge, and renderer cooperate — windows, IPC channels, and lifecycle."
read_when:
  - Adding a new IPC channel or changing an existing one
  - Debugging window / file-open / second-instance behavior
  - Working on settings persistence or auto-update
title: "Process Architecture & IPC"
---

Gull runs a single main process that owns the filesystem and a single renderer window. The preload script is the only bridge; the renderer has no Node integration.

## Processes

- **Main** (`main.js`): window lifecycle, file associations, EPUB parsing, settings persistence, auto-update.
- **Preload** (`preload.js`): exposes three namespaces via `contextBridge`:
  - `window.epub` — `parse`, `getFilePath`, `onOpenFile`, `signalReady`, `checkPathsExistence`
  - `window.settings` — `getAll`, `set`, `onSettingsChanged`, `onThemeChanged`
  - `window.updater` — `onUpdateReady`, `apply`
- **Renderer** (`src/reader-main.jsx` + `src/reader-runtime.js`): pure DOM work, no Node access.

## IPC channels

| Channel | Dir | Purpose |
|---|---|---|
| `parse-epub` | R→M (invoke) | Parse a file path, return `{title, chapters, toc}` |
| `get-settings` | R→M (invoke) | Read `settings.json` |
| `set-setting` | R→M (invoke) | Persist one key; broadcasts `settings-changed` (+ `theme-changed` when key=`theme`) |
| `check-paths-existence` | R→M (invoke) | Batch check whether paths still exist; treats iCloud `.<name>.icloud` placeholders as "exists" so temporarily evicted books stay in tabs |
| `apply-update` | R→M (invoke) | Calls `autoUpdater.quitAndInstall()` |
| `renderer-ready` | R→M (send) | Signals the renderer has wired `open-file` listener; main then flushes `pendingFiles` |
| `open-file` | M→R | Deliver a file path to open as a tab |
| `settings-changed` | M→R (broadcast) | Full settings object after any write |
| `theme-changed` | M→R (broadcast) | Just the new theme value |
| `update-ready` | M→R (broadcast) | `electron-updater` finished downloading |

## File-open pipeline

Files can arrive from: macOS `open-file` event, `second-instance` CLI args, first-launch CLI args, Finder double-click, or renderer drag-drop (which calls `parse` directly on a path obtained via `webUtils.getPathForFile`). Main buffers them in `pendingFiles` until the renderer sends `renderer-ready`, then drains the queue. This avoids the race where a file is requested before listeners are attached.

## Single instance

`app.requestSingleInstanceLock()` ensures one Gull. A second launch fires `second-instance` with the CLI args of the new invocation; main focuses the existing window and opens any `.epub` args in it.

## Settings

Stored at `path.join(app.getPath('userData'), 'settings.json')`. Known keys:
- `mainWindowBounds`, `mainWindowMaximized` — window state, saved debounced (200ms) on move/resize/close
- `theme` — `light` | `dark`
- `readerState` — open books, active tab, per-book positions (persisted by the renderer)
- `highlights`, `readingStyle` — persisted by the renderer via `set-setting`

## Navigation hardening

`will-navigate` is cancelled for in-app URLs (prevents SPA white-screen from stray link clicks); `http(s)://` links open via `shell.openExternal`. `setWindowOpenHandler` does the same for window.open.
