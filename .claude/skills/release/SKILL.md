---
name: release
description: Cut a Gull release — pick the version, draft release notes, push the tag, watch the GitHub Actions build (sign, notarize, Sparkle appcast), and verify what users will download. Use when asked to release, ship, publish or tag a new version of Gull.
---

# Releasing Gull

A release is a pushed `v*` tag. `.github/workflows/release.yml` builds that tag with `scripts/build-release.sh`: Developer ID signing, notarization with an App Store Connect API key, the Sparkle-signed zip (what updates install), a notarized DMG (what people download), and `appcast.xml`. It publishes all three as a GitHub release on `limboy/gull-native`. Installed copies find updates through `releases/latest/download/appcast.xml`, so **the newest release is what every user's Sparkle sees**.

Publishing is outward-facing and can't be quietly undone once users have updated. Confirm the version and notes with the user before pushing anything.

## 1. Check the starting point

```bash
git status --short && git branch --show-current
git fetch --tags -q && git tag --sort=-v:refname | head -5
git status -sb | head -1
grep MARKETING_VERSION project.yml
gh secret list -R limboy/gull-native
```

- The tree must be clean and on `main`; `scripts/release.sh` refuses otherwise. Don't commit or stash the user's work on your own; ask.
- If `main` is ahead of `origin/main`, those commits ship in this release too; mention them in the notes.
- The secrets should be `CSC_LINK`, `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` and `SPARKLE_PRIVATE_KEY` (`CSC_KEY_PASSWORD` only if the `.p12` has a password; the current one doesn't).
- The Developer ID certificate expires **Feb 1, 2027**. Near or past that, stop and tell the user to renew it and update `CSC_LINK`.
- The build uses the committed `Gull.xcodeproj`. If `project.yml` changed since the project was last generated, run `xcodegen generate` and commit it first (`git status` after generating shows whether it was stale).

Run the tests before releasing; don't release on a failure:

```bash
xcodebuild -project Gull.xcodeproj -scheme Gull -derivedDataPath build/DerivedData test 2>&1 | grep -E "Test run|TEST (SUCC|FAIL)"
```

## 2. Pick the version

The last tag is the last release. With no tags, this is the first native release: suggest the version in `project.yml` (`3.0.0`, the successor to the Electron app's 2.x). Suggest the next one from what changed: patch for fixes, minor for features, major for breaking changes (a `!` or `BREAKING CHANGE:` commit). Let the user decide. The build number is the commit count on `main` and is set automatically; Sparkle compares it, so never release from another branch.

## 3. Draft the notes

```bash
last=$(git describe --tags --abbrev=0 2>/dev/null); git log --no-merges --format='%h %s' ${last:+$last..}HEAD
```

Commits follow Conventional Commits (`feat(scope): …`, `fix: …`). Turn them into a short list for readers, not developers. Each line becomes a bullet in Sparkle's "new version available" window and on the GitHub release:

- One `- ` line per user-visible change, in plain words ("Highlights now merge when they overlap", not "fix(highlights): merge overlapping ranges").
- Mostly from `feat`, `fix` and `perf`; leave out `refactor`, `test`, `build`, `ci`, `chore` and `chore: release v…` commits unless they change something a reader notices.

Write the notes to a file in your scratchpad. Then confirm the version and the notes together with an AskUserQuestion popup, not a question in text: the recommended version first, with the notes as its preview, an alternative version if one is plausible, and "Don't release yet".

## 4. Release

```bash
scripts/release.sh <version> <notes.md>
```

This sets `MARKETING_VERSION`, regenerates the Xcode project, commits `chore: release v<version>` (unless that's already the version), makes an annotated tag with the notes as its message (the workflow reads them from there), and pushes `main` and the tag.

`LOCAL=1` builds and publishes from this Mac instead. Use it only if the user asks or the workflow can't run. For signing and notarizing locally, the credentials are in `~/Library/CloudStorage/Dropbox/Secure/apple_no_certifications_password/` (`DEVELOPER_ID="Developer ID Application: LI ZHONG (5P9ZHW7578)"`, `APPLE_API_KEY_PATH` = the `AuthKey_C9X9XHN78Y.p8` there, `APPLE_API_KEY_ID=C9X9XHN78Y`, `APPLE_API_ISSUER` from `ASC_ISSUER_ID.txt`). Read the issuer into the variable with `$(tr -d '[:space:]' < …)`; never print or `cat` those files. The Sparkle key comes from the login Keychain.

## 5. Watch the workflow

```bash
gh run list -R limboy/gull-native --workflow release.yml -L 1
gh run watch <run-id> -R limboy/gull-native --exit-status
```

Notarization usually takes a few minutes; the run notarizes twice (zip, then DMG). If a run fails:

```bash
gh run view <run-id> -R limboy/gull-native --log-failed | tail -60
```

- **Select Xcode / build errors about the SDK.** The runner's newest Xcode is too old for the project (macOS 26 SDK). Check `runs-on` against GitHub's current macOS images.
- **Swift package resolution.** Sparkle failed to download; usually transient.
- **Import signing certificate.** `CSC_LINK` is wrong or expired, or the `.p12` gained a password (set `CSC_KEY_PASSWORD`).
- **Notarization `Invalid`.** Fetch the log with `xcrun notarytool log <submission-id>` (with the API key), fix the signing in `scripts/build-release.sh`, and release again.
- **`sign_update` errors.** `SPARKLE_PRIVATE_KEY` is missing or not the key whose public half is `SUPublicEDKey` in `Gull/Info.plist`.
- **Transient (network, notary timeout).** `gh run rerun <run-id> --failed`.

If the build can't be fixed under the same tag and nothing was published, delete the tag (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`) after telling the user, fix the problem, and release again. Keep the `chore: release v…` commit; the next release bumps from there. Never delete or replace a release that's already published: users may have it. Ship a newer version instead.

## 6. Verify what users get

```bash
gh release view v<version> -R limboy/gull-native --json assets --jq '.assets[].name'
curl -sL https://github.com/limboy/gull-native/releases/latest/download/appcast.xml | grep -E 'shortVersionString|<sparkle:version>|enclosure'
```

The release needs `Gull-<version>.dmg`, `Gull-<version>.zip` and `appcast.xml`, and the latest appcast must name this version and link to this release's zip. Optionally confirm Gatekeeper accepts the download:

```bash
cd "$(mktemp -d)" && gh release download v<version> -R limboy/gull-native -p '*.zip' && ditto -x -k Gull-*.zip . && spctl -a -vv Gull.app
```

It should report `accepted` and `source=Notarized Developer ID`.
