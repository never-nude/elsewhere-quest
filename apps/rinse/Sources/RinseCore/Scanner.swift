import Foundation

/// Where to look. Everything hangs off the home folder so tests can point at a fake one.
public struct Locations: Equatable, Sendable {
    public var home: URL
    /// Where macOS saves screenshots when the owner moved it off the Desktop.
    public var screenshotFolder: URL?
    /// Where filed items go. Rinse never looks inside it.
    public var archive: URL
    /// Where installed apps live. Read to spot old builds and spent installers; never changed.
    public var applications: [URL]
    /// Where code projects live. Searched a few levels deep for git repositories.
    public var projectRoots: [URL]

    public init(home: URL, screenshotFolder: URL? = nil, archive: URL? = nil,
                applications: [URL]? = nil, projectRoots: [URL]? = nil) {
        self.home = home
        self.screenshotFolder = screenshotFolder
        self.archive = Locations.filingFolder(chosen: archive, home: home, screenshotFolder: screenshotFolder)
        self.applications = applications
            ?? [URL(fileURLWithPath: "/Applications"), home.appendingPathComponent("Applications")]
        self.projectRoots = projectRoots
            ?? ["Developer", "Documents", "Desktop", "Projects", "Code", "src", "GitHub", "repos", "dev", "Sites"]
                .map(home.appendingPathComponent)
    }

    /// The folders Rinse looks through. The filing folder must never be one of them, or contain one.
    static func scanRoots(home: URL, screenshotFolder: URL?) -> [URL] {
        ["Desktop", "Downloads", "Movies", "Documents"].map(home.appendingPathComponent)
            + (screenshotFolder.map { [$0] } ?? [])
    }

    /// The folder filing really uses. If the owner picked a place Rinse scans (Documents, say),
    /// or one that contains such a place, a "Filed Away" folder inside it is used instead,
    /// so that filed things are never scanned again.
    public static func filingFolder(chosen: URL?, home: URL, screenshotFolder: URL? = nil) -> URL {
        guard let chosen else { return defaultArchive(home: home) }
        let path = chosen.standardizedFileURL.path
        let guarded = [home] + scanRoots(home: home, screenshotFolder: screenshotFolder)
        let clashes = guarded.contains { root in
            let rootPath = root.standardizedFileURL.path
            return rootPath == path || rootPath.hasPrefix(path == "/" ? "/" : path + "/")
        }
        return clashes ? chosen.appendingPathComponent("Filed Away") : chosen.standardizedFileURL
    }

    public static func defaultArchive(home: URL) -> URL {
        home.appendingPathComponent("Documents/Filed Away")
    }
}

/// Reads the disk and applies the rules. It never changes anything.
public struct Scanner: Sendable {
    public let locations: Locations
    public let rules: Rules
    public let now: Date
    /// Asks the system whether a file was ever opened. Nil when it cannot say.
    public let usage: @Sendable (URL) -> Usage?
    /// Says whether macOS recorded where a file was downloaded from.
    public let hasOrigin: @Sendable (URL) -> Bool
    /// Apps that are running or kept in the Dock. Rinse never recommends moving them.
    public let inUse: Set<String>

