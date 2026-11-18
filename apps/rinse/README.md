# Rinse

A macOS app that keeps a pulse on the residue a working day leaves behind, and lets you wash it off in one pass at the end of the day.

It looks for:

| | Listed | Checked for you |
|---|---|---|
| **Screenshots** | every screen capture on the Desktop (or wherever you save them) | older than 7 days |
| **Screen recordings** | every screen recording | older than 7 days |
| **Installers** | `.dmg`, `.pkg`, `.xip`, `.iso` in Downloads and on the Desktop | older than 3 days |
| **App caches** | folders in `~/Library/Caches` over 5 MB (Apple's own are left alone) | over 100 MB |
| **Developer leftovers** | Xcode DerivedData and device support, simulator, npm, Gradle, Bun and `~/.cache` caches | builds unused for 7 days, caches over 100 MB |
| **Stale downloads** | anything in Downloads untouched for 30 days | never |
| **Big and idle** | files over 250 MB in Desktop, Downloads, Movies and Documents, idle for 60 days | never |

Every threshold is adjustable in Settings.

## How it behaves

- It is a regular app: an icon in the Dock, one window, the usual menus. The Dock icon carries a badge with the amount ready to wash off.
- Closing the window leaves Rinse running so the reminder and the badge keep working. Click the Dock icon to bring the window back; Quit with ⌘Q.
- A drop in the menu bar shows the same amount with a per-category breakdown. Settings can switch it off.
- At the time you set (9:30 pm to start) it sends one notification. Click it, look the list over, press **Wash Off**.
- Washing moves things to the Trash. Nothing is deleted, and Finder's Put Back works. The space comes back when the Trash is emptied, which Rinse offers afterwards and asks about first.
- Right-click a row for Show in Finder, or **Never Show This Again**.
- Rinse only ever moves things that sit inside a folder in your home folder, and inside `~/Library` only under Caches and Developer. That check is separate from the rules and runs on every item (`SafetyGuard` in `Sources/RinseCore/Washer.swift`).

## Build and run

Needs macOS 14 or later and the Xcode command line tools. No Xcode project.

```sh
cd apps/rinse
./scripts/build-app.sh --install
```

That builds `build/Rinse.app`, copies it to `/Applications` and opens it. Keep it in the Dock from the Dock icon's menu: Options, Keep in Dock. macOS asks once each for the Desktop, Downloads and Documents folders, and for notifications.

To try it without installing: `swift run Rinse` (no notifications in that mode, since they need an app bundle).

The app is signed ad hoc, so each rebuild counts as a new app to macOS and the folder prompts come back.

## Layout

- `Sources/RinseCore` holds the rules, the scanner, the safety guard and the wash ledger. It is plain Foundation and its tests also run on Linux: `swift test`.
- `Sources/Rinse` is the SwiftUI app: the main window, settings, the Dock badge, the menu bar panel, the evening reminder.
- `Support/Info.plist`, `Support/AppIcon.icns` (drawn in `AppIcon.svg`) and `scripts/build-app.sh` turn the binary into an app bundle.
