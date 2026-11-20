# Wash

A macOS app that keeps a pulse on the residue a working day leaves behind, and lets you wash it off in one pass at the end of the day.

## What it recommends

Wash does not ask you to judge every file. It measures each one two ways and puts it in one of three groups.

- **Replaceable:** is there evidence you could get it again? A cache rebuilds itself. An installer or archive that macOS recorded as downloaded from a web address can be fetched again. A document, a photo, a folder of your files, or anything Wash cannot identify is treated as yours.
- **Dormant:** how long since anything touched it, against the limit for its kind. A folder is as fresh as the newest thing inside it.

| Group | Means | What happens |
|---|---|---|
| **Can go** | dormant, with evidence it is replaceable | moves to the Trash |
| **File away** | dormant, but yours | moves to your filing folder |
| **Leave for now** | not dormant yet, or moving it would gain nothing | nothing |

Each row shows the reasons ("Taken 30 days ago · no record of you opening it") and a percentage for how sure Wash is. Three buttons on the row overrule it.

| Kind | Dormant after | Can go when | Otherwise |
|---|---|---|---|
| **Screenshots** | 7 days | still under its default name, with no record of being opened | filed if you opened or renamed it |
| **Screen recordings** | 7 days | never | filed |
| **Installers** (`.dmg`, `.pkg`, `.xip`, `.iso`) | 3 days | downloaded from a web address | filed: it may be a disk image you made |
| **App caches** (`~/Library/Caches`, not Apple's) | 100 MB | always | |
| **Developer leftovers** | 7 days unused (Xcode builds), 100 MB (tool caches) | Xcode DerivedData and device support; simulator, npm, Gradle, Bun and known `~/.cache` tools | unknown `~/.cache` folders are left; model and login stores are not listed |
| **Stale downloads** | 30 days | archives and installers downloaded from a web address | everything else is filed |
| **Big and idle** (250 MB+) | 60 days | archives and disk images downloaded from a web address | filed only if the filing folder is on another disk, where that frees space; otherwise left |

Screenshots are the one case that goes without proof of a second copy; that is what they are for. If you would rather keep them, raise their limit in Settings or switch the kind off.

**Filing.** The filing folder is `~/Documents/Filed Away` unless you choose another in Settings. Clutter is sorted as `Kind/2026-11/name`. A big file keeps its place, as `Big and idle/Documents/Clients/Acme/name`, so where it came from is not lost. Nothing is overwritten. Wash never looks inside the filing folder; if you choose a place it scans, such as Documents itself, it files into a `Filed Away` folder there.

**Last check.** Just before anything moves, Wash looks at it again. If it is gone or was modified after the scan, it stays put and the report says so.

The rules live in `Sources/RinseCore/Judge.swift`.

## Desktop and Downloads cleanup

Wash checks the top level of both folders for common leftovers from downloading and testing apps.

- **Duplicate archives.** A numbered copy such as `Daybreak (1).zip` can go when the archive beside it matches byte for byte. Wash retains the original and checks the match again before moving the copy.
- **Older build archives.** Clearly versioned ZIP or DMG files such as `Atrium-Pose-Preview-4-Mac.zip` appear under **Leave for now** when Wash finds two higher versions from the same series and format. Use the section menu’s **Select Older Builds to Wash** to queue them together. Wash checks that the two newer archives are still present before moving each old build.
- **Empty folders.** Loose folders that are empty and have gone at least seven days without changes appear under **Leave for now**. Choose Wash for any you no longer need. Wash checks for hidden files too and rechecks immediately before moving a folder.

The build scan checks archive structure and version names. Keep any build you need for rollback or testing. App bundles, extracted project folders, and split archive parts stay out of these suggestions. Files go to the Trash, where Finder can put them back.

## How it behaves

- It is a regular app: an icon in the Dock, one window, the usual menus. The Dock icon carries a badge with the amount ready to wash off.
- Closing the window leaves Wash running so the reminder and the badge keep working. Click the Dock icon to bring the window back; Quit with ⌘Q.
- A drop in the menu bar shows the same amount with a per-category breakdown. Settings can switch it off.
- At the time you set (9:30 pm to start) it sends one notification. Click it, look the three groups over, press the button.
- Washing moves things to the Trash. Nothing is deleted, and Finder's Put Back works. The space comes back when the Trash is emptied, which Wash offers afterwards and asks about first.
- Right-click a row for Show in Finder, or **Never Show This Again**.
- Wash only ever moves things that sit inside a folder in your home folder, and inside `~/Library` only under Caches and Developer. That check is separate from the rules and runs on every item (`SafetyGuard` in `Sources/RinseCore/Washer.swift`).

## Build and run

Needs macOS 14 or later and the Xcode command line tools. No Xcode project.

```sh
cd apps/rinse
./scripts/build-app.sh --install
```

That builds `build/Wash.app`, copies it to `/Applications` and opens it. Wash uses the same bundle identifier and settings as Rinse. If you already have Rinse installed, quit it before opening Wash. Keep it in the Dock from the Dock icon's menu: Options, Keep in Dock. macOS asks once each for the Desktop, Downloads and Documents folders, and for notifications.

To try it without installing: `swift run Wash` (no notifications in that mode, since they need an app bundle).

The app is signed ad hoc, so each rebuild counts as a new app to macOS and the folder prompts come back.

## Layout

- `Sources/RinseCore` holds the scanner, the judge that makes the recommendations, the washer and filer, the safety guard and the wash ledger. It is plain Foundation and its tests also run on Linux: `swift test`.
- `Sources/Rinse` is the SwiftUI app: the main window, settings, the Dock badge, the menu bar panel, the evening reminder.
- `Support/Info.plist`, `Support/AppIcon.icns` (drawn in `AppIcon.svg`) and `scripts/build-app.sh` turn the binary into an app bundle.
