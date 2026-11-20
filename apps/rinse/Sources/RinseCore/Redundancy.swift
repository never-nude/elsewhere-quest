import Foundation

/// Leftovers that have another copy Rinse can point to. Unlike everything else, these do not have
/// to sit idle first: the evidence is the other copy, which is checked here and again just before
/// anything moves. Downloads, Documents and the Desktop are searched at every depth (see `Inventory`).
extension Scanner {
    func scanRedundant(_ inventory: Inventory, _ out: inout Collector) {
        let files = inventory.files.filter(isSettled)
        scanSplitArchives(files, &out)
        scanUnpackedArchives(files, &out)
        scanSupersededBuilds(inventory.apps, &out)
        scanSpentInstallers(files + inventory.apps.filter(isSettled), &out)
        for folder in landingFolders { scanDuplicateFolders(children(folder).filter(isSettled), &out) }
        scanDuplicateFiles(files, &out)
        scanUnfinishedDownloads(&out)
    }

    // MARK: - Archives

    private func scanUnpackedArchives(_ items: [Item], _ out: inout Collector) {
        for item in items where item.stat.isRegular && Self.fileExtension(item.name) == "zip" && !out.claims(item.url.path) {
            let path = item.url.path
            let folder = item.url.deletingLastPathComponent()
            guard let file = JoinedFile(paths: [path]),
                  let entries = FileStat.preservingAccessTime([path], { ZipIndex.entries(of: file) }),
                  let copy = ZipIndex.unpackedCopy(of: entries, archiveName: (item.name as NSString).deletingPathExtension,
                                                   in: folder, excluding: [item.url.standardizedFileURL.path])
            else { continue }
            out.add(item, .redundant, limit: .age(days: 0), lead: "Archive from " + ago(item.stat.lastTouched),
                    redundancy: .init(reason: "already unpacked as “\(Self.displayName(copy))”", certainty: 0.95),
                    keeps: copy)
        }
    }

    /// `name.part01`, `name.part02` … or `name.001`, `name.002` …: one archive cut into pieces.
    private func scanSplitArchives(_ items: [Item], _ out: inout Collector) {
        var sets: [String: [(number: Int, item: Item)]] = [:]
        for item in items where item.stat.isRegular {
            guard let (base, number) = Self.splitPart(item.name) else { continue }
            sets[item.url.deletingLastPathComponent().path + "/" + base, default: []].append((number, item))
        }
        for (key, parts) in sets {
            let folder = URL(fileURLWithPath: key).deletingLastPathComponent()
            let base = URL(fileURLWithPath: key).lastPathComponent
            let ordered = parts.sorted { $0.number < $1.number }
            // Every piece must be there, numbered from one with no gaps, or the archive cannot be read.
            guard ordered.count >= 2,
                  ordered.enumerated().allSatisfy({ $0.offset + 1 == $0.element.number }) else { continue }
            let paths = ordered.map(\.item.url.path)
            let name = Self.fileExtension(base) == "zip" ? (base as NSString).deletingPathExtension : base
            guard let file = JoinedFile(paths: paths),
                  let entries = FileStat.preservingAccessTime(paths, { ZipIndex.entries(of: file) }),
                  let copy = ZipIndex.unpackedCopy(of: entries, archiveName: name, in: folder)
            else { continue }
            for part in ordered {
                out.add(part.item, .redundant, limit: .age(days: 0), lead: "Piece \(part.number) of \(ordered.count)",
                        redundancy: .init(reason: "the archive is already unpacked as “\(Self.displayName(copy))”",
                                          certainty: 0.9),
                        keeps: copy)
            }
        }
    }

    static func splitPart(_ name: String) -> (base: String, number: Int)? {
        let ext = fileExtension(name)
        guard !ext.isEmpty else { return nil }
        let base = String(name.dropLast(ext.count + 1))
        guard !base.isEmpty else { return nil }
        if ext.hasPrefix("part"), ext.count > 4, let n = Int(ext.dropFirst(4)), n > 0 { return (base, n) }
        if ext.count == 3, ext.allSatisfy(\.isNumber), let n = Int(ext), n > 0 { return (base, n) }
        return nil
    }

