import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// One place on the disk worth knowing the size of, with what it is and how to make it smaller safely.
public struct Place: Hashable, Sendable, Identifiable {
    public enum Group: String, Sendable, Codable {
        case yours        // Desktop, Documents, Downloads …
        case apps         // what apps keep: backups, libraries, caches, app data
        case developer    // Xcode, simulators, Docker, models
        case system       // outside the home folder
    }

    public let id: String
    public let title: String
    public let group: Group
    /// Home-relative path. A last component like `*.photoslibrary` matches every such item in that folder.
    public let path: String
    public let explanation: String
    /// How to clear it safely, in plain words. Nil when it should just be left.
    public let howToClear: String?
    /// The Rinse kind that already cleans part of it, if any.
    public let cleanedBy: Residue?

    public init(id: String, title: String, group: Group, path: String, explanation: String,
                howToClear: String? = nil, cleanedBy: Residue? = nil) {
        self.id = id
        self.title = title
        self.group = group
        self.path = path
        self.explanation = explanation
        self.howToClear = howToClear
        self.cleanedBy = cleanedBy
    }

    /// The places Rinse always measures. Space in the home folder that falls in none of them is counted
    /// under the folder it is in (each app's own data folder is a place of its own, found as it walks).
    public static let known: [Place] = [
        Place(id: "desktop", title: "Desktop", group: .yours, path: "Desktop",
              explanation: "Everything on your Desktop.", cleanedBy: .staleDownloads),
        Place(id: "downloads", title: "Downloads", group: .yours, path: "Downloads",
              explanation: "Everything you downloaded and did not move elsewhere.", cleanedBy: .redundant),
        Place(id: "documents", title: "Documents", group: .yours, path: "Documents",
              explanation: "Your documents, including the Filed Away folder."),
        Place(id: "photos", title: "Photos library", group: .yours, path: "Pictures/*.photoslibrary",
              explanation: "The Photos app's library. With iCloud Photos, full-size originals may be kept on this Mac.",
              howToClear: "With iCloud Photos on, choose Photos › Settings › iCloud › Optimize Mac Storage: full originals stay in iCloud and the Mac keeps smaller copies. Deleting a photo in Photos also deletes it from iCloud and your other devices, and the space only comes back after Recently Deleted is emptied (30 days, or empty it by hand). Never delete anything inside the library in Finder."),
        Place(id: "pictures", title: "Other pictures", group: .yours, path: "Pictures",
              explanation: "Pictures outside the Photos library."),
        Place(id: "movies", title: "Movies", group: .yours, path: "Movies",
              explanation: "Videos, screen recordings, and video editing libraries.", cleanedBy: .bigIdle),
        Place(id: "music", title: "Music", group: .yours, path: "Music",
              explanation: "The Music app's library and any audio projects."),
        Place(id: "developer-folder", title: "Code projects", group: .yours, path: "Developer",
              explanation: "Projects kept in your Developer folder.", cleanedBy: .projectBuilds),
        Place(id: "icloud-drive", title: "iCloud Drive", group: .yours, path: "Library/Mobile Documents",
              explanation: "Files in iCloud Drive (and apps' iCloud folders) that are downloaded to this Mac. It grows when iCloud downloads files: when you open them, choose Keep Downloaded, turn off Optimize Mac Storage, or join a shared folder.",
              howToClear: "Do not delete these files to save space: deleting removes them from iCloud and from all your devices. To free space but keep a file in iCloud, Control-click it in Finder › iCloud Drive and choose Remove Download. To let macOS do this by itself, turn on Optimize Mac Storage in System Settings › your name › iCloud."),
        Place(id: "trash", title: "Trash", group: .yours, path: ".Trash",
              explanation: "What you, or Rinse, moved to the Trash. It still takes space until the Trash is emptied.",
              howToClear: "Look it over in Finder, then choose Empty Trash. This cannot be undone."),

        Place(id: "ios-backups", title: "iPhone and iPad backups", group: .apps,
              path: "Library/Application Support/MobileSync/Backup",
              explanation: "Full backups of your iPhone or iPad, made when it is connected to this Mac. One backup is often 20 to 100 GB, and a new one can appear in one go.",
              howToClear: "Open System Settings › General › Storage, then the info button next to iOS Files, to see every backup by device and date (the device does not need to be connected). Before deleting a device's backup, check on that device under Settings › your name › iCloud › iCloud Backup that its last backup is recent. Keep archived backups and backups of devices you no longer have unless you are sure you will never need them: they may be the only copy. Deleting a backup cannot be undone."),
        Place(id: "ios-updates", title: "iPhone software updates", group: .apps,
              path: "Library/iTunes/iPhone Software Updates",
              explanation: "iOS installers downloaded to update a device from this Mac.",
              howToClear: "Safe to delete once the device is updated."),
        Place(id: "messages", title: "Messages attachments", group: .apps, path: "Library/Messages",
              explanation: "Photos, videos and files sent and received in Messages.",
              howToClear: "System Settings › General › Storage › Messages (click the info button) lists large attachments, biggest first, so you choose which to delete. Deleting them cannot be undone, and with Messages in iCloud on they are also deleted from your iPhone, iPad and iCloud. Avoid the Keep messages setting in Messages: choosing 1 year or 30 days permanently deletes every older conversation, on all your devices."),
        Place(id: "mail", title: "Mail", group: .apps, path: "Library/Mail",
              explanation: "Downloaded mail and attachments.",
              howToClear: "Delete large messages in Mail, then empty Mail's trash. Removing files here directly would damage Mail's database."),
        Place(id: "caches", title: "App caches", group: .apps, path: "Library/Caches",
              explanation: "Data apps keep to work faster. Apps rebuild it when needed.",
              howToClear: "Rinse lists the big ones under App caches.", cleanedBy: .caches),
        Place(id: "claude", title: "Claude app data", group: .apps, path: "Library/Application Support/Claude",
              explanation: "The Claude desktop app's data, which can include a virtual machine image for running tasks on this Mac.",
              howToClear: "Manage it from inside the Claude app; do not delete it in Finder while the app is installed."),

        Place(id: "xcode-builds", title: "Xcode builds", group: .developer, path: "Library/Developer/Xcode/DerivedData",
              explanation: "Build products Xcode recreates on the next build.",
              howToClear: "Rinse lists old ones under Developer leftovers.", cleanedBy: .developer),
        Place(id: "xcode-archives", title: "Xcode archives", group: .developer, path: "Library/Developer/Xcode/Archives",
              explanation: "Signed builds you archived for release. Keep the ones you shipped if you need their crash symbols.",
              howToClear: "In Xcode, choose Window › Organizer, then Archives, and delete old ones there."),
        Place(id: "device-support", title: "Device support files", group: .developer, path: "Library/Developer/Xcode/iOS DeviceSupport",
              explanation: "Symbols Xcode copies from each iOS version you debug on. They are copied again when needed.",
              cleanedBy: .developer),
        Place(id: "simulators", title: "Simulators", group: .developer, path: "Library/Developer/CoreSimulator",
              explanation: "iOS, watchOS and visionOS simulators and their apps.",
              howToClear: "In Terminal: xcrun simctl delete unavailable — removes simulators for versions no longer installed."),
        Place(id: "docker", title: "Docker", group: .developer, path: "Library/Containers/com.docker.docker",
              explanation: "Docker Desktop's disk image, which holds every image, container and volume. Space only comes back after you remove things inside Docker. Deleting files here directly breaks Docker.",
              howToClear: "In Terminal, run docker system df to see what uses space. Safest first: docker builder prune removes build cache, which is rebuilt when needed. docker image prune -a removes images no container uses, including ones you built that cannot be downloaded again. docker system prune also deletes every stopped container and any data inside it that is not in a volume. Volumes go only with --volumes; check docker volume ls first, because databases usually live there. Avoid Docker Desktop › Troubleshoot › Clean / Purge data unless you mean to lose every image, container and volume."),
        Place(id: "ollama", title: "Ollama models", group: .developer, path: ".ollama",
              explanation: "Local AI models downloaded by Ollama. Each is several GB.",
              howToClear: "In Terminal: ollama list, then ollama rm <name> for models you no longer use."),
        Place(id: "huggingface", title: "Hugging Face models", group: .developer, path: ".cache/huggingface",
              explanation: "AI models and datasets downloaded by Python tools.",
              howToClear: "In Terminal: hf cache scan to see what is there, then hf cache delete to choose what to remove (older versions: huggingface-cli delete-cache)."),
        Place(id: "npm", title: "npm cache", group: .developer, path: ".npm",
              explanation: "Packages npm downloaded. They download again when needed.", cleanedBy: .developer),
    ]

