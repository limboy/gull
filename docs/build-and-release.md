---
summary: "How to develop, build, notarize, and release Gull — including the auto-update channel and CHANGELOG generation."
read_when:
  - Cutting a release or debugging a failed notarization
  - Changing `electron-builder` config, entitlements, or the update channel
  - Regenerating CHANGELOG.md or understanding the commit convention
title: "Development, Build & Release"
---

## Dev

```bash
npm install
npm run dev        # vite + electron, HMR for the renderer
```

`npm run dev` starts Vite on `127.0.0.1:5173` and launches Electron once the port is up. Electron detects dev mode via the `VITE_DEV_SERVER_URL` env var set by the script.

## Production build

```bash
npm run build      # vite build → dist/, then electron-builder --mac
```

Outputs `.dmg` and `.zip` targets (see `build.mac.target` in `package.json`). Only `main.js`, `preload.js`, `dist/index.html`, `dist/assets/**`, and `logo.png` are packaged (`build.files`).

## Notarization

`build.mac.notarize = true`. You need:

- A valid **Developer ID Application** certificate in Keychain
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` in a `.env` file (loaded via `dotenv-cli` in the `build` script)

Hardened runtime is on (`hardenedRuntime: true`); entitlements live at `build/entitlements.mac.plist`.

## Auto-update

`electron-updater` publishes to GitHub releases:

```json
"publish": [{ "provider": "github", "owner": "limboy", "repo": "gull", "releaseType": "release" }]
```

Runtime behavior (`initAutoUpdater` in `main.js`):
- Skipped when `!app.isPackaged`
- `autoDownload: true`, `autoInstallOnAppQuit: true`
- Checks on launch and every 6 hours
- On `update-downloaded`, broadcasts `update-ready` to renderers; the update pill in the toolbar invokes `apply-update` → `quitAndInstall()`

## CHANGELOG

`npm run changelog` runs `scripts/generate-changelog.js`, which walks `v*` git tags + conventional commits and rewrites `CHANGELOG.md`. Grouped by `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`. Use the `type(scope)!: subject` convention — the parser expects it. `!` and `BREAKING CHANGE:` footers trigger a Breaking section.

## File associations

`build.fileAssociations` registers `.epub` (`application/epub+zip`) with role `Viewer`. On macOS that wires up Finder "Open With…" and the `open-file` event used by `main.js`.