    // MARK: - Apps

    struct AppBuild {
        let url: URL
        let id: String
        let version: String
        let short: [Int]
        let build: [Int]
        /// When the app was built: the newest date on its executable and Info.plist.
        let built: Date
        let installed: Bool
    }

    /// Reads an app's identity and version. Nil for anything that is not a complete app.
    func appBuild(_ url: URL, installed: Bool) -> AppBuild? {
        let plist = url.appendingPathComponent("Contents/Info.plist")
        guard let data = FileStat.preservingAccessTime([plist.path], { FileManager.default.contents(atPath: plist.path) }),
              let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
              let id = info["CFBundleIdentifier"] as? String, !id.isEmpty,
              let infoStat = FileStat(path: plist.path) else { return nil }
        let short = info["CFBundleShortVersionString"] as? String ?? ""
        let build = info["CFBundleVersion"] as? String ?? ""
        var built = infoStat.modified
        let executables = url.appendingPathComponent("Contents/MacOS")
        for name in (try? FileManager.default.contentsOfDirectory(atPath: executables.path)) ?? [] {
            if let st = FileStat(path: executables.appendingPathComponent(name).path) { built = max(built, st.modified) }
        }
        return AppBuild(url: url, id: id, version: short.isEmpty ? build : short,
                        short: Self.versionParts(short), build: Self.versionParts(build),
                        built: built, installed: installed)
    }

    static func versionParts(_ text: String) -> [Int] {
        text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    }

    /// Negative when `a` is older than `b`, zero for the same build, positive when newer.
    static func compare(_ a: AppBuild, _ b: AppBuild) -> Int {
        for (x, y) in [(a.short, b.short), (a.build, b.build)] {
            for i in 0..<max(x.count, y.count) {
                let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
                if l != r { return l < r ? -1 : 1 }
            }
        }
        // Same version numbers: a build made later is the newer one (most preview builds never bump them).
        if abs(a.built.timeIntervalSince(b.built)) < 1 { return 0 }
        return a.built < b.built ? -1 : 1
    }

    /// The installed apps, read once per scan.
    private func installedApps() -> [AppBuild] {
        locations.applications.flatMap { folder -> [AppBuild] in
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
            return names.filter { Self.fileExtension($0) == "app" }
                .compactMap { appBuild(folder.appendingPathComponent($0), installed: true) }
        }
    }

    /// Older builds of an app, when a newer build of the same app (same bundle identifier) is
    /// right beside it or installed in Applications.
    private func scanSupersededBuilds(_ apps: [Item], _ out: inout Collector) {
        var loose: [(build: AppBuild, item: Item)] = []
        for item in apps {
            if let build = appBuild(item.url, installed: false) { loose.append((build, item)) }
        }
        guard !loose.isEmpty else { return }
        let installed = installedApps()
        for id in Set(loose.map(\.build.id)) {
            let family = loose.map(\.build).filter { $0.id == id } + installed.filter { $0.id == id }
            guard family.count >= 2 else { continue }
            // The newest wins; on a tie the installed copy wins, since that is the one in use.
            let best = family.max { a, b in
                let order = Self.compare(a, b)
                return order != 0 ? order < 0 : (!a.installed && b.installed)
            }!
            for (build, item) in loose where build.id == id && build.url != best.url {
                guard isSettled(item), !out.claims(item.url.path) else { continue }
                let same = Self.compare(build, best) == 0
                let reason: String
                switch (same, best.installed) {
                case (true, true): reason = "the same build is installed in Applications"
                case (true, false): reason = "the same build as “\(Self.displayName(best.url))”"
                case (false, true): reason = "an older build; \(Self.versionLabel(best)) is installed in Applications"
                case (false, false): reason = "an older build; “\(Self.displayName(best.url))” is newer"
                }
                out.add(item, .redundant, limit: .age(days: 0), lead: Self.versionLabel(build),
                        redundancy: .init(reason: reason, certainty: 0.8), keeps: best.url)
            }
        }
    }

    private static func versionLabel(_ build: AppBuild) -> String {
        let name = displayName(build.url)
        return build.version.isEmpty ? name : "\(name) \(build.version)"
    }

