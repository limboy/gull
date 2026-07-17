# Gull

**A focused, typography-first e-book reader for macOS.**

Gull is a lightweight desktop reader for DRM-free EPUB and Kindle/Mobipocket books. It reflows each book into a clean, consistent reading layout while keeping navigation, search, highlights, and reading controls close at hand.

![Gull showing an open book, the book list, and the table of contents](assets/screenshot.png)

## Highlights

- **Read common e-book formats** — EPUB, MOBI, AZW3, AZW, and PRC.
- **Keep multiple books open** — switch between books from the left sidebar, complete with cover thumbnails. Gull restores open books and reading positions when it restarts.
- **Navigate long books easily** — use the table of contents or Gull's segmented chapter scrollbar, which maps the structure of the whole book. A standard native scrollbar is also available.
- **Search and highlight** — search the current book, jump directly to matches, and keep persistent text highlights in a dedicated sidebar.
- **Tune the page to your taste** — choose from five font families, four text sizes, three line-height settings, and three paragraph-spacing settings.
- **Choose your layout** — use light, dark, or system appearance; resize or collapse both sidebars; and switch to a full-width reading view.
- **Work naturally on macOS** — open books from Finder or `File > Open`, drag them into the books sidebar, and receive app updates in place.
- **Preserve book details** — Gull keeps images, internal chapter links, drop caps, and supported EPUB footnotes while normalizing styles that would override your reading preferences.

## Requirements

- macOS 12 Monterey or later
- Apple Silicon Mac
- DRM-free e-book files

Gull does not remove or bypass DRM.

## Install

Download the latest `.dmg` or `.zip` from [GitHub Releases](https://github.com/limboy/gull/releases/latest). The `.dmg` is the simplest option: open it and move Gull to Applications.

Once installed, open books with `Command-O`, use Finder's **Open With** action, or drag files into Gull's left sidebar.

## Development

Gull uses Node.js 24 in its release workflow.

```bash
git clone https://github.com/limboy/gull.git
cd gull
npm install
npm run dev
```

`npm run dev` starts Vite with renderer hot reloading and launches Electron against the local development server.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run Vite and Electron in development mode |
| `npm run check` | Syntax-check main, preload, and parser worker modules |
| `npm test` | Run unit tests and EPUB parser fixtures |
| `npm run build:renderer` | Create the production renderer bundle |
| `npm run build` | Build the signed and notarized macOS `.dmg` and `.zip` |
| `npm run changelog` | Regenerate `CHANGELOG.md` from tags and conventional commits |

The full macOS build requires a Developer ID Application certificate in Keychain and these values in a local `.env` file:

```dotenv
APPLE_ID=you@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

Build artifacts are written to `dist/`. See [Development, Build & Release](docs/build-and-release.md) for signing, notarization, and release details.

## How it is built

- **Desktop shell:** Electron
- **Renderer:** React + Vite
- **UI and styling:** Tailwind CSS, Radix UI, and hand-written CSS
- **Book parsing:** `adm-zip` and Cheerio for EPUB; `@lingo-reader/mobi-parser` for MOBI/KF8 formats
- **Distribution:** electron-builder and electron-updater via GitHub Releases

The Electron main process owns files, validated IPC, settings, and updates, while EPUB parsing runs in a dedicated worker. A context-isolated preload bridge exposes the narrow application API to the renderer. React provides the application shell, while `src/reader-runtime.js` manages the reader's tabs, content, navigation, search, highlights, and saved state.

Start with the [project overview](docs/overview.md), then see the focused guides in [`docs/`](docs/) for architecture, parsing, styling, reader behavior, and releases.

## License

Gull is licensed under the ISC License.