    /// Folders whose children are each a place of their own, so one app's data growing stands out.
    /// The last two hold other apps' private data: macOS only lets Rinse look inside with Full Disk Access.
    static let appDataFolders: [(path: String, label: String, private: Bool)] = [
        ("Library/Application Support", "app data", false),
        ("Library/CloudStorage", "cloud storage", false),
        ("Library/Containers", "app container", true),
        ("Library/Group Containers", "shared app data", true),
    ]

    /// Folders macOS privacy protection guards. Without Full Disk Access they cannot be read.
    static let guarded = ["Library/Mail", "Library/Messages", "Library/Safari"]
}

/// One measuring of the home folder.
public struct Survey: Sendable {
    public struct Entry: Sendable, Identifiable {
        public let place: Place
        public let bytes: Int64
        /// Space in files created in the last week (not files that only changed: those may not have grown).
        public let newBytes: Int64
        /// True when macOS would not let Rinse look inside, so `bytes` is not the real size.
        public let uncounted: Bool
        public var id: String { place.id }
    }

    public struct RecentFile: Sendable, Identifiable {
        public let url: URL
        public let bytes: Int64
        public let date: Date
        /// The place it is in.
        public let placeID: String
        public var id: String { url.path }
    }

    public let measuredAt: Date
    public let entries: [Entry]
    /// Big files created in the last week, biggest first.
    public let newFiles: [RecentFile]
    /// Big files created earlier but written to in the last week (a database, a disk image). Their size is
    /// shown as it is now; how much they grew cannot be known from one look.
    public let updatedFiles: [RecentFile]
    /// Everything counted in the home folder.
    public let homeBytes: Int64
    /// The whole disk, when it could be read.
    public let disk: DiskSpace?
    /// True when the walk stopped early (an enormous home folder); totals are then too low.
    public let incomplete: Bool
    /// Places macOS would not let Rinse look inside (without Full Disk Access).
    public let unreadablePlaces: Set<String>