    /// Kinds of file an installer comes as. A document called "Install Guide" is not one.
    static let installerTypes: Set<String> = ["app", "pkg", "mpkg", "dmg", "zip", "command", "sh", "tool"]

    /// Installers (`Install X`, `X Installer`, `X-Setup.zip` …) for an app that is already installed.
    private func scanSpentInstallers(_ items: [Item], _ out: inout Collector) {
        let apps = installedAppNames().map { (key: Self.productKey($0.name), url: $0.url) }
        guard !apps.isEmpty else { return }
        for item in items where !out.claims(item.url.path) && Self.installerTypes.contains(Self.fileExtension(item.name)) {
            let stem = (item.name as NSString).deletingPathExtension
            guard Self.words(stem).contains(where: Self.installerWords.contains) else { continue }
            let key = Self.productKey(stem)
            guard key.count >= 3, let app = apps.first(where: { $0.key == key }) else { continue }
            out.add(item, .redundant, limit: .age(days: 0), lead: "Installer from " + ago(item.stat.lastTouched),
                    redundancy: .init(reason: "\(Self.displayName(app.url)) is already installed", certainty: 0.8),
                    keeps: app.url)
        }
    }

    static let installerWords: Set<String> = ["install", "installer", "setup"]
    static let fillerWords: Set<String> = installerWords.union([
        "mac", "macos", "osx", "for", "the", "applications", "application", "app", "copy", "universal",
        "arm64", "x64", "x86", "intel", "apple", "silicon", "dmg", "pkg", "zip",
    ])

    static func words(_ text: String) -> [String] {
        text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    }

    /// "Install Atrium Pose", "Atrium-Pose-Installer 2" and "Atrium Pose" all become "atrium pose".
    static func productKey(_ name: String) -> String {
        words(name).filter { !fillerWords.contains($0) && !$0.allSatisfy(\.isNumber) }.joined(separator: " ")
    }

    // MARK: - Duplicates

    /// Exact copies of whole folders (or apps) sitting side by side in Downloads or on the Desktop.
    /// One copy stays: an app in use first, then the one without a "copy", " 2" or " (1)" in its
    /// name, then the oldest.
    private func scanDuplicateFolders(_ items: [Item], _ out: inout Collector) {
        var groups: [String: [Item]] = [:]
        for item in items where !out.claims(item.url.path) {
            if item.stat.isDirectory, let listing = FileStat.listing(item.url.path), !listing.isEmpty {
                let total = listing.reduce(Int64(0)) { $0 + $1.size }
                groups["d\(listing.count):\(total):\(listing.hashValue)", default: []].append(item)
            }
        }
        for group in groups.values where group.count >= 2 {
            let ordered = group.sorted { a, b in
                let ka = keeperRank(a), kb = keeperRank(b)
                return ka != kb ? ka < kb : a.name < b.name
            }
            var remaining = ordered
            while let keeper = remaining.first {
                remaining.removeFirst()
                var different: [Item] = []
                for other in remaining {
                    if !out.claims(other.url.path), !inUse.contains(other.url.standardizedFileURL.path),
                       FileStat.sameContents(keeper.url.path, other.url.path) {
                        out.add(other, .redundant, limit: .age(days: 0), lead: "Copy from " + ago(other.stat.lastTouched),
                                redundancy: .init(reason: "an exact copy of “\(Self.displayName(keeper.url))”", certainty: 0.95),
                                keeps: keeper.url)
                    } else {
                        different.append(other)
                    }
                }
                remaining = different
            }
        }
    }

