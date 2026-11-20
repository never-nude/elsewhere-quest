# Rinse

A macOS app that keeps a pulse on the residue a working day leaves behind, and lets you wash it off in one pass at the end of the day.

## What it recommends

Rinse does not ask you to judge every file. First it looks for things that are **redundant**: another copy is sitting right there. Those can go straight away, even if they arrived today:

| Redundant | Proof Rinse checks | The copy that stays |
|---|---|---|
| **Unpacked archive** (`Daybreak.zip`, `Wash-0.2.1.zip`) | every file and link in the archive is present unpacked beside it, with the same length and the same CRC-32 checksum; extra files in the unpacked copy are fine | the unpacked folder or app, including Finder's “Wash 2”, “Daybreak 3” names |
| **Split archive** (`Atrium-Pose.part01` … `part08`, `backup.zip.001` …) | every piece is present, numbered with no gaps, and the joined archive passes the same check | the unpacked copy |
| **Older build of an app** (`Atrium Pose Preview 7`) | same bundle identifier, name and executable as a newer build beside it or in Applications; newer means a higher version (a release beats its betas), or the same version built later. Skipped for template identifiers like `com.example.*`, for an app that is open (even from Downloads), and for a build you opened more recently than the newer one | the newest build |
| **Spent installer** (`Install Atrium Pose.dmg`, `Atrium-Pose-Installer.zip`) | a disk image, package, installer app, or a zip that holds one, whose name says install, installer or setup, and an app of that name is in Applications. Launch scripts (`.command`, `.sh`) only in Downloads. Never in Documents | the installed app |
| **Exact copy of a folder** (`Daybreak 2`) | side by side in Downloads or on the Desktop, byte for byte the same throughout | the one without “copy”, “(1)” or “ 2” in its name, else the oldest |
| **Exact copy of a file** (`Daybreak (1).zip`, `invoice.pdf` already filed in Documents, `Report copy.pdf`) | byte for byte the same; the copy that goes is loose in Downloads or on the Desktop, or is a “copy” of its twin in the same folder | the filed one in Documents first, then the plainest name, then the oldest |
| **Unfinished download** (`.crdownload`, `.download`, `.part`) | untouched for a day | nothing: it never finished |

Then two kinds of debris with nothing in them:

| | Can go when |
|---|---|
| **Empty folder** | nothing inside but other empty folders, and nothing in it changed for 7 days. Only the top-most folder of a nest is listed. Never Downloads, Documents or the Desktop themselves, the screenshot folder, the filing folder, a Finder-tagged folder, or a folder in Documents named after an installed app (Zoom and friends expect theirs). |
| **Dead file** | a link or Finder alias whose target is gone (not one pointing at a disk that is unplugged); a `._name` leftover from a USB drive whose `name` is gone; an Office `~$` lock file a day old while Office is closed; a zero-byte file untouched for 7 days. |

All of this covers Downloads, Documents and the Desktop at every depth (plus the screenshot folder, if it is elsewhere), but never goes inside a git project (its files belong together), an app or other package, a hidden folder, a dependency folder like `node_modules`, or the filing folder. Duplicate *files* inside organised folders are left alone on purpose: the same logo in two client folders is two folders that each need it. Nothing changed in the last ten minutes is touched (it may still be downloading or unpacking). An app that is running or kept in the Dock is never touched, and Applications is only read, never changed.

**The last check.** When you press the button, every item is checked again before anything moves, against what is on disk at that moment:
- the proof is run again: an archive's checksums against its unpacked copy, a duplicate's bytes against its twin, an old build against the newer app;
- a folder must not have changed anywhere inside, not only its own date;
- an app that is open or in the Dock right now stays;
- the copy that stays must still exist, must not be going in the same rinse, and must not have anything inside it going either. Rinse follows a chain (an archive unpacked as an old build, which a newer build replaces) and refuses if nothing would be left standing.

Anything that fails stays where it is, and the report says why.