    public init(measuredAt: Date, entries: [Entry], newFiles: [RecentFile] = [], updatedFiles: [RecentFile] = [],
                homeBytes: Int64, disk: DiskSpace?, incomplete: Bool, unreadablePlaces: Set<String> = []) {
        self.measuredAt = measuredAt
        self.entries = entries
        self.newFiles = newFiles
        self.updatedFiles = updatedFiles
        self.homeBytes = homeBytes
        self.disk = disk
        self.incomplete = incomplete
        self.unreadablePlaces = unreadablePlaces
    }

    /// Used space on the disk that is not counted in the home folder: macOS, apps, other users, snapshots,
    /// and anything in the home folder Rinse could not read.
    public var outsideHome: Int64? { disk.map { max(0, $0.used - homeBytes) } }

    public func entry(_ id: String) -> Entry? { entries.first { $0.id == id } }

    /// Titles of the places that could not be read, for telling the owner.
    public var unreadableTitles: [String] {
        entries.filter { unreadablePlaces.contains($0.id) }.map(\.place.title).sorted()
    }
}

public struct DiskSpace: Codable, Equatable, Sendable {
    public let total: Int64
    public let available: Int64
    public var used: Int64 { max(0, total - available) }

    public init(total: Int64, available: Int64) {
        self.total = total
        self.available = available
    }

    /// The disk holding `path`, from the file system itself.
    public static func of(_ path: String) -> DiskSpace? {
        var info = statvfs()
        guard statvfs(path, &info) == 0 else { return nil }
        let block = Int64(info.f_frsize)
        return DiskSpace(total: Int64(info.f_blocks) * block, available: Int64(info.f_bavail) * block)
    }
}

/// Measures where the space in the home folder is, in one walk.
public struct Surveyor: Sendable {
    public let home: URL
    public let now: Date
    /// Files at least this big that changed in the last `recentDays` are listed by name.
    public var bigFileBytes: Int64 = 200_000_000
    public var recentDays = 7
    /// A safety stop for enormous home folders.
    public var budget = 6_000_000

    public init(home: URL, now: Date = Date()) {
        self.home = home
        self.now = now
    }

    /// Whether Rinse may read the folders macOS privacy protection guards. Nil means: find out by trying.
    public var fullDiskAccess: Bool?

