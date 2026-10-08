#!/bin/zsh
# Builds, signs, notarizes, and packages a Gull release for Sparkle.
#
#   scripts/release.sh 3.0.1 [release-notes.md]
#
# Needs a "Developer ID Application" certificate in the Keychain, Sparkle's
# EdDSA private key in the Keychain (created once with `generate_keys`), and
# these variables (a local .env file is loaded if present):
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#
# Produces dist/Gull-<version>.zip and dist/appcast.xml. Attach both to a
# GitHub release tagged v<version> on limboy/gull — the app's feed URL is
# .../releases/latest/download/appcast.xml, so every release carries the
# appcast, and generate_appcast keeps the previous entries in it.
set -euo pipefail

VERSION=${1:?usage: scripts/release.sh <version> [release-notes.md]}
NOTES=${2:-}
REPO=limboy/gull
ROOT=${0:A:h:h}
cd "$ROOT"
[[ -f .env ]] && set -a && source .env && set +a
: ${APPLE_ID:?} ${APPLE_APP_SPECIFIC_PASSWORD:?} ${APPLE_TEAM_ID:?}

BUILD=build/release
DIST=dist
SPARKLE_BIN=$BUILD/DerivedData/SourcePackages/artifacts/sparkle/Sparkle/bin
rm -rf $BUILD/Gull.xcarchive $BUILD/export
mkdir -p $BUILD $DIST

xcodegen generate >/dev/null
xcodebuild -resolvePackageDependencies -project Gull.xcodeproj -scheme Gull \
  -derivedDataPath $BUILD/DerivedData >/dev/null

# The public half of the Keychain key goes into Info.plist (SUPublicEDKey).
PUBLIC_KEY=$($SPARKLE_BIN/generate_keys -p)
# Sparkle compares CFBundleVersion, so it must only ever grow.
BUILD_NUMBER=$(git rev-list --count HEAD)

echo "▸ Archiving Gull $VERSION ($BUILD_NUMBER)"
xcodebuild archive -project Gull.xcodeproj -scheme Gull -configuration Release \
  -derivedDataPath $BUILD/DerivedData -archivePath $BUILD/Gull.xcarchive \
  MARKETING_VERSION=$VERSION CURRENT_PROJECT_VERSION=$BUILD_NUMBER \
  SPARKLE_PUBLIC_KEY=$PUBLIC_KEY \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="Developer ID Application" \
  DEVELOPMENT_TEAM=$APPLE_TEAM_ID OTHER_CODE_SIGN_FLAGS=--timestamp > $BUILD/archive.log 2>&1 \
  || { grep -E "error:" $BUILD/archive.log; echo "archive failed, see $BUILD/archive.log"; exit 1; }

cat > $BUILD/ExportOptions.plist <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath $BUILD/Gull.xcarchive \
  -exportPath $BUILD/export -exportOptionsPlist $BUILD/ExportOptions.plist >/dev/null

APP=$BUILD/export/Gull.app
ZIP=$DIST/Gull-$VERSION.zip

echo "▸ Notarizing"
ditto -c -k --keepParent $APP $BUILD/notarize.zip
xcrun notarytool submit $BUILD/notarize.zip --wait \
  --apple-id $APPLE_ID --password $APPLE_APP_SPECIFIC_PASSWORD --team-id $APPLE_TEAM_ID
xcrun stapler staple $APP
rm -f $ZIP && ditto -c -k --keepParent $APP $ZIP

echo "▸ Generating appcast"
FEED=$BUILD/feed
rm -rf $FEED && mkdir -p $FEED
# Start from the published appcast so earlier releases stay listed.
curl -fsL https://github.com/$REPO/releases/latest/download/appcast.xml -o $FEED/appcast.xml || rm -f $FEED/appcast.xml
cp $ZIP $FEED/
[[ -n $NOTES ]] && cp $NOTES $FEED/Gull-$VERSION.md
$SPARKLE_BIN/generate_appcast $FEED \
  --download-url-prefix https://github.com/$REPO/releases/download/v$VERSION/ \
  --embed-release-notes --maximum-deltas 0
cp $FEED/appcast.xml $DIST/appcast.xml

echo "✓ $ZIP and $DIST/appcast.xml are ready. Publish with:"
echo "  gh release create v$VERSION $ZIP $DIST/appcast.xml --repo $REPO${NOTES:+ --notes-file $NOTES}"