Rinse also looks inside **code projects** (git repositories under Developer, Documents, Desktop, Projects, Code, src, GitHub, repos, dev and Sites) for dependency and build folders: `node_modules`, `.next`, `dist`, `build`, `.build`, `target`, `.venv`, `Pods`, `.gradle`. One is listed only when the file that recreates it exactly is beside it (a lockfile such as `package-lock.json` for `node_modules`, `uv.lock` or `requirements.txt` for `.venv`, `Package.swift`, `Cargo.toml` …) and the project's `.gitignore` names it, with no `!` line bringing it back. Submodules and nested projects are left alone. It can go once nothing in the project, the build folder included, has changed for 14 days, and the row says how to get it back (“comes back with npm install”).

Everything else is measured two ways and put in one of three groups.

- **Replaceable:** is there evidence you could get it again? A cache rebuilds itself. An installer or archive that macOS recorded as downloaded from a web address can be fetched again. A document, a photo, a folder of your files, or anything Rinse cannot identify is treated as yours.
- **Dormant:** how long since anything touched it, against the limit for its kind. A folder is as fresh as the newest thing inside it.

| Group | Means | What happens |
|---|---|---|
| **Can go** | dormant, with evidence it is replaceable | moves to the Trash |
| **File away** | dormant, but yours | moves to your filing folder |
| **Leave for now** | not dormant yet, or moving it would gain nothing | nothing |

Each row shows the reasons ("Taken 30 days ago · no record of you opening it") and a percentage for how sure Rinse is. Three buttons on the row overrule it.

| Kind | Dormant after | Can go when | Otherwise |
|---|---|---|---|
| **Screenshots** | 7 days | still under its default name, with no record of being opened | filed if you opened or renamed it |
| **Screen recordings** | 7 days | never | filed |
| **Installers** (`.dmg`, `.pkg`, `.xip`, `.iso`) | 3 days | downloaded from a web address | filed: it may be a disk image you made |
| **Redundant copies** | no wait | always, once the other copy is verified (above) | |
| **App caches** (`~/Library/Caches`, not Apple's) | 100 MB | always | |
| **Developer leftovers** | 7 days unused (Xcode builds), 100 MB (tool caches) | Xcode DerivedData and device support; simulator, npm, Gradle, Bun and known `~/.cache` tools | unknown `~/.cache` folders are left; model and login stores are not listed |
| **Project build folders** | 14 days since anything in the project changed | always, if recreatable and ignored by git | left while the project is in use |
| **Idle in Downloads and on the Desktop** | 30 days (a folder: since anything in it changed) | archives and installers downloaded from a web address | everything else is filed, as `From Downloads/2026-11/…` or `From Desktop/2026-11/…`; code projects on the Desktop are left |
| **Big and idle** (250 MB+) | 60 days | archives and disk images downloaded from a web address | filed only if the filing folder is on another disk, where that frees space; otherwise left |

Screenshots are the one case that goes without proof of a second copy; that is what they are for. If you would rather keep them, raise their limit in Settings or switch the kind off.

**Filing.** The filing folder is `~/Documents/Filed Away` unless you choose another in Settings. Clutter is sorted as `Kind/2026-11/name`. A big file keeps its place, as `Big and idle/Documents/Clients/Acme/name`, so where it came from is not lost. Nothing is overwritten. Rinse never looks inside the filing folder; if you choose a place it scans, such as Documents itself, it files into a `Filed Away` folder there.

**Last check.** Just before anything moves, Rinse looks at it again. If it is gone or was modified after the scan, it stays put and the report says so.

The rules live in `Sources/RinseCore/Judge.swift`.

## How it behaves

- It is a regular app: an icon in the Dock, one window, the usual menus. The Dock icon carries a badge with the amount ready to wash off.
- Closing the window leaves Rinse running so the reminder and the badge keep working. Click the Dock icon to bring the window back; Quit with ⌘Q.
- A drop in the menu bar shows the same amount with a per-category breakdown. Settings can switch it off.
- At the time you set (9:30 pm to start) it sends one notification. Click it, look the three groups over, press the button.
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

- `Sources/RinseCore` holds the scanner, the judge that makes the recommendations, the washer and filer, the safety guard and the wash ledger. It is plain Foundation and its tests also run on Linux: `swift test`.
- `Sources/Rinse` is the SwiftUI app: the main window, settings, the Dock badge, the menu bar panel, the evening reminder.
- `Support/Info.plist`, `Support/AppIcon.icns` (drawn in `AppIcon.svg`) and `scripts/build-app.sh` turn the binary into an app bundle.
