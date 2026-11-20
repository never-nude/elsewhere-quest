import Foundation

/// Where to look. Everything hangs off the home folder so tests can point at a fake one.
public struct Locations: Equatable, Sendable {
    public var home: URL
    /// Where macOS saves screenshots when the owner moved it off the Desktop.
    public var screenshotFolder: URL?
    /// Where filed items go. Wash never looks inside it.
    public var archive: URL

    public init(home: URL, screenshotFolder: URL? = nil, archive: URL? = nil) {
        self.home = home
        self.screenshotFolder = screenshotFolder
        self.archive = Locations.filingFolder(chosen: archive, home: home, screenshotFolder: screenshotFolder)
    }

    /// The folders Wash looks through. The filing folder must never be one of them, or contain one.
    static func scanRoots(home: URL, screenshotFolder: URL?) -> [URL] {
        ["Desktop", "Downloads", "Movies", "Documents"].map(home.appendingPathComponent)
            + (screenshotFolder.map { [$0] } ?? [])
    }

    /// The folder filing really uses. If the owner picked a place Wash scans (Documents, say),
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
    private let archiveMatches: ArchiveMatchCache?

    public init(locations: Locations, rules: Rules = Rules(), now: Date = Date(),
                usage: @escaping @Sendable (URL) -> Usage? = { _ in nil },
                hasOrigin: (@Sendable (URL) -> Bool)? = nil, archiveMatches: ArchiveMatchCache? = nil) {
        self.locations = locations
        self.rules = rules
        self.now = now
        self.usage = usage
        self.hasOrigin = hasOrigin ?? { FileStat.hasOrigin($0.path) }
        self.archiveMatches = archiveMatches
    }

