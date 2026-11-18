import Foundation

/// Where to look. Everything hangs off the home folder so tests can point at a fake one.
public struct Locations: Equatable, Sendable {
    public var home: URL
    /// Where macOS saves screenshots when the owner moved it off the Desktop.
    public var screenshotFolder: URL?

    public init(home: URL, screenshotFolder: URL? = nil) {
        self.home = home
        self.screenshotFolder = screenshotFolder
    }
}

/// Reads the disk and applies the rules. It never changes anything.
public struct Scanner: Sendable {
    public let locations: Locations
    public let rules: Rules
    public let now: Date

    public init(locations: Locations, rules: Rules = Rules(), now: Date = Date()) {
        self.locations = locations
        self.rules = rules
        self.now = now
    }

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "tiff", "gif", "pdf"]
    static let movieExtensions: Set<String> = ["mov", "mp4", "m4v"]
    static let installerExtensions: Set<String> = ["dmg", "pkg", "mpkg", "xip", "iso"]
    /// Folders that are really one document. Rinse does not look inside them.
    static let packageExtensions: Set<String> = [
        "app", "photoslibrary", "fcpbundle", "imovielibrary", "tvlibrary", "musiclibrary",
        "logicx", "band", "xcodeproj", "xcworkspace", "playground", "bundle", "framework",
        "sparsebundle", "vmwarevm", "pvm", "utm", "key", "pages", "numbers", "rtfd",
    ]

    public func scan() -> ScanResult {
        var collector = Collector(rules: rules)
        if isOn(.screenshots) || isOn(.recordings) { scanCaptures(&collector) }
        if isOn(.installers) { scanInstallers(&collector) }
        if isOn(.caches) { scanCaches(&collector) }
        if isOn(.developer) { scanDeveloper(&collector) }
        if isOn(.staleDownloads) { scanStaleDownloads(&collector) }
        if isOn(.bigIdle) { scanBigIdle(&collector) }
        return ScanResult(findings: collector.findings, scannedAt: now)
    }

    // MARK: - Categories

    private func scanCaptures(_ out: inout Collector) {
        var folders = [home("Desktop"), home("Movies"), home("Downloads")]
        if let custom = locations.screenshotFolder { folders.insert(custom, at: 0) }
        for item in folders.flatMap(children) where item.stat.isRegular {
            let ext = Self.fileExtension(item.name)
            let marked = FileStat.isMarkedScreenCapture(item.url.path)
            let age = days(since: item.stat.lastTouched)
            if isOn(.screenshots), Self.imageExtensions.contains(ext), marked || Self.isScreenshotName(item.name) {
                out.add(item, .screenshots, suggested: age >= rules.screenshotDays, reason: "Taken " + ago(item.stat.lastTouched))
            } else if isOn(.recordings), Self.movieExtensions.contains(ext), marked || Self.isRecordingName(item.name) {
                out.add(item, .recordings, suggested: age >= rules.recordingDays, reason: "Recorded " + ago(item.stat.lastTouched))
            }
        }
    }

    private func scanInstallers(_ out: inout Collector) {
        for item in [home("Downloads"), home("Desktop")].flatMap(children)
        where Self.installerExtensions.contains(Self.fileExtension(item.name)) {
            let age = days(since: item.stat.lastTouched)
            out.add(item, .installers, suggested: age >= rules.installerDays, reason: "Downloaded " + ago(item.stat.lastTouched))
        }
    }

    private func scanCaches(_ out: inout Collector) {
        // Apple's own caches are left alone: several are protected and some are not really caches.
        let skipped: Set<String> = ["CloudKit", "FamilyCircle", "GeoServices"]
        for item in children(home("Library/Caches"))
        where !item.name.hasPrefix("com.apple.") && !skipped.contains(item.name) {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .caches, bytes: bytes, suggested: bytes >= rules.cacheSuggestBytes, reason: "Rebuilds on demand")
        }
    }

    private func scanDeveloper(_ out: inout Collector) {
        for item in children(home("Library/Developer/Xcode/DerivedData")) where item.stat.isDirectory {
            let age = days(since: item.stat.lastTouched)
            out.add(item, .developer, bytes: FileStat.treeBytes(item.url.path),
                    suggested: age >= rules.buildDays, reason: "Xcode build, last used " + ago(item.stat.lastTouched))
        }
        for folder in ["iOS DeviceSupport", "watchOS DeviceSupport", "tvOS DeviceSupport"] {
            for item in children(home("Library/Developer/Xcode/" + folder)) where item.stat.isDirectory {
                let age = days(since: item.stat.lastTouched)
                out.add(item, .developer, bytes: FileStat.treeBytes(item.url.path),
                        suggested: age >= rules.deviceSupportDays, reason: "Device symbols, last used " + ago(item.stat.lastTouched))
            }
        }
        let wholeFolders: [(path: String, label: String)] = [
            ("Library/Developer/CoreSimulator/Caches", "Simulator caches"),
            (".npm/_cacache", "npm cache"),
            (".gradle/caches", "Gradle caches"),
            (".bun/install/cache", "Bun cache"),
        ]
        for folder in wholeFolders {
            let url = home(folder.path)
            guard let stat = FileStat(path: url.path), stat.isDirectory else { continue }
            let bytes = FileStat.treeBytes(url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(Item(url: url, name: folder.label, stat: stat), .developer, bytes: bytes,
                    suggested: bytes >= rules.cacheSuggestBytes, reason: "Refills as you work")
        }
        for item in children(home(".cache"), includeHidden: true) where item.stat.isDirectory {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .developer, bytes: bytes, suggested: bytes >= rules.cacheSuggestBytes, reason: "Tool cache, refills as you work")
        }
    }

    private func scanStaleDownloads(_ out: inout Collector) {
        for item in children(home("Downloads")) {
            guard days(since: item.stat.lastTouched) >= rules.staleDownloadDays else { continue }
            out.add(item, .staleDownloads, bytes: FileStat.treeBytes(item.url.path),
                    suggested: false, reason: "Untouched since " + ago(item.stat.lastTouched))
        }
    }

    private func scanBigIdle(_ out: inout Collector) {
        for root in ["Desktop", "Downloads", "Movies", "Documents"].map(home) {
            guard let walker = FileManager.default.enumerator(
                at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { continue }
            while let url = walker.nextObject() as? URL {
                guard let stat = FileStat(path: url.path) else { continue }
                if stat.isDirectory {
                    let isPackage = Self.packageExtensions.contains(Self.fileExtension(url.lastPathComponent))
                    if isPackage || out.claims(url.path) { walker.skipDescendants() }
                    continue
                }
                guard stat.isRegular, stat.bytes >= rules.bigFileBytes,
                      days(since: stat.lastTouched) >= rules.bigFileIdleDays else { continue }
                out.add(Item(url: url, name: url.lastPathComponent, stat: stat), .bigIdle,
                        suggested: false, reason: "Idle since " + ago(stat.lastTouched))
            }
        }
    }

    // MARK: - Helpers

    struct Item {
        let url: URL
        let name: String
        let stat: FileStat
    }

    private func isOn(_ category: Residue) -> Bool { !rules.disabled.contains(category) }

    private func home(_ relative: String) -> URL { locations.home.appendingPathComponent(relative) }

    /// The visible items directly inside a folder. A folder that is missing or unreadable is simply empty.
    private func children(_ folder: URL) -> [Item] { children(folder, includeHidden: false) }

    private func children(_ folder: URL, includeHidden: Bool) -> [Item] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.sorted().compactMap { name in
            if !includeHidden && name.hasPrefix(".") { return nil }
            let url = folder.appendingPathComponent(name)
            guard let stat = FileStat(path: url.path) else { return nil }
            return Item(url: url, name: name, stat: stat)
        }
    }

    private func days(since date: Date) -> Int {
        max(0, Int(now.timeIntervalSince(date) / 86_400))
    }

    /// "today", "3 days ago", "4 months ago".
    func ago(_ date: Date) -> String {
        let d = days(since: date)
        switch d {
        case 0: return "today"
        case 1: return "yesterday"
        case ..<60: return "\(d) days ago"
        case ..<730: return "\(d / 30) months ago"
        default: return "\(d / 365) years ago"
        }
    }

    static func fileExtension(_ name: String) -> String {
        guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
        return name[name.index(after: dot)...].lowercased()
    }

    static func isScreenshotName(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["screenshot", "screen shot", "simulator screenshot", "simulator screen shot", "cleanshot"]
            .contains(where: lower.hasPrefix)
    }

    static func isRecordingName(_ name: String) -> Bool {
        let lower = name.lowercased()
        return ["screen recording", "simulator screen recording"].contains(where: lower.hasPrefix)
    }
}

/// Gathers findings so that each path is listed once, under the first category that claims it.
private struct Collector {
    let rules: Rules
    private(set) var findings: [Finding] = []
    private var claimed: Set<String> = []

    init(rules: Rules) { self.rules = rules }

    func claims(_ path: String) -> Bool { claimed.contains(path) || rules.ignored.contains(path) }

    mutating func add(_ item: Scanner.Item, _ category: Residue, bytes: Int64? = nil, suggested: Bool, reason: String) {
        let path = item.url.path
        guard !claims(path) else { return }
        claimed.insert(path)
        findings.append(Finding(
            url: item.url, name: item.name, category: category, bytes: bytes ?? item.stat.bytes,
            lastTouched: item.stat.lastTouched, isDirectory: item.stat.isDirectory,
            suggested: suggested, reason: reason))
    }
}
