# Gesso iOS

The existing offline editor runs in a small SwiftUI/WKWebView app. Native import,
RAW development, Save to Photos, Share, Vision subject selection and haptics use
the API documented in [BRIDGE.md](../gesso/ios/BRIDGE.md). Architecture and release
choices are in [DESIGN.md](../gesso/ios/DESIGN.md).

The app identifier is `quest.elsewhere.gesso`. Its permanent storage origin is
`gesso://localhost`, entry `/gesso/`. Changing either requires an explicit migration.
No signing team is committed. The project supports iPhone on iOS 17 or later.

## Build

The generated `Gesso.xcodeproj` is checked in. XcodeGen is only needed after
editing `project.yml`:

```sh
xcodegen generate --spec apps/gesso-ios/project.yml
xcodebuild -project apps/gesso-ios/Gesso.xcodeproj -scheme Gesso \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/gesso-scratch/native-derived \
  CODE_SIGNING_ALLOWED=NO build
```

Every build copies `../gesso` into the app, verifies all service-worker SHELL
entries exist, and stamps a content hash. Development folders and package files
are excluded. The app skips service-worker registration; App Store updates carry
all executable web code. Python's standard library is the only copy-script dependency.

## Tests and diagnostics

Choose an installed Simulator from `xcrun simctl list devices available`:

```sh
xcodebuild -project apps/gesso-ios/Gesso.xcodeproj -scheme Gesso \
  -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath /tmp/gesso-scratch/native-derived \
  -resultBundlePath /tmp/gesso-scratch/native-tests.xcresult \
  CODE_SIGNING_ALLOWED=NO test
```

Native tests cover issued URLs, exact five-megabyte transfer bytes, duplicate
uploads, delayed deletion under a lease, input limits, EXIF normalization, PNG
dimensions, bundle MIME types, missing/traversal/symlink paths and stopped tasks.
Real WKWebView tests exercise the reply bridge, ArrayBuffer POST, module workers,
actual editor startup, JPEG worker encoding and storage across reload.

DEBUG launch arguments:

- `-GessoProbe`: open the existing capability page, including actual native rows.
- `-GessoSmoke`: run the real editor/bridge/5MB POST/JPEG-worker/storage smoke test,
  reload, then write `Documents/gesso-smoke.json`. It uses a separate diagnostic
  database and removes that database after checking reload. The runner does not
  access the photo library.
- `-GessoStubPicker` and `-GessoStubPhotos`: Simulator-only picker/save fixtures.

The smoke runner and stubs are excluded from Release builds. Unsupported Vision
inference on the Simulator is a device-validation item.

Validated on 2026-10-20 with Xcode 27.1: unsigned Debug and Release Simulator
builds, and nine passing XCTest cases on iOS 26.5. This includes the actual
EditorViewController navigation delegate, editor initialization, secure custom
origin, byte-exact 5MB ArrayBuffer POST, failed-upload consumption, module imports,
JPEG worker encoding, storage across reload, and EXIF orientation pixel checks.
The standalone DEBUG smoke report also passes with the bundled web content hash.
The host preserves the system's Lockdown policy; disabling it requires a
restricted browser entitlement and is not supported by this app.

## Paired iPhone

Use the owner's signing team and paired device shown by Xcode/devicectl:

```sh
xcrun devicectl list devices
xcodebuild -project apps/gesso-ios/Gesso.xcodeproj -scheme Gesso \
  -configuration Debug -destination 'platform=iOS,id=<device-UDID>' \
  -derivedDataPath /tmp/gesso-scratch/native-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<team-ID> build
xcrun devicectl device install app --device <device-ID> \
  /tmp/gesso-scratch/native-device/Build/Products/Debug-iphoneos/Gesso.app
xcrun devicectl device process launch --device <device-ID> \
  quest.elsewhere.gesso -- -GessoSmoke
xcrun devicectl device copy from --device <device-ID> \
  --domain-type appDataContainer --domain-identifier quest.elsewhere.gesso \
  --source Documents/gesso-smoke.json --destination /tmp/gesso-scratch/device-smoke.json
```

Launch without arguments after diagnostics to return to the normal editor.
Keep provisioning credentials and personal device details out of Git.

The 2026-10-20 signed-device attempt stopped at provisioning: Xcode has no
signed-in developer account and no matching development profile. The installed
development certificate alone is insufficient, and the existing local profile
does not match this app/device. Sign in through Xcode Settings → Accounts, then
retry the build above. No physical-device install or launch has been performed.

## Release checks

Verify real RAW/ProRAW appearance and peak memory, PHPicker cancellation and
representation choice, Photos add-only denial/retry, truthful Save/share status,
Vision selection and coordinates, haptics, keyboard/safe areas, background recovery,
and actual WebKit backup exclusion. Simulator coverage cannot establish those.
Check App Store name availability, App Privacy and WebKit/localStorage required
reason handling before submission. PrivacyInfo declares no tracking or collection
and no native required-reason API use. No TestFlight/App Store upload is automated.

The opaque 1024px icon is rendered from the existing Pigment Wheel SVG. To
regenerate it on macOS:

```sh
mkdir -p /tmp/gesso-scratch/native-icon
qlmanage -t -s 1024 -o /tmp/gesso-scratch/native-icon apps/gesso/icon-maskable.svg
swift apps/gesso-ios/scripts/make-icon.swift \
  /tmp/gesso-scratch/native-icon/icon-maskable.svg.png \
  apps/gesso-ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
```