    public func survey() -> Survey {
        let base = home.standardizedFileURL.path
        // Without Full Disk Access, macOS refuses Mail, Messages and Safari, and asks the owner before Rinse
        // looks inside other apps' containers. Rinse finds out quietly and does not go where it would ask.
        let access = fullDiskAccess ?? {
            let tries = Place.guarded.map { FileStat.canList(base + "/" + $0) }
            return tries.contains(true) || !tries.contains(false)
        }()
        var places: [String: Place] = [:]
        // Fixed places, plus one place for each app's data folder.
        var prefixes: [(prefix: String, glob: String?, id: String)] = []
        for place in Place.known {
            places[place.id] = place
            if place.path.contains("*") {
                let folder = (place.path as NSString).deletingLastPathComponent
                prefixes.append((base + "/" + folder + "/", "." + (place.path as NSString).pathExtension, place.id))
            } else {
                prefixes.append((base + "/" + place.path, nil, place.id))
            }
        }
        var unreadable = Set<String>()
        var skipped = Set<String>()
        for (folder, label, isPrivate) in Place.appDataFolders {
            let full = base + "/" + folder
            if isPrivate && !access {
                // One place for the whole folder, shown as not counted.
                let id = "private:" + folder
                places[id] = Place(id: id, title: folder.hasSuffix("Group Containers") ? "Shared app data" : "Other apps' containers",
                                   group: .apps, path: folder,
                                   explanation: "Data other apps keep privately. macOS only lets Rinse measure it with Full Disk Access.")
                prefixes.append((full, nil, id))
                if FileStat(path: full) != nil {
                    unreadable.insert(id)
                    skipped.insert(full)
                    // Docker lives in here: without access its size is not known either.
                    for place in Place.known where (base + "/" + place.path).hasPrefix(full + "/") { unreadable.insert(place.id) }
                }
                continue
            }
            for name in FileStat.names(in: full) ?? [] where !name.hasPrefix(".") {
                let path = full + "/" + name
                // A fixed place inside wins; Docker's container and Claude's data are named above.
                if prefixes.contains(where: { $0.glob == nil && (path == $0.prefix || path.hasPrefix($0.prefix + "/")) }) { continue }
                let id = "app:" + folder + "/" + name
                let cloud = folder.hasSuffix("CloudStorage")
                places[id] = Place(id: id, title: cloud ? Self.cloudTitle(name) : Self.appTitle(name), group: cloud ? .yours : .apps,
                                   path: folder + "/" + name,
                                   explanation: cloud ? "Files from \(Self.cloudTitle(name)) that are downloaded to this Mac."
                                                      : "Data the app keeps in \(label): \(name).",
                                   howToClear: cloud ? "Do not delete these to save space: that deletes them everywhere. In Finder, Control-click a file or folder and choose Remove Download (or Free Up Space) to keep it online only."
                                                     : "Clear it from inside the app, or remove the app first. Deleting another app's data in Finder can break it or lose settings.")
                prefixes.append((path, nil, id))
            }
        }
        for (path, title) in [("Library", "Other library data"), ("", "Everything else in your home folder")] {
            let id = path.isEmpty ? "home-other" : "library-other"
            places[id] = Place(id: id, title: title, group: path.isEmpty ? .yours : .apps, path: path,
                               explanation: path.isEmpty ? "Files and folders in your home folder outside the places above."
                                                         : "Settings, logs and data in your Library outside the places above.")
        }
        // Longest first, so the most specific place claims each file.
        prefixes.sort { $0.prefix.count > $1.prefix.count }
        // Places with another place somewhere inside them. Only inside those (and the catch-alls) does
        // a folder need looking up again; everywhere else it simply belongs to its parent's place.
        var hasInner: Set<String> = ["", "home-other", "library-other"]
        for outer in prefixes where outer.glob == nil {
            if prefixes.contains(where: { $0.id != outer.id && $0.prefix.hasPrefix(outer.prefix + "/") || ($0.glob != nil && $0.prefix == outer.prefix + "/") }) {
                hasInner.insert(outer.id)
            }
        }

        var bytes: [String: Int64] = [:]
        var newBytes: [String: Int64] = [:]
        var newFiles: [Survey.RecentFile] = []
        var updatedFiles: [Survey.RecentFile] = []
        var seenLinks = Set<UInt64>()
        let cutoff = now.addingTimeInterval(-Double(recentDays) * 86_400)
        var budget = self.budget
        let device = FileStat(path: base)?.device

        func place(for path: String) -> String {
            for p in prefixes {
                if let glob = p.glob {
                    guard path.hasPrefix(p.prefix) else { continue }
                    let rest = path.dropFirst(p.prefix.count)
                    let first = rest.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
                    if first.hasSuffix(glob) { return p.id }
                } else if path == p.prefix || path.hasPrefix(p.prefix + "/") {
                    return p.id
                }
            }
            return path.hasPrefix(base + "/Library/") ? "library-other" : "home-other"
        }

        func walk(_ folder: String, owner: String) {
            guard budget > 0 else { return }
            guard let names = FileStat.names(in: folder) else {
                if FileStat.canList(folder) == false { unreadable.insert(owner.isEmpty ? place(for: folder) : owner) }
                return
            }
            // A steady order, so a file with two names is always counted in the same place.
            for name in names.sorted() {
                budget -= 1
                guard budget > 0 else { return }
                let path = folder + "/" + name
                guard let st = FileStat(path: path) else { continue }
                // Only this disk: other volumes mounted inside the home folder are not this Mac's space.
                if let device, st.device != device { continue }
                // A folder belongs to its parent's place unless another place starts inside that one.
                let id = hasInner.contains(owner) ? place(for: path) : owner
                if st.isDirectory, skipped.contains(path) { continue }
                // A file with several names (a hard link) takes its space once.
                if st.isRegular, st.links > 1, !seenLinks.insert(st.inode).inserted { continue }
                bytes[id, default: 0] += st.bytes
                if st.isRegular {
                    if st.created >= cutoff {
                        newBytes[id, default: 0] += st.bytes
                        if st.bytes >= bigFileBytes {
                            newFiles.append(.init(url: URL(fileURLWithPath: path), bytes: st.bytes, date: st.created, placeID: id))
                        }
                    } else if st.modified >= cutoff, st.bytes >= bigFileBytes {
                        updatedFiles.append(.init(url: URL(fileURLWithPath: path), bytes: st.bytes, date: st.modified, placeID: id))
                    }
                }
                if st.isDirectory { walk(path, owner: id) }
            }
        }
        walk(base, owner: "")

        let entries = places.values
            .map { Survey.Entry(place: $0, bytes: bytes[$0.id] ?? 0, newBytes: newBytes[$0.id] ?? 0,
                                uncounted: unreadable.contains($0.id)) }
            .sorted { $0.bytes > $1.bytes }
        return Survey(measuredAt: now, entries: entries,
                      newFiles: Array(newFiles.sorted { $0.bytes > $1.bytes }.prefix(40)),
                      updatedFiles: Array(updatedFiles.sorted { $0.bytes > $1.bytes }.prefix(20)),
                      homeBytes: bytes.values.reduce(0, +), disk: DiskSpace.of(base),
                      incomplete: budget <= 0, unreadablePlaces: unreadable)
    }

