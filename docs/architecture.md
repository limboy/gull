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

- **Main** (`main.js`): window lifecycle, file associations, validated IPC, settings persistence, book-folder scanning, native sidebar menus, and auto-update.
- **EPUB worker** (`lib/epub-parser-worker.js`): serializes CPU-heavy EPUB parsing away from the Electron main thread.
- **Preload** (`preload.js`): exposes three namespaces via `contextBridge`:
  - `window.epub` — `parse`, `onOpenFile`, `signalReady`, `checkPathsExistence`, `selectBookFolder`, `scanBookFolder`, `showSidebarMenu`, `showSortMenu`, `openExternal`
  - `window.settings` — `getAll`, `set`, `onSettingsChanged`, `onThemeChanged`
  - `window.updater` — `onUpdateReady`, `apply`
- **Renderer** (`src/reader-main.jsx` + `src/reader-runtime.js`): pure DOM work, no Node access.

## IPC channels

| Channel | Dir | Purpose |
|---|---|---|
| `parse-epub` | R→M (invoke) | Parse a file path, return `{title, chapters, toc}` |
| `get-settings` | R→M (invoke) | Read `settings.json` |
| `set-setting` | R→M (invoke) | Persist one key; broadcasts `settings-changed` (+ `theme-changed` when key=`theme`) |
| `select-book-folder` | R→M (invoke) | Show a folder picker, then return `{path, name, books}` for the chosen directory (`null` if canceled) |
| `scan-book-folder` | R→M (invoke) | Re-read a folder the sidebar already lists; `null` when it is gone or unmounted |
| `show-sort-menu` | R→M (invoke) | Pop the sidebar's native sort menu (Name / Date Created, Ascending / Descending, Folders First) and return the updated settings, or `null` if dismissed |
| `show-sidebar-menu` | R→M (invoke) | Pop the native right-click menu for a sidebar folder (Show in Finder / Expand All / Collapse All / Remove) or book row (Show in Finder); reveals the path itself and returns the chosen action |
| `check-paths-existence` | R→M (invoke) | Batch check whether paths still exist; treats iCloud `.<name>.icloud` placeholders as "exists" so temporarily evicted books stay in tabs |
| `open-external` | R→M (invoke) | Open a validated `http`, `https`, `mailto`, or `tel` URL after an explicit reader link click |
| `apply-update` | R→M (invoke) | Calls `autoUpdater.quitAndInstall()` |
| `renderer-ready` | R→M (send) | Signals the renderer has wired `open-file` listener; main then flushes `pendingFiles` |
| `open-file` | M→R | Deliver a file path to open as a tab |
| `settings-changed` | M→R (broadcast) | Full settings object after any write |
| `theme-changed` | M→R (broadcast) | Just the new theme value |
| `update-ready` | M→R (broadcast) | `electron-updater` finished downloading |
| `chapter-scrollbar-changed` | M→R (broadcast) | Layout Settings toggle: `true` (chapter scrollbar) or `false` (native scrollbar) |

## File-open pipeline

Files can arrive from: macOS `open-file` event, `second-instance` CLI args, first-launch CLI args, or Finder double-click. Main buffers them in `pendingFiles` until the renderer sends `renderer-ready`, then drains the queue. This avoids the race where a file is requested before listeners are attached. Dropping files onto the window is not supported — books are added by picking a folder in the sidebar or through `File > Open`.

## Book folders

`select-book-folder` and `scan-book-folder` both answer with `readBookFolder`, which walks the directory into a tree: each node carries `path`, `name`, `createdAt`, its own `books` (`filePath`, `title`, `createdAt`), and its `folders`. `readFolderTree` descends `MAX_FOLDER_SCAN_DEPTH` (4) levels with a shared budget of `MAX_FOLDER_BOOKS` (500) files, so both flat folders and Calibre-style `Author/Title/book.epub` trees list correctly. Branches holding no books at any depth are pruned, dotfiles are skipped, and symlinks are ignored (readdir reports them as neither file nor directory), which also rules out symlink cycles. `createdAt` comes from `birthtimeMs`, falling back to `mtimeMs`, and is what the sidebar's *Date Created* sort orders by. Main only ever reports supported book extensions, and the renderer owns the list of folders — main keeps no library state.

## Single instance

`app.requestSingleInstanceLock()` ensures one Gull. A second launch fires `second-instance` with the CLI args of the new invocation; main focuses the existing window and opens any `.epub` args in it.

## Settings

Stored atomically at `path.join(app.getPath('userData'), 'settings.json')`. Renderer writes are restricted to known keys and validated value shapes. Known keys:
- `mainWindowBounds`, `mainWindowMaximized` — window state, saved debounced (200ms) on move/resize/close
- `theme` — `system` | `light` | `dark`
- `sidebarStates` — persisted left/right sidebar visibility
- `chapterScrollbar` — `true` (default) | `false`; toggled via Layout settings dropdown
- `fullWidth` — `true` | `false` (default); toggled via Layout settings dropdown

## Navigation hardening

Renderer navigation and popup creation are always denied. External links open only through the validated `open-external` IPC channel after an explicit content click.

All renderer IPC must originate from the trusted main frame. Book parsing additionally requires an absolute supported file path, a regular file, and a size under 512 MB.
