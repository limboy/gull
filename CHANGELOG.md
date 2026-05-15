# Changelog

All notable changes to this project are documented here.
This file is generated automatically from [Conventional Commits](https://www.conventionalcommits.org/) — run `npm run changelog` to regenerate.

## [v1.2.15](https://github.com/limboy/gull/compare/v1.2.14...v1.2.15) - 2026-05-15

### Documentation

- update CHANGELOG for v1.2.14 ([a2ff895](https://github.com/limboy/gull/commit/a2ff8951480c21adfdda0ea06fb877f76dcf2fac))

### Build

- **mac:** add npm run build:icon to regenerate icon assets ([54db060](https://github.com/limboy/gull/commit/54db0607ad33dd72fa25ce2432c9ed0724b13a2a))
- **mac:** auto-regenerate icon assets when actool 26 is available ([d35344b](https://github.com/limboy/gull/commit/d35344b0d96213a1970e075d965c09e72d2a696d))
- **mac:** inject pre-built Tahoe icon assets via afterPack hook ([eaa3b5b](https://github.com/limboy/gull/commit/eaa3b5b5552854ed000ac3e54619ba925775db40))
- **mac:** fall back to assets/icon.png until Xcode 26 runners available ([b044c1a](https://github.com/limboy/gull/commit/b044c1a95ba5d9aa05b6d4610582f3f50174e0af))

## [v1.2.14](https://github.com/limboy/gull/compare/v1.2.13...v1.2.14) - 2026-05-15

### Documentation

- update CHANGELOG for v1.2.13 ([0333605](https://github.com/limboy/gull/commit/0333605b4cceed0df58ba871a956854ebc768249))

### Build

- **mac:** use Icon Composer .icon for macOS Tahoe app icon ([6d0f82a](https://github.com/limboy/gull/commit/6d0f82a68f5b1f352229ab0f4b53b0aaffb9c15e))

## [v1.2.13](https://github.com/limboy/gull/compare/v1.2.12...v1.2.13) - 2026-05-12

### Build

- explicitly install emnapi@1.10.0 to fix CI mismatch ([7db4650](https://github.com/limboy/gull/commit/7db46507b190e4df17a785c05fcccdd0d754e0c0))

## [v1.2.12](https://github.com/limboy/gull/compare/v1.2.11...v1.2.12) - 2026-05-12

### Build

- sync package-lock.json to resolve CI dependency error ([abd8554](https://github.com/limboy/gull/commit/abd8554e2c0b3653cbfc4e9a3d0f9187584288d1))

## [v1.2.11](https://github.com/limboy/gull/compare/v1.2.10...v1.2.11) - 2026-05-12

### Features

- integrate Chapter Scrollbar toggle and refine Settings menu ([c1cc98b](https://github.com/limboy/gull/commit/c1cc98b2b7c55aadea68b50306a8161adcbef43d))
- migrate theme and reading style to unified Settings menu ([c58f7cf](https://github.com/limboy/gull/commit/c58f7cf2694e0c3135fafd07863a2d93c91358a8))

### Documentation

- update CHANGELOG for v1.2.9 ([0844bcb](https://github.com/limboy/gull/commit/0844bcb2820439b0e69c0f7311660a841713b0bf))

## [v1.2.10](https://github.com/limboy/gull/compare/v1.2.9...v1.2.10) - 2026-05-12

### Features

- integrate Chapter Scrollbar toggle and refine Settings menu ([f8d2b7b](https://github.com/limboy/gull/commit/f8d2b7b9b28faf92e9448b995cc002bb95801422))
- migrate theme and reading style to unified Settings menu ([b1c32f5](https://github.com/limboy/gull/commit/b1c32f56b9e7e2e1bb61f66a545dcc31f6b4802f))

## [v1.2.9](https://github.com/limboy/gull/compare/v1.2.8...v1.2.9) - 2026-05-11

### Features

- **epub:** show footnote popover on noteref click ([2693f92](https://github.com/limboy/gull/commit/2693f92b199da18cc873fb745526d80bbeb64c9b))

### Documentation

- update CHANGELOG for v1.2.8 ([5ed4af9](https://github.com/limboy/gull/commit/5ed4af90ceeae710ca63460470c135d9518a45b8))

## [v1.2.8](https://github.com/limboy/gull/compare/v1.2.7...v1.2.8) - 2026-04-29

### Bug Fixes

- **build:** move releaseNotesFile to releaseInfo block ([8ac21ce](https://github.com/limboy/gull/commit/8ac21ce29ffa44274d57031f269147d326099735))

### Documentation

- update CHANGELOG for v1.2.7 ([8340e7c](https://github.com/limboy/gull/commit/8340e7c9e820e78187dda2472e1988b7de19790a))

## [v1.2.7](https://github.com/limboy/gull/compare/v1.2.6...v1.2.7) - 2026-04-29

### Features

- add toggleable native scrollbar option in View menu ([29c9940](https://github.com/limboy/gull/commit/29c994049ceb6adbbfcc81b5ac32e5ed412ccc89))
- active background styles for light and dark themes ([9188d4a](https://github.com/limboy/gull/commit/9188d4a41c455baccbf1084b18f4a2bbcfc9df4c))
- add findChapterByHref helper to resolve ambiguous navigation paths in multi-book EPUB collections ([3010c84](https://github.com/limboy/gull/commit/3010c8401b29b706a727598f8be47f8b34655c96))
- persist offline books across sessions and treat iCloud placeholders as existing files to prevent tab loss ([fd65d86](https://github.com/limboy/gull/commit/fd65d86c6463c500848c0a32fde4c435e0fd23c5))
- automate release note generation and integration for GitHub releases ([109262a](https://github.com/limboy/gull/commit/109262a1aaff622cb2e63b7b3a6f118ea72b5416))

### Documentation

- update README installation and development sections for clarity ([38fac7f](https://github.com/limboy/gull/commit/38fac7f176044991f77083ba24bd9994396d1e20))
- move screenshot to top of README ([208477b](https://github.com/limboy/gull/commit/208477bcc85aa1395e03c44b420df9190e1c6a30))
- update CHANGELOG for v1.2.6 ([50eca5f](https://github.com/limboy/gull/commit/50eca5f0cf43737352bebc41a02b8ff992efa1e3))

### Styles

- update accent color and adjust active outline item text color ([0671289](https://github.com/limboy/gull/commit/067128994b7b04128c3484d5686d1d073386d857))

### Chores

- add *.epub to .gitignore to exclude ebook files from version control ([d0e0a97](https://github.com/limboy/gull/commit/d0e0a97bef7a569ee573a76ac83fbd53c9d44f56))
- restrict macOS support to Apple Silicon and update system requirements documentation ([3e054d1](https://github.com/limboy/gull/commit/3e054d10054b321e08d72498b6e0e91457d35f81))

## [v1.2.6](https://github.com/limboy/gull/compare/v1.2.5...v1.2.6) - 2026-04-15

### Features

- add script to list and validate documentation metadata from markdown files ([00e1a3f](https://github.com/limboy/gull/commit/00e1a3f06788fcc6e768f6c2f955434395fc58d0))
- add releaseType field to configuration in package.json ([e1cc027](https://github.com/limboy/gull/commit/e1cc02798cb0e86e4ee4a0e54c63c9442dee1f51))
- set application name to Gull in main process ([067d22d](https://github.com/limboy/gull/commit/067d22d2825bd2b6506d6184ddc61cc96f818c2d))

### Bug Fixes

- **docs:** convert docs-list.js to CommonJS ([1b543c1](https://github.com/limboy/gull/commit/1b543c15ba053bfd021ff0dd528ec672e3fea9d7))

### Refactoring

- **main:** add explicit label to About menu item ([00645c0](https://github.com/limboy/gull/commit/00645c02ee2829de5d60fbf4e650fcb00af48b04))

### Documentation

- update build and release documentation with CI/CD workflow details ([f35d18a](https://github.com/limboy/gull/commit/f35d18a49502b5ade0eff4475f204cc5f2632027))
- regenerate changelog ([917300a](https://github.com/limboy/gull/commit/917300ab3735c3cd076cbd0958cc04e961597e8a))
- update changelog with new features, documentation, and chore entries ([75c8dcd](https://github.com/limboy/gull/commit/75c8dcdee0af5c6933c6669e4ff6655e3fc219b2))
- add agent operating guides and commit conventions ([9e88744](https://github.com/limboy/gull/commit/9e88744f3683d819a26b0ca939dbcaab2a4beab7))
- add technical documentation covering architecture, build process, EPUB parsing, and runtime logic ([3030971](https://github.com/limboy/gull/commit/3030971e1a2cf0a9a837b6eb75403e0fab7c8ee7))

### Chores

- add auto-generated CHANGELOG from conventional commits ([94ccb55](https://github.com/limboy/gull/commit/94ccb55a51c30e94842220aa57cfe9b8ad6d2da1))
- upgrade actions/checkout and actions/setup-node to v6 ([b9c8ce1](https://github.com/limboy/gull/commit/b9c8ce162d35e7628e653f7a0a32decf534b798e))

## [v1.2.5](https://github.com/limboy/gull/compare/v1.2.4...v1.2.5) - 2026-04-15

### Features

- improve chapter title resolution for search results ([20e94ab](https://github.com/limboy/gull/commit/20e94ab5b92f07c7ab1a81b653d021af10286568))
- highlight search matches in reader content ([b97dcc0](https://github.com/limboy/gull/commit/b97dcc0aabdf7b78ff57a9fa9ef9750886d134da))
- add clear button to sidebar search input ([584757a](https://github.com/limboy/gull/commit/584757a73115e529c6dd39ab4c532d4bc1590c43))

### Chores

- bump version to 1.2.5 ([d53fdd0](https://github.com/limboy/gull/commit/d53fdd0ba88a70a51fba875ca7f5c3a746f357fc))
- enable Node 24 for JavaScript actions in release workflow ([89ef9d7](https://github.com/limboy/gull/commit/89ef9d743ce3dc0e5d9599c42a9a85f0e2b257df))

## [v1.2.4](https://github.com/limboy/gull/releases/tag/v1.2.4) - 2026-04-15

### Features

- implement auto-update functionality using electron-updater and add GitHub release workflow ([cc7efaa](https://github.com/limboy/gull/commit/cc7efaa765268e3e521c746fd61427e66e399e64))
- validate file existence during state loading and update app initialization to be asynchronous ([cdab695](https://github.com/limboy/gull/commit/cdab695f8224ac937d614db69208ed97a4e5f511))
- implement renderer-ready handshake to ensure file opening occurs only after runtime initialization ([151745c](https://github.com/limboy/gull/commit/151745c83c689b3292127f0fbcab048fcd7717b4))
- preserve font-size and line-height for drop-cap elements during CSS filtering ([07d0488](https://github.com/limboy/gull/commit/07d0488f2edc57a7f300b12f608525c6e65f35a2))
- add dark mode hover and active styles for tab items ([47ab46b](https://github.com/limboy/gull/commit/47ab46b4fdbde99cafa407a0950d36b281e7ec84))
- add Charter font files and update font selection UI and styles ([b68caef](https://github.com/limboy/gull/commit/b68caef0495d53a8ed77f40431e01c8df9add548))
- add Educated.epub and improve book content layout and styling in main-area.css ([50483ae](https://github.com/limboy/gull/commit/50483aedcc8772c2862d443df9d2baff75f3e39c))
- prevent internal navigation in main process and intercept link clicks for internal chapter jumps ([a5e1d67](https://github.com/limboy/gull/commit/a5e1d674bf74ce2d4eb31ec8bc8ec645149b6f93))
- configure macOS hardened runtime, notarization, and environment variables for build signing ([0b9eb9d](https://github.com/limboy/gull/commit/0b9eb9d231f86e5538fa476a2c1a1361cc188c4d))
- implement text highlighting functionality with persistent storage and sidebar management ([817ba2b](https://github.com/limboy/gull/commit/817ba2b5af3b48f9a41b92ade93551b8a5b57195))
- add theme switcher UI and set light mode as default theme ([b0dbbc5](https://github.com/limboy/gull/commit/b0dbbc5f457304a1de215bc4d0e6c88ced4c3030))
- add file association support and implement single-instance locking with file handling ([0ee1d43](https://github.com/limboy/gull/commit/0ee1d4328a94152ae8dea43c579b432ec6169ab6))
- implement persistent theme selection using localStorage and system preference detection ([b273ae1](https://github.com/limboy/gull/commit/b273ae1d9e17c9aeaa9d53a58ba7f54dedf9c9ed))
- implement persistent reader state to save and restore book scroll positions ([6e8c59b](https://github.com/limboy/gull/commit/6e8c59b983fc70692ee4cc89b9d24581d1911f82))
- add Inter, Open Sans, and Geist font support to reader settings ([9ca751d](https://github.com/limboy/gull/commit/9ca751deba9b4bc3c93c2965c69273d27ca083e8))

### Bug Fixes

- ensure SVG images are visible and correctly handle href attributes during base64 conversion ([eb48568](https://github.com/limboy/gull/commit/eb48568cb5ade8edb702a74a73ab236dd8b49b8c))
- enforce font-size inheritance and standardize heading typography in book content ([d2b0c68](https://github.com/limboy/gull/commit/d2b0c680f3a1950cdb21429a6b3d7724480859e8))

### Performance

- implement batched rendering and indexing for book loading and optimize scrollbar/outline updates with ResizeObserver ([ce4fc03](https://github.com/limboy/gull/commit/ce4fc03235e8ddba3453c1a54be1f9a8a6e2ae94))

### Refactoring

- remove settings window functionality and update sidebar width constraints ([9d7ad12](https://github.com/limboy/gull/commit/9d7ad12b9ac66d48e2b1290b18824319198540f3))
- remove dedicated dock icon and use main logo for dock icon instead ([9ba74ea](https://github.com/limboy/gull/commit/9ba74ea8fa5c698e9a73870ef0886e1c5c33f202))
- remove Avenir font option from reader style settings ([93d6093](https://github.com/limboy/gull/commit/93d60934235e530baa09b4f55c3fee72e9951f87))

### Documentation

- add instructions for Apple notarization environment variables to README ([8cd35dc](https://github.com/limboy/gull/commit/8cd35dc1e94297d820fef14b8e8c566a188b8e6c))
- add project README and initial screenshot asset ([fb8614f](https://github.com/limboy/gull/commit/fb8614f270667ed24de09a060afda6f62ad80a05))

### Styles

- reduce gap and update padding and border-radius for tab items ([4c8e077](https://github.com/limboy/gull/commit/4c8e0774c091d163611a14d3d149c42627b66253))
- adjust paragraph margins and include sup tag in small text styling ([1606170](https://github.com/limboy/gull/commit/1606170fd9968643a7353f0c82c3d157c06960d9))
- update primary text color to #171717 ([ab8021d](https://github.com/limboy/gull/commit/ab8021d09e8f5012f0b50814145e8929533c7e6f))
- update primary text colors, adjust layout spacing, and refine font sizing ([d4d0e14](https://github.com/limboy/gull/commit/d4d0e146e765caa68976b42e7ff01f7cddad9d7f))
- update select and stepper component dimensions and styling for consistent layout ([3fc5c97](https://github.com/limboy/gull/commit/3fc5c9764dd558263c835ce76d391cb5d92404bb))
- disable text selection and pointer events for UI elements in main.css ([8f96ca2](https://github.com/limboy/gull/commit/8f96ca22aa0c1bd150c317022f21fb73d5773b71))

### Chores

- update package-lock.json dependencies ([7d464b4](https://github.com/limboy/gull/commit/7d464b45275b2d4ef8fd3f949dad612f4b0ed249))
- upgrade node-version to 24 in release workflow ([2892955](https://github.com/limboy/gull/commit/2892955b16d95e7b1383b20a76e9608db8357cf7))
- bump version to 1.2.4 ([372679d](https://github.com/limboy/gull/commit/372679d5798a3eaabea546c7b323054155f00bff))
- bump version to 1.2.3 ([971745d](https://github.com/limboy/gull/commit/971745de1ffb903cca71c95b2a0e31d7d1121fe6))
- bump version to 1.2.2 and improve sidebar CSS formatting and line-clamp support ([5c8af52](https://github.com/limboy/gull/commit/5c8af524a2c7672731c9f088b81c07e9a8bf4e6f))
- bump version to 1.2.1 ([47d0996](https://github.com/limboy/gull/commit/47d0996922e16c2e3d08d411cf43b3073c45b7da))
- bump version to 1.2.0 ([bb334ee](https://github.com/limboy/gull/commit/bb334eeca38a71d427d47a249fa961f213a3a8e7))
- add dotenv-cli and update build script to inject environment variables ([34501cc](https://github.com/limboy/gull/commit/34501ccb92e042d1f0b6d7ff9982843e78384456))
- bump version to 1.1.1 ([7c8d0b6](https://github.com/limboy/gull/commit/7c8d0b6eeb75b9696e52ee6bd66ec6f2d2ee1ba0))
- bump version to 1.1.0 ([c003612](https://github.com/limboy/gull/commit/c0036121800b8e356153f18417eef195c4d86a31))
- remove settings page, update file association metadata, and add app icon configuration ([27f9991](https://github.com/limboy/gull/commit/27f9991080f0538770f7771aaeaac1577cbd89b1))
- rename project from Yara to Gull and update associated storage keys ([b5f11a2](https://github.com/limboy/gull/commit/b5f11a27876f32e43faedffe04449b3aaa34c3e7))