    /// "Dropbox", "OneDrive-Personal", "GoogleDrive-name@example.com" become readable names.
    static func cloudTitle(_ folderName: String) -> String {
        let service = folderName.split(separator: "-").first.map(String.init) ?? folderName
        switch service.lowercased() {
        case "googledrive": return "Google Drive"
        case "onedrive": return "OneDrive"
        case "dropbox": return "Dropbox"
        case "box": return "Box"
        default: return service
        }
    }

    /// "com.apple.Notes" becomes "Notes"; "Google" stays "Google".
    static func appTitle(_ folderName: String) -> String {
        let parts = folderName.split(separator: ".")
        if parts.count >= 3, let last = parts.last { return String(last) }
        return folderName
    }
}

/// Sizes over time, so Rinse can say what grew and when.
public struct SpaceHistory: Codable, Equatable, Sendable {
    public struct Snapshot: Codable, Equatable, Sendable {
        public let date: Date
        public let sizes: [String: Int64]
        public let titles: [String: String]
        public let diskUsed: Int64?
        public let homeBytes: Int64
        /// Places that could not be read then. Missing in history saved by an earlier version.
        public let unreadable: [String]?
    }

    public private(set) var snapshots: [Snapshot] = []

    public init() {}

    /// Keeps one snapshot per day for 90 days, plus the newest of today.
    public mutating func record(_ survey: Survey, calendar: Calendar = .current) {
        guard !survey.incomplete else { return }
        let snapshot = Snapshot(date: survey.measuredAt,
                                sizes: Dictionary(uniqueKeysWithValues: survey.entries.map { ($0.id, $0.bytes) }),
                                titles: Dictionary(uniqueKeysWithValues: survey.entries.map { ($0.id, $0.place.title) }),
                                diskUsed: survey.disk?.used, homeBytes: survey.homeBytes,
                                unreadable: survey.unreadablePlaces.sorted())
        if let last = snapshots.last, calendar.isDate(last.date, inSameDayAs: snapshot.date) {
            snapshots[snapshots.count - 1] = snapshot
        } else {
            snapshots.append(snapshot)
        }
        let oldest = survey.measuredAt.addingTimeInterval(-90 * 86_400)
        snapshots.removeAll { $0.date < oldest }
    }