    /// Tool folders in `~/.cache` known to hold nothing but a cache.
    static let pureCaches: Set<String> = [
        "pip", "uv", "yarn", "pnpm", "go-build", "pre-commit", "node-gyp", "Homebrew", "typescript",
        "puppeteer", "ms-playwright", "deno", "bazel", "ccache", "sccache", "electron", "cypress",
    ]
    /// Tool folders in `~/.cache` that hold models or logins. Wash does not list them.
    static let notCaches: Set<String> = ["huggingface", "torch", "whisper", "lm-studio", "ollama", "gcloud"]

    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "tiff", "gif", "pdf"]
    static let movieExtensions: Set<String> = ["mov", "mp4", "m4v"]
    static let installerExtensions: Set<String> = ["dmg", "pkg", "mpkg", "xip", "iso"]
    /// Folders that are really one document. Wash does not look inside them.
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
        let desktop = home("Desktop"), downloads = home("Downloads")
        let desktopItems = children(desktop), downloadItems = children(downloads)
        scanFolderCleanup(in: desktop, items: desktopItems, &collector)
        scanFolderCleanup(in: downloads, items: downloadItems, &collector)
        if isOn(.screenshots) || isOn(.recordings) {
            let movies = home("Movies")
            let movieItems = children(movies)
            let customItems: [Item]
            switch locations.screenshotFolder?.standardizedFileURL.path {
            case desktop.standardizedFileURL.path: customItems = desktopItems
            case downloads.standardizedFileURL.path: customItems = downloadItems
            case movies.standardizedFileURL.path: customItems = movieItems
            default: customItems = locations.screenshotFolder.map(children) ?? []
            }
            for items in [customItems, desktopItems, movieItems, downloadItems] { scanCaptures(items, &collector) }
        }
        if isOn(.installers) {
            scanInstallers(downloadItems, &collector)
            scanInstallers(desktopItems, &collector)
        }
        if isOn(.caches) { scanCaches(&collector) }
        if isOn(.developer) { scanDeveloper(&collector) }
        if isOn(.staleDownloads) { scanStaleDownloads(downloadItems, &collector) }
        if isOn(.bigIdle) { scanBigIdle(&collector) }
        return ScanResult(findings: collector.findings, scannedAt: now)
    }

    // MARK: - Categories

    private func scanFolderCleanup(in folder: URL, items: [Item], _ out: inout Collector) {
        guard FileStat(path: folder.path)?.isDirectory == true else { return }
        let splitBases = Set(items.compactMap { FolderCleanup.splitArchiveBase(for: $0.name) })
        let files = items.filter { item in
            item.stat.isRegular && !FolderCleanup.isSplitArchive(item.name)
                && !splitBases.contains(item.name.lowercased())
        }
        let byName = Dictionary(uniqueKeysWithValues: files.map { ($0.name, $0) })
        for item in items where FolderCleanup.isSplitArchive(item.name) || splitBases.contains(item.name.lowercased()) {
            out.reserve(item)
        }
        for item in files {
            guard let name = FolderCleanup.originalName(of: item.name), let original = byName[name],
                  FolderCleanup.isMatchingCopy(item.url, of: original.url, cache: archiveMatches) else { continue }
            out.reserve(original)
            if isOn(.duplicateArchives) {
                out.addCleanup(item, .duplicateArchives, verdict: .wash,
                               reason: "Matches \(original.name) byte for byte", retaining: [original.url])
            } else {
                out.reserve(item)
            }
        }
        let builds = files.compactMap { item in FolderCleanup.build(named: item.name).map { (item, $0) } }
        for family in Dictionary(grouping: builds, by: { $0.1.family }).values {
            // Once a build series is identified, only the build rules may select any of its archives.
            let candidates = family.filter { !out.claims($0.0.url.path) }
            defer { for (item, _) in family { out.reserve(item) } }
            guard isOn(.olderBuildArchives), Set(candidates.map { $0.1.version }).count >= 3 else { continue }
            let valid = candidates.filter { item, _ in
                item.stat.linkCount == 1 && FolderCleanup.looksLikeArchive(item.url, expectedSize: item.stat.length)
                    && item.stat.sameFile(path: item.url.path)
            }
            let versions = Set(valid.map { $0.1.version }).sorted { $1.lexicographicallyPrecedes($0) }
            guard versions.count >= 3 else { continue }
            let retained = versions.prefix(2).compactMap { version in valid.first { $0.1.version == version }?.0 }
            for (item, build) in valid where !versions.prefix(2).contains(build.version) {
                out.addCleanup(item, .olderBuildArchives, verdict: .leave,
                               reason: "Older build · newer copies: \(retained.map(\.name).joined(separator: ", "))",
                               retaining: retained.map(\.url))
            }
        }
        for item in items where item.stat.isDirectory {
            guard !Self.packageExtensions.contains(Self.fileExtension(item.name)),
                  item.url.standardizedFileURL.path != locations.screenshotFolder?.standardizedFileURL.path,
                  FolderCleanup.isEmptyFolder(item.url) else { continue }
            if isOn(.emptyFolders), days(since: item.stat.modified) >= 7 {
                out.addCleanup(item, .emptyFolders, verdict: .leave, reason: "Empty and unchanged for at least 7 days")
            }
            out.reserve(item)
        }
    }

    private func scanCaptures(_ items: [Item], _ out: inout Collector) {
        for item in items where item.stat.isRegular && !out.claims(item.url.path) {
            let ext = Self.fileExtension(item.name)
            if isOn(.screenshots), Self.imageExtensions.contains(ext) {
                let defaultName = Self.isScreenshotName(item.name)
                guard defaultName || FileStat.isMarkedScreenCapture(item.url.path) else { continue }
                out.add(item, .screenshots, limit: .age(days: rules.screenshotDays),
                        lead: "Taken " + ago(item.stat.lastTouched), renamed: !defaultName)
            } else if isOn(.recordings), Self.movieExtensions.contains(ext) {
                let defaultName = Self.isRecordingName(item.name)
                guard defaultName || FileStat.isMarkedScreenCapture(item.url.path) else { continue }
                out.add(item, .recordings, limit: .age(days: rules.recordingDays),
                        lead: "Recorded " + ago(item.stat.lastTouched), renamed: !defaultName)
            }
        }
    }

    private func scanInstallers(_ items: [Item], _ out: inout Collector) {
        for item in items where item.stat.isRegular && Self.installerExtensions.contains(Self.fileExtension(item.name)) {
            out.add(item, .installers, limit: .age(days: rules.installerDays),
                    lead: "Last touched " + ago(item.stat.lastTouched))
        }
    }

    private func scanCaches(_ out: inout Collector) {
        // Apple's own caches are left alone: several are protected and some are not really caches.
        let skipped: Set<String> = ["CloudKit", "FamilyCircle", "GeoServices"]
        for item in children(home("Library/Caches"))
        where !item.name.hasPrefix("com.apple.") && !skipped.contains(item.name) && !out.claims(item.url.path) {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .caches, bytes: bytes, limit: .size(bytes: rules.cacheSuggestBytes), lead: "App cache")
        }
    }

    private func scanDeveloper(_ out: inout Collector) {
        for item in children(home("Library/Developer/Xcode/DerivedData")) where item.stat.isDirectory && !out.claims(item.url.path) {
            // The folder's own dates do not move when Xcode builds; these inner ones do.
            let touched = (["info.plist", "Logs/Build", "Build/Intermediates.noindex", "Index.noindex"]
                .compactMap { FileStat(path: item.url.appendingPathComponent($0).path)?.lastTouched }
                + [item.stat.lastTouched]).max() ?? item.stat.lastTouched
            out.add(item, .developer, bytes: FileStat.treeBytes(item.url.path), limit: .age(days: rules.buildDays),
                    lead: "Xcode build, last used " + ago(touched), touched: touched)
        }
        for folder in ["iOS DeviceSupport", "watchOS DeviceSupport", "tvOS DeviceSupport"] {
            for item in children(home("Library/Developer/Xcode/" + folder)) where item.stat.isDirectory && !out.claims(item.url.path) {
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
            guard !out.claims(url.path), let stat = FileStat(path: url.path), stat.isDirectory else { continue }
            let bytes = FileStat.treeBytes(url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(Item(url: url, name: folder.label, stat: stat), .developer, bytes: bytes,
                    limit: .size(bytes: rules.cacheSuggestBytes), lead: "Tool cache")
        }
        for item in children(home(".cache"), includeHidden: true)
        where item.stat.isDirectory && !Self.notCaches.contains(item.name) && !out.claims(item.url.path) {
            let bytes = FileStat.treeBytes(item.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(item, .developer, bytes: bytes, limit: .size(bytes: rules.cacheSuggestBytes), lead: "Tool cache",
                    regenerable: Self.pureCaches.contains(item.name))
        }
    }

    private func scanStaleDownloads(_ items: [Item], _ out: inout Collector) {
        let cutoff = rules.staleDownloadDays > 0 ? now.addingTimeInterval(-Double(rules.staleDownloadDays) * 86_400) : .distantFuture
        for item in items where !out.claims(item.url.path) {
            // Links and other oddities are not the owner's files; an app run from Downloads is in use.
            guard item.stat.isRegular || item.stat.isDirectory,
                  !(item.stat.isDirectory && Self.fileExtension(item.name) == "app"),
                  item.url.standardizedFileURL.path != locations.screenshotFolder?.standardizedFileURL.path,
                  let summary = FileStat.staleTreeSummary(item.url.path, top: item.stat, cutoff: cutoff) else { continue }
            out.add(item, .staleDownloads, bytes: summary.bytes,
                    limit: .age(days: rules.staleDownloadDays),
                    lead: "Untouched since " + ago(summary.newest), touched: summary.newest)
        }
    }

    private func scanBigIdle(_ out: inout Collector) {
        let archivePath = locations.archive.standardizedFileURL.path
        for root in ["Desktop", "Downloads", "Movies", "Documents"].map(home) {
            FileStat.walk(root.path, includeHidden: false) { path, name, stat in
                if stat.isDirectory {
                    let isPackage = Self.packageExtensions.contains(Self.fileExtension(name))
                    if isPackage || out.claims(path) || path == archivePath { return .skip }
                    return .descend
                }
                guard stat.isRegular, !out.claims(path), stat.bytes >= rules.bigFileBytes,
                      days(since: stat.lastTouched) >= rules.bigFileIdleDays else { return .skip }
                out.add(Item(url: URL(fileURLWithPath: path, isDirectory: false), name: name, stat: stat), .bigIdle,
                        limit: .age(days: rules.bigFileIdleDays), lead: "Idle since " + ago(stat.lastTouched))
                return .skip
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
            guard !isArchive(url), !holdsArchive(url), let stat = FileStat(path: url.path) else { return nil }
            return Item(url: url, name: name, stat: stat)
        }
    }

    /// True for the filing folder itself, however its path is spelled.
    private func isArchive(_ url: URL) -> Bool {
        url.standardizedFileURL.path == locations.archive.standardizedFileURL.path
    }

    /// True for a folder with the filing folder somewhere inside it. Such a folder is never a finding.
    private func holdsArchive(_ url: URL) -> Bool {
        locations.archive.standardizedFileURL.path.hasPrefix(url.standardizedFileURL.path + "/")
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

/// Gathers findings so that each path is listed once, under the first category that claims it,
/// and asks the Judge what to recommend for each.
private struct Collector {
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

    mutating func reserve(_ item: Scanner.Item) { claimed.insert(item.url.path) }

    mutating func addCleanup(_ item: Scanner.Item, _ category: Residue, verdict: Verdict,
                             reason: String, retaining: [URL] = []) {
        guard !claims(item.url.path) else { return }
        reserve(item)
        findings.append(Finding(url: item.url, name: item.name, category: category, bytes: item.stat.bytes,
                                lastTouched: item.stat.lastTouched, isDirectory: item.stat.isDirectory,
                                assessment: Assessment(verdict: verdict, confidence: verdict == .wash ? 100 : 50,
                                                       reasons: [reason]), retainedArchives: retaining))
    }

    /// `lead` opens the reason line, for example "Taken 12 days ago".
    mutating func add(_ item: Scanner.Item, _ category: Residue, bytes: Int64? = nil, limit: Judge.Limit,
                      lead: String, renamed: Bool = false, regenerable: Bool = true,
                      touched: Date? = nil) {
        let path = item.url.path
        guard !claims(path) else { return }
        claimed.insert(path)
        let size = bytes ?? item.stat.bytes
        let lastTouched = touched ?? item.stat.lastTouched
        let idleDays = max(0, Int(now.timeIntervalSince(lastTouched) / 86_400))
        let dormant: Bool
        switch limit {
        case .age(let days): dormant = idleDays >= max(1, days)
        case .size: dormant = false
        }
        let needsOrigin = category == .installers
            || (category == .staleDownloads || category == .bigIdle) && Judge.disposable.contains(Scanner.fileExtension(item.name))
        let needsUsage = (category == .screenshots || category == .recordings) && !renamed
        var evidence = Judge.Evidence(
            kind: category, name: item.url.lastPathComponent, isDirectory: item.stat.isDirectory, bytes: size,
            idleDays: idleDays, limit: limit,
            hasOrigin: dormant && needsOrigin && !item.stat.isDirectory && hasOrigin(item.url),
            usage: dormant && needsUsage ? usage(item.url) : nil,
            filingFreesSpace: filingFreesSpace)
        evidence.renamed = renamed
        evidence.regenerable = regenerable
        let judged = Judge.assess(evidence)
        findings.append(Finding(
            url: item.url, name: item.name, category: category, bytes: size,
            lastTouched: lastTouched, isDirectory: item.stat.isDirectory,
            assessment: Assessment(verdict: judged.verdict, confidence: judged.confidence,
                                   reasons: [lead] + judged.reasons)))
    }
}
