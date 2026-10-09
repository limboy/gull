#!/bin/zsh
# Builds a Gull release into dist/: the app zip (what Sparkle installs), a
# DMG to download and drag to Applications, and the Sparkle appcast.
#
#   scripts/build-release.sh 3.0.0 [notes.md]
#
# Used by scripts/release.sh (LOCAL=1) and the Release workflow. Optional
# steps follow the environment:
#
#   DEVELOPER_ID   codesign identity, e.g. "Developer ID Application: …".
#                  Without it the app stays ad-hoc signed.
#   APPLE_API_KEY_ID, APPLE_API_ISSUER, and APPLE_API_KEY (the .p8's
#   contents) or APPLE_API_KEY_PATH
#                  notarize and staple with an App Store Connect API key
#                  (needs DEVELOPER_ID).
#   SPARKLE_PRIVATE_KEY
#                  the update-signing key; without it, sign_update uses the
#                  one in your Keychain.
#   BUILD_NUMBER   defaults to the commit count, which only goes up on main
#                  (Sparkle compares build numbers).
#
# For testing: BUNDLE_ID, FEED_URL and DOWNLOAD_BASE.
#
# Release notes come from the given Markdown file (one "- item" per line),
# or else from the commit subjects since the previous tag.
set -euo pipefail

cd "$(dirname "$0")/.."
version=${1:?usage: scripts/build-release.sh <version> [notes.md]}
notes_file=${2:-}
repo=limboy/gull
download_base=${DOWNLOAD_BASE:-https://github.com/$repo/releases/download/v$version}
build_number=${BUILD_NUMBER:-$(git rev-list --count HEAD)}
derived=build/release
dist=dist
sparkle_bin=$derived/SourcePackages/artifacts/sparkle/Sparkle/bin
mkdir -p $dist

# Notes, as Markdown for GitHub and HTML for Sparkle's window.
if [[ -n $notes_file ]]; then
  cp "$notes_file" $dist/notes.md
else
  previous=$(git describe --tags --abbrev=0 "v$version^" 2>/dev/null \
    || git describe --tags --abbrev=0 2>/dev/null || true)
  git log --no-merges --format='- %s' ${previous:+$previous..}HEAD | grep -v '^- chore: release v' > $dist/notes.md || true
fi

extra=()
[[ -n ${BUNDLE_ID:-} ]] && extra+=("PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID")
[[ -n ${FEED_URL:-} ]] && extra+=("SPARKLE_FEED_URL=$FEED_URL")
xcodebuild -project Gull.xcodeproj -scheme Gull -configuration Release \
  -derivedDataPath $derived -clonedSourcePackagesDirPath $derived/SourcePackages \
  MARKETING_VERSION="$version" CURRENT_PROJECT_VERSION="$build_number" "${extra[@]}" \
  build | grep -E "error:|BUILD" || true
app=$derived/Build/Products/Release/Gull.app
[[ -d $app ]] || { echo "Build failed." >&2; exit 1; }

if [[ -n ${DEVELOPER_ID:-} ]]; then
  # Inside out, as Sparkle's docs lay out, with the hardened runtime and a
  # secure timestamp that notarization requires.
  sign=(codesign --force --options runtime --timestamp --sign "$DEVELOPER_ID")
  sparkle=$app/Contents/Frameworks/Sparkle.framework/Versions/B
  $sign $sparkle/XPCServices/Installer.xpc
  $sign --preserve-metadata=entitlements $sparkle/XPCServices/Downloader.xpc
  $sign $sparkle/Autoupdate
  $sign $sparkle/Updater.app
  $sign $app/Contents/Frameworks/Sparkle.framework
  $sign --entitlements Gull/Gull.entitlements $app
  codesign --verify --deep --strict $app
fi

zip=$dist/Gull-$version.zip
rm -f $zip
ditto -c -k --sequesterRsrc --keepParent $app $zip

notarize=0
if [[ -n ${DEVELOPER_ID:-} && -n ${APPLE_API_KEY_ID:-} ]]; then
  notarize=1
  key_path=${APPLE_API_KEY_PATH:-}
  if [[ -z $key_path ]]; then
    key_path=$(mktemp -t notary).p8
    print -rn -- "$APPLE_API_KEY" > $key_path
    trap "rm -f $key_path" EXIT
  fi
fi
notarize_file() {
  xcrun notarytool submit $1 --wait \
    --key $key_path --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER"
}

if (( notarize )); then
  notarize_file $zip
  xcrun stapler staple $app
  # Zip again so the download carries the stapled ticket.
  rm -f $zip
  ditto -c -k --sequesterRsrc --keepParent $app $zip
fi

# The DMG: the (stapled) app and an Applications shortcut to drag it to.
dmg=$dist/Gull-$version.dmg
staging=$(mktemp -d)
ditto $app $staging/Gull.app
ln -s /Applications $staging/Applications
rm -f $dmg
hdiutil create -quiet -volname Gull -srcfolder $staging -format UDZO $dmg
rm -rf $staging
if [[ -n ${DEVELOPER_ID:-} ]]; then
  codesign --force --timestamp --sign "$DEVELOPER_ID" $dmg
fi
if (( notarize )); then
  notarize_file $dmg
  xcrun stapler staple $dmg
fi

# Prints: sparkle:edSignature="…" length="…"
if [[ -n ${SPARKLE_PRIVATE_KEY:-} ]]; then
  signature=$(print -rn -- "$SPARKLE_PRIVATE_KEY" | $sparkle_bin/sign_update --ed-key-file - $zip)
else
  signature=$($sparkle_bin/sign_update $zip)
fi

notes_html=$(sed -E 's/^[-*] +(.*)$/<li>\1<\/li>/' $dist/notes.md | grep '^<li>' || true)
cat > $dist/appcast.xml <<EOF
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Gull</title>
    <item>
      <title>Gull $version</title>
      <pubDate>$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')</pubDate>
      <sparkle:version>$build_number</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>26.0</sparkle:minimumSystemVersion>
      <description><![CDATA[<ul>
$notes_html
</ul>]]></description>
      <enclosure url="$download_base/Gull-$version.zip" type="application/octet-stream" $signature />
    </item>
  </channel>
</rss>
EOF

echo "Built $zip, $dmg and $dist/appcast.xml (Gull $version, build $build_number)."
