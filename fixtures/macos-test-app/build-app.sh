#!/bin/bash
set -euo pipefail
fixture_root="$(cd "$(dirname "$0")" && pwd)"
swift build --package-path "$fixture_root" -c release
fixture_bin="$(swift build --package-path "$fixture_root" -c release --show-bin-path)"
fixture_app="$fixture_root/.build/MacOSComputerUseFixture.app"
mkdir -p "$fixture_app/Contents/MacOS" "$fixture_app/Contents/Resources"
install -m 755 "$fixture_bin/MacOSComputerUseFixture" "$fixture_app/Contents/MacOS/MacOSComputerUseFixture"
cp "$fixture_root/Sources/MacOSComputerUseFixture/FixtureMetadata.json" "$fixture_app/Contents/Resources/FixtureMetadata.json"
cat > "$fixture_app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.example.MacOSComputerUseFixture</string>
<key>CFBundleExecutable</key><string>MacOSComputerUseFixture</string>
<key>CFBundleName</key><string>MacOSComputerUseFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>15.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
plutil -lint "$fixture_app/Contents/Info.plist"
codesign --force --sign - "$fixture_app"
codesign --verify --strict "$fixture_app"
printf '%s\n' "$fixture_app"