    /// Exact copies of single files. A file inside an organised folder may be part of a set (a project,
    /// an album), so a copy goes only when it is loose in Downloads or on the Desktop, or is a "copy"
    /// of its twin in the same folder. The copy that stays is preferably the one already filed in Documents.
    private func scanDuplicateFiles(_ files: [Item], _ out: inout Collector) {
        let landing = Set(landingFolders.map { $0.standardizedFileURL.path })
        func isLoose(_ item: Item) -> Bool { landing.contains(item.url.deletingLastPathComponent().standardizedFileURL.path) }
        var bySize: [Int64: [Item]] = [:]
        for item in files where item.stat.isRegular && item.stat.size > 0 && !out.claims(item.url.path) {
            bySize[item.stat.size, default: []].append(item)
        }
        for group in bySize.values where group.count >= 2 && group.contains(where: { isLoose($0) || Self.isCopyName($0.name) }) {
            // Filed copies first, then names without "copy", then the oldest.
            let ordered = group.sorted { a, b in
                let ka = (isLoose(a) ? 1 : 0, keeperRank(a)), kb = (isLoose(b) ? 1 : 0, keeperRank(b))
                if ka.0 != kb.0 { return ka.0 < kb.0 }
                return ka.1 != kb.1 ? ka.1 < kb.1 : a.url.path < b.url.path
            }
            var keepers: [Item] = []
            for item in ordered {
                let folder = item.url.deletingLastPathComponent().standardizedFileURL.path
                let candidates = keepers.filter { keeper in
                    isLoose(item) || (Self.isCopyName(item.name)
                        && keeper.url.deletingLastPathComponent().standardizedFileURL.path == folder)
                }
                if !inUse.contains(item.url.standardizedFileURL.path),
                   let keeper = candidates.first(where: { FileStat.sameContents($0.url.path, item.url.path) }) {
                    let place = keeper.url.deletingLastPathComponent().standardizedFileURL.path == folder
                        ? "" : " in \(Self.placeName(keeper.url.deletingLastPathComponent(), home: locations.home))"
                    out.add(item, .redundant, limit: .age(days: 0), lead: "Copy from " + ago(item.stat.lastTouched),
                            redundancy: .init(reason: "an exact copy of “\(Self.displayName(keeper.url))”\(place)", certainty: 0.95),
                            keeps: keeper.url)
                } else {
                    keepers.append(item)
                }
            }
        }
    }

    /// "Documents/Taxes/2025", for showing where the copy that stays is.
    static func placeName(_ folder: URL, home: URL) -> String {
        let path = folder.standardizedFileURL.path, base = home.standardizedFileURL.path
        return path.hasPrefix(base + "/") ? String(path.dropFirst(base.count + 1)) : path
    }

    private func keeperRank(_ item: Item) -> (Int, Int, Double) {
        let used = inUse.contains(item.url.standardizedFileURL.path) ? 0 : 1
        let plain = Self.isCopyName(item.name) ? 1 : 0
        return (used, plain, max(item.stat.created, .distantPast).timeIntervalSince1970)
    }

    /// True for names Finder or a browser gives a second copy: "x copy", "x copy 2", "x (1)", "x 2".
    static func isCopyName(_ name: String) -> Bool {
        let stem = (name as NSString).deletingPathExtension
        let words = stem.split(separator: " ")
        guard words.count >= 2, let last = words.last else { return false }
        if last == "copy" { return true }
        if words.count >= 3, words[words.count - 2] == "copy", last.allSatisfy(\.isNumber) { return true }
        if last.hasPrefix("("), last.hasSuffix(")"), last.dropFirst().dropLast().allSatisfy(\.isNumber), last.count > 2 { return true }
        return last.allSatisfy(\.isNumber) && last.count <= 2
    }

    // MARK: - Unfinished downloads

    static let unfinishedExtensions: Set<String> = ["crdownload", "download", "part", "opdownload", "partial"]

    /// Downloads a browser gave up on, untouched for a day.
    private func scanUnfinishedDownloads(_ out: inout Collector) {
        for item in children(home("Downloads"))
        where Self.unfinishedExtensions.contains(Self.fileExtension(item.name)) && days(since: item.stat.lastTouched) >= 1 {
            out.add(item, .redundant, bytes: FileStat.treeBytes(item.url.path), limit: .age(days: 0),
                    lead: "Started " + ago(item.stat.lastTouched),
                    redundancy: .init(reason: "a download that never finished", certainty: 0.85))
        }
    }

    // MARK: - Names

    /// How Finder shows a name: apps without ".app".
    static func displayName(_ url: URL) -> String {
        fileExtension(url.lastPathComponent) == "app" ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent
    }
}