    public init(locations: Locations, rules: Rules = Rules(), now: Date = Date(),
                usage: @escaping @Sendable (URL) -> Usage? = { _ in nil },
                hasOrigin: (@Sendable (URL) -> Bool)? = nil, inUse: Set<String> = []) {
        self.locations = locations
        self.rules = rules
        self.now = now
        self.usage = usage
        self.hasOrigin = hasOrigin ?? { FileStat.hasOrigin($0.path) }
        self.inUse = Set(inUse.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
    }

    /// Tool folders in `~/.cache` known to hold nothing but a cache.
    static let pureCaches: Set<String> = [
        "pip", "uv", "yarn", "pnpm", "go-build", "pre-commit", "node-gyp", "Homebrew", "typescript",
        "puppeteer", "ms-playwright", "deno", "bazel", "ccache", "sccache", "electron", "cypress",
    ]
    /// Tool folders in `~/.cache` that hold models or logins. Rinse does not list them.
    static let notCaches: Set<String> = ["huggingface", "torch", "whisper", "lm-studio", "ollama", "gcloud"]

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
        let filingFreesSpace = FileStat.device(ofNearestExisting: locations.archive)
            != FileStat.device(ofNearestExisting: locations.home)
        var collector = Collector(rules: rules, now: now, usage: usage, hasOrigin: hasOrigin,
                                  filingFreesSpace: filingFreesSpace)
        // Order matters: an item is listed once, under the first kind that claims it,
        // so the passes with the strongest evidence go first.
        if isOn(.screenshots) || isOn(.recordings) { scanCaptures(&collector) }
        if isOn(.redundant) { scanRedundant(&collector) }
        if isOn(.installers) { scanInstallers(&collector) }
        if isOn(.caches) { scanCaches(&collector) }
        if isOn(.developer) { scanDeveloper(&collector) }
        if isOn(.projectBuilds) { scanProjects(&collector) }
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
            if isOn(.screenshots), Self.imageExtensions.contains(ext), marked || Self.isScreenshotName(item.name) {
                out.add(item, .screenshots, limit: .age(days: rules.screenshotDays),
                        lead: "Taken " + ago(item.stat.lastTouched), askUsage: true,
                        renamed: !Self.isScreenshotName(item.name))
            } else if isOn(.recordings), Self.movieExtensions.contains(ext), marked || Self.isRecordingName(item.name) {
                out.add(item, .recordings, limit: .age(days: rules.recordingDays),
                        lead: "Recorded " + ago(item.stat.lastTouched), askUsage: true,
                        renamed: !Self.isRecordingName(item.name))
            }
        }
    }

    private func scanInstallers(_ out: inout Collector) {
        for item in [home("Downloads"), home("Desktop")].flatMap(children)
        where item.stat.isRegular && Self.installerExtensions.contains(Self.fileExtension(item.name)) {
            out.add(item, .installers, limit: .age(days: rules.installerDays),
                    lead: "Last touched " + ago(item.stat.lastTouched))
        }
    }

    private func scanCaches(_ out: inout Collector) {
        // Apple's own caches are left alone: several are protected and some are not really caches.
        let skipped: Set<String> = ["CloudKit", "FamilyCircle", "GeoServices"]
        for item in children(home("Library/Caches"))
        where !item.name.hasPrefix("com.apple.") && !skipped.contains(item.name) {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .caches, bytes: bytes, limit: .size(bytes: rules.cacheSuggestBytes), lead: "App cache")
        }
    }

    private func scanDeveloper(_ out: inout Collector) {
        for item in children(home("Library/Developer/Xcode/DerivedData")) where item.stat.isDirectory {
            // The folder's own dates do not move when Xcode builds; these inner ones do.
            let touched = (["info.plist", "Logs/Build", "Build/Intermediates.noindex", "Index.noindex"]
                .compactMap { FileStat(path: item.url.appendingPathComponent($0).path)?.lastTouched }
                + [item.stat.lastTouched]).max() ?? item.stat.lastTouched
            out.add(item, .developer, bytes: FileStat.treeBytes(item.url.path), limit: .age(days: rules.buildDays),
                    lead: "Xcode build, last used " + ago(touched), touched: touched)
        }
        for folder in ["iOS DeviceSupport", "watchOS DeviceSupport", "tvOS DeviceSupport"] {
            for item in children(home("Library/Developer/Xcode/" + folder)) where item.stat.isDirectory {
                out.add(item, .developer, bytes: FileStat.treeBytes(item.url.path),
                        limit: .age(days: rules.deviceSupportDays),
                        lead: "Device symbols, last used " + ago(item.stat.lastTouched))
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
                    limit: .size(bytes: rules.cacheSuggestBytes), lead: "Tool cache")
        }
        for item in children(home(".cache"), includeHidden: true)
        where item.stat.isDirectory && !Self.notCaches.contains(item.name) {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .developer, bytes: bytes, limit: .size(bytes: rules.cacheSuggestBytes), lead: "Tool cache",
                    regenerable: Self.pureCaches.contains(item.name))
        }
    }

    private func scanStaleDownloads(_ out: inout Collector) {
        for item in children(home("Downloads")) {
            // Links and other oddities are not the owner's files; an app run from Downloads is in use.
            guard item.stat.isRegular || item.stat.isDirectory,
                  !(item.stat.isDirectory && Self.fileExtension(item.name) == "app"),
                  item.url.standardizedFileURL.path != locations.screenshotFolder?.standardizedFileURL.path,
                  days(since: item.stat.lastTouched) >= rules.staleDownloadDays else { continue }
            // A folder is as fresh as the newest thing inside it.
            let summary = FileStat.treeSummary(item.url.path)
            guard days(since: summary.newest) >= rules.staleDownloadDays else { continue }
            out.add(item, .staleDownloads, bytes: summary.bytes,
                    limit: .age(days: rules.staleDownloadDays),
                    lead: "Untouched since " + ago(summary.newest), askUsage: true, touched: summary.newest)
        }
    }

    private func scanBigIdle(_ out: inout Collector) {
        for root in ["Desktop", "Downloads", "Movies", "Documents"].map(home) {
            // Paths are built from the root, so they are spelled the same way as everywhere else in the scan.
            guard let walker = FileManager.default.enumerator(atPath: root.path) else { continue }
            while let relative = walker.nextObject() as? String {
                let url = root.appendingPathComponent(relative)
                guard let stat = FileStat(path: url.path) else { continue }
                let name = url.lastPathComponent
                if name.hasPrefix(".") {
                    if stat.isDirectory { walker.skipDescendants() }
                    continue
                }
                if stat.isDirectory {
                    let isPackage = Self.packageExtensions.contains(Self.fileExtension(name))
                    if isPackage || out.claims(url.path) || isArchive(url) { walker.skipDescendants() }
                    continue
                }
                guard stat.isRegular, stat.bytes >= rules.bigFileBytes,
                      days(since: stat.lastTouched) >= rules.bigFileIdleDays else { continue }
                out.add(Item(url: url, name: url.lastPathComponent, stat: stat), .bigIdle,
                        limit: .age(days: rules.bigFileIdleDays),
                        lead: "Idle since " + ago(stat.lastTouched), askUsage: true)
            }
        }
    }

    // MARK: - Helpers

    struct Item {
        let url: URL
        let name: String
        let stat: FileStat
    }

    func isOn(_ category: Residue) -> Bool { !rules.disabled.contains(category) }

    func home(_ relative: String) -> URL { locations.home.appendingPathComponent(relative) }

    /// The visible items directly inside a folder. A folder that is missing or unreadable is simply empty.
    func children(_ folder: URL) -> [Item] { children(folder, includeHidden: false) }

    func children(_ folder: URL, includeHidden: Bool) -> [Item] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return [] }
        return names.sorted().compactMap { name in
            if !includeHidden && name.hasPrefix(".") { return nil }
            let url = folder.appendingPathComponent(name)
            guard !isArchive(url), !holdsArchive(url), let stat = FileStat(path: url.path) else { return nil }
            return Item(url: url, name: name, stat: stat)
        }
    }

    /// True for the filing folder itself, however its path is spelled.
    func isArchive(_ url: URL) -> Bool {
        url.standardizedFileURL.path == locations.archive.standardizedFileURL.path
    }

    /// True for a folder with the filing folder somewhere inside it. Such a folder is never a finding.
    func holdsArchive(_ url: URL) -> Bool {
        locations.archive.standardizedFileURL.path.hasPrefix(url.standardizedFileURL.path + "/")
    }

    func days(since date: Date) -> Int {
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

/// Gathers findings so that each path is listed once, under the first category that claims it,
/// and asks the Judge what to recommend for each.
struct Collector {
    let rules: Rules
    let now: Date
    let usage: @Sendable (URL) -> Usage?
    let hasOrigin: @Sendable (URL) -> Bool
    let filingFreesSpace: Bool
    private(set) var findings: [Finding] = []
    private var claimed: Set<String> = []

    init(rules: Rules, now: Date, usage: @escaping @Sendable (URL) -> Usage?,
         hasOrigin: @escaping @Sendable (URL) -> Bool, filingFreesSpace: Bool) {
        self.rules = rules
        self.now = now
        self.usage = usage
        self.hasOrigin = hasOrigin
        self.filingFreesSpace = filingFreesSpace
    }

    func claims(_ path: String) -> Bool { claimed.contains(path) || rules.ignored.contains(path) }

    /// `lead` opens the reason line, for example "Taken 12 days ago".
    mutating func add(_ item: Scanner.Item, _ category: Residue, bytes: Int64? = nil, limit: Judge.Limit,
                      lead: String, askUsage: Bool = false, renamed: Bool = false, regenerable: Bool = true,
                      touched: Date? = nil, notes: [String] = [], redundancy: Judge.Redundancy? = nil,
                      keeps: URL? = nil) {
        let path = item.url.path
        guard !claims(path) else { return }
        claimed.insert(path)
        let size = bytes ?? item.stat.bytes
        let lastTouched = touched ?? item.stat.lastTouched
        var evidence = Judge.Evidence(
            kind: category, name: item.url.lastPathComponent, isDirectory: item.stat.isDirectory, bytes: size,
            idleDays: max(0, Int(now.timeIntervalSince(lastTouched) / 86_400)), limit: limit,
            hasOrigin: item.stat.isDirectory ? false : hasOrigin(item.url),
            usage: askUsage && !item.stat.isDirectory ? usage(item.url) : nil,
            filingFreesSpace: filingFreesSpace)
        evidence.renamed = renamed
        evidence.regenerable = regenerable
        evidence.redundancy = redundancy
        let judged = Judge.assess(evidence)
        findings.append(Finding(
            url: item.url, name: item.name, category: category, bytes: size,
            // Never earlier than the item's own date, so the last check before a move does not misfire.
            lastTouched: max(lastTouched, item.stat.modified), isDirectory: item.stat.isDirectory,
            assessment: Assessment(verdict: judged.verdict, confidence: judged.confidence,
                                   reasons: [lead] + judged.reasons + notes),
            keeps: keeps))
    }
}
