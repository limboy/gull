#!/bin/zsh
# Starts a Gull release.
#
#   scripts/release.sh 3.0.0 [notes.md]
#
# Sets the version in project.yml, commits it, tags v3.0.0 and pushes both.
# The Release workflow then builds, signs, notarizes and publishes it, with
# appcast.xml for Sparkle (the app's feed is the latest release's appcast).
#
# LOCAL=1 builds and publishes from this Mac instead (scripts/build-release.sh,
# signing updates with the Sparkle key in your Keychain); set DEVELOPER_ID
# and the APPLE_API_* variables to sign and notarize too.
#
# Release notes come from the given Markdown file (one "- item" per line),
# or else from the commit subjects since the last tag.
set -euo pipefail

cd "$(dirname "$0")/.."
version=${1:?usage: scripts/release.sh <version> [notes.md]}
notes_file=${2:-}
tag="v$version"

[[ -z $(git status --porcelain) ]] || { echo "Commit or stash your changes first." >&2; exit 1; }
[[ $(git branch --show-current) == main ]] || { echo "Release from main." >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$tag" >/dev/null && { echo "$tag already exists." >&2; exit 1; }
gh auth status >/dev/null

notes_args=()
if [[ -n $notes_file ]]; then
  # The workflow reads the notes from the tag's message.
  notes_args=(-F "$notes_file")
fi

sed -i '' -E "s/^( *MARKETING_VERSION: ).*/\1\"$version\"/" project.yml
xcodegen generate >/dev/null
# Already at this version (e.g. the first release): tag what's there.
if [[ -n $(git status --porcelain) ]]; then git commit -q -am "chore: release $tag"; fi
if (( ${#notes_args} )); then git tag -a "$tag" "${notes_args[@]}"; else git tag "$tag"; fi

if [[ ${LOCAL:-0} != 1 ]]; then
  git push -q origin main "$tag"
  echo "Pushed $tag; the Release workflow takes it from here:"
  echo "  https://github.com/limboy/gull/actions"
  exit 0
fi

scripts/build-release.sh "$version" $notes_file
git push -q origin main "$tag"
gh release create "$tag" dist/Gull-$version.dmg dist/Gull-$version.zip dist/appcast.xml \
  --title "Gull $version" --notes-file dist/notes.md
echo "Released Gull $version."