    /// The newest snapshot taken at least `age` before `now`.
    public func snapshot(olderThan age: TimeInterval, now: Date) -> Snapshot? {
        snapshots.last { $0.date <= now.addingTimeInterval(-age) }
    }

    public struct Change: Sendable, Identifiable, Equatable {
        public let id: String
        public let title: String
        public let before: Int64
        public let after: Int64
        public var delta: Int64 { after - before }
    }

    /// What grew (or shrank) between a past snapshot and a survey, biggest change first.
    /// Changes smaller than `threshold` are left out.
    public static func changes(from past: Snapshot, to survey: Survey, threshold: Int64 = 100_000_000) -> [Change] {
        var changes: [Change] = []
        let now = Dictionary(uniqueKeysWithValues: survey.entries.map { ($0.id, $0) })
        // A place that could not be read in either look has no real size to compare; giving Rinse
        // Full Disk Access would otherwise look like a sudden jump.
        let pastUnreadable = Set(past.unreadable ?? [])
        let blind = pastUnreadable.union(survey.unreadablePlaces)
        // Places found inside a folder that could not be read before (each app's container, once Rinse
        // has Full Disk Access) are new to Rinse, not new on the disk.
        let blindFolders = blind.filter { $0.hasPrefix("private:") }.map { "app:" + $0.dropFirst("private:".count) + "/" }
        for id in Set(past.sizes.keys).union(now.keys)
        where !blind.contains(id) && !blindFolders.contains(where: { id.hasPrefix($0) }) {
            let before = past.sizes[id] ?? 0, after = now[id]?.bytes ?? 0
            guard abs(after - before) >= threshold else { continue }
            changes.append(Change(id: id, title: now[id]?.place.title ?? past.titles[id] ?? id, before: before, after: after))
        }
        // What changed on the disk beyond what Rinse counted: macOS, snapshots, other users, and folders it
        // could not read. Only comparable when the same folders were unreadable both times.
        if let pastDisk = past.diskUsed, let disk = survey.disk, past.unreadable != nil, pastUnreadable == survey.unreadablePlaces {
            let before = max(0, pastDisk - past.homeBytes), after = max(0, disk.used - survey.homeBytes)
            if abs(after - before) >= threshold {
                let title = blind.isEmpty ? "Outside your home folder (macOS, snapshots, other users)"
                    : "Outside your home folder, or in folders Rinse cannot read"
                changes.append(Change(id: "outside-home", title: title, before: before, after: after))
            }
        }
        return changes.sorted { abs($0.delta) > abs($1.delta) }
    }

    public static func load(from url: URL) -> SpaceHistory {
        guard let data = try? Data(contentsOf: url),
              let history = try? JSONDecoder().decode(SpaceHistory.self, from: data) else { return SpaceHistory() }
        return history
    }

    public func save(to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(self).write(to: url, options: .atomic)
    }
}

/// Time Machine's local snapshots, from the names `tmutil listlocalsnapshots /` prints.
public enum LocalSnapshots {
    /// True when the listing shows macOS preparing a software update. The prepared update, and the
    /// snapshot of the current system it keeps, take space (often 10 GB or more) until the update is installed.
    public static func isPreparingUpdate(listing text: String) -> Bool {
        text.contains("com.apple.os.update-MSUPrepareUpdate")
    }

    /// Snapshots macOS keeps around a system update.
    public static func updateSnapshotCount(listing text: String) -> Int {
        text.split(whereSeparator: \.isNewline).filter { $0.contains("com.apple.os.update-") }.count
    }

    /// Dates of snapshots named like `com.apple.TimeMachine.2026-11-25-101530.local`.
    public static func dates(fromListing text: String) -> [Date] {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd-HHmmss"
        return text.split(whereSeparator: \.isNewline).compactMap { line in
            // Other tools (Carbon Copy Cloner, macOS updates) make snapshots too; only Time Machine's are counted.
            guard line.contains("com.apple.TimeMachine.") else { return nil }
            let parts = line.split(separator: ".")
            guard let stamp = parts.first(where: { $0.count == 17 && $0.first?.isNumber == true }) else { return nil }
            return formatter.date(from: String(stamp))
        }.sorted()
    }
}
