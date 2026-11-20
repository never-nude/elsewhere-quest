import Foundation

/// Everything in Downloads, Documents and on the Desktop that the redundancy, empty-folder and
/// dead-file rules look at, gathered in one walk.
///
/// The walk never goes inside: git projects (their files belong together), app bundles and other
/// packages (one document each), hidden folders, dependency and build folders, and the filing folder.
struct Inventory {
    var files: [Scanner.Item] = []
    var links: [Scanner.Item] = []
    var apps: [Scanner.Item] = []
    /// The top-most folders that hold nothing (or only other empty folders), with the newest date in them.
    var empty: [(item: Scanner.Item, newest: Date)] = []
    /// The folders walked from, in order: Downloads, Desktop, Documents, then the screenshot folder.
    var roots: [URL] = []
}

extension Scanner {
    /// Downloads and the Desktop are where things land. Documents is where they are kept.
    var landingFolders: [URL] { [home("Downloads"), home("Desktop")] }

    func takeInventory() -> Inventory {
        var inventory = Inventory()
        var roots = [home("Downloads"), home("Desktop"), home("Documents")]
        if let shots = locations.screenshotFolder,
           !roots.contains(where: { shots.standardizedFileURL.path.hasPrefix($0.standardizedFileURL.path + "/") }) {
            roots.append(shots)
        }
        inventory.roots = roots
        var budget = 1_500_000
        // A top folder that is itself under version control (a whole Documents folder kept in git)
        // is somebody's project from the top down. Rinse leaves all of it.
        for root in roots where FileStat(path: root.path)?.isDirectory == true && !Self.isProject(root) {
            _ = walk(root, depth: 0, isRoot: true, into: &inventory, budget: &budget)
        }
        return inventory
    }

    /// Walks one folder. Returns whether it is empty (nothing in it but other empty folders and Finder's
    /// own `.DS_Store`), and the newest date in it, so the caller can report only the top-most empty folder.
    private func walk(_ folder: URL, depth: Int, isRoot: Bool, into inventory: inout Inventory,
                      budget: inout Int) -> (empty: Bool, newest: Date, emptyBelow: [(Item, Date)]) {
        guard let stat = FileStat(path: folder.path),
              let names = FileStat.names(in: folder.path) else {
            return (false, .distantFuture, [])
        }
        var empty = true
        var newest = stat.modified
        var emptyBelow: [(Item, Date)] = []
        for name in names {
            budget -= 1
            guard budget > 0 else { return (false, .distantFuture, []) }
            if name == ".DS_Store" || name == ".localized" { continue }
            let url = folder.appendingPathComponent(name)
            guard let st = FileStat(path: url.path) else {
                empty = false
                continue
            }
            let item = Item(url: url, name: name, stat: st)
            if st.isSymlink {
                inventory.links.append(item)
                empty = false
            } else if st.isRegular {
                inventory.files.append(item)
                empty = false
            } else if st.isDirectory {
                let ext = Self.fileExtension(name)
                if ext == "app" { inventory.apps.append(item) }
                let skip = name.hasPrefix(".") || Self.packageExtensions.contains(ext) || isArchive(url)
                    || Self.buildFolders.contains(where: { $0.name == name })
                    || Self.isVersioned(url) || Self.isSynced(url)
                guard !skip, depth < 14 else {
                    empty = false
                    continue
                }
                let inner = walk(url, depth: depth + 1, isRoot: false, into: &inventory, budget: &budget)
                newest = max(newest, inner.newest)
                // A folder someone or something relies on counts as content, so no nest above it is called empty.
                if inner.empty, !holdsArchive(url), !isProtected(url) {
                    emptyBelow.append((item, inner.newest))
                } else {
                    empty = false
                    inventory.empty.append(contentsOf: inner.emptyBelow.map { (item: $0.0, newest: $0.1) })
                }
            } else {
                empty = false
            }
        }
        if isRoot || !empty {
            inventory.empty.append(contentsOf: emptyBelow.map { (item: $0.0, newest: $0.1) })
            return (false, newest, [])
        }
        return (true, newest, emptyBelow)
    }

    /// Version-control markers. A folder with any of these is a working copy whose files belong together.
    static let versionMarkers = [".git", ".hg", ".svn", ".jj", "_darcs", ".fossil", ".bzr", "_FOSSIL_"]
    /// Markers sync clients leave in the folders they keep in step with other machines.
    static let syncMarkers = [".dropbox", ".dropbox.cache", ".tmp.drivedownload", ".tmp.driveupload", ".stfolder", ".sync"]

    static func isVersioned(_ folder: URL) -> Bool {
        versionMarkers.contains { FileStat(path: folder.appendingPathComponent($0).path) != nil }
    }

    static func isSynced(_ folder: URL) -> Bool {
        syncMarkers.contains { FileStat(path: folder.appendingPathComponent($0).path) != nil }
    }

    /// A code project, versioned or not: version control, a Python environment, or a build manifest at its top.
    static func isProject(_ folder: URL) -> Bool {
        if isVersioned(folder) { return true }
        let manifests = ["package.json", "Package.swift", "Cargo.toml", "go.mod", "pyproject.toml", "requirements.txt",
                         "setup.py", "Pipfile", "Gemfile", "Podfile", "build.gradle", "build.gradle.kts", "CMakeLists.txt",
                         "Makefile", "pom.xml", "composer.json", "mix.exs", "deno.json", "pyvenv.cfg", "Project.toml"]
        if manifests.contains(where: { FileStat(path: folder.appendingPathComponent($0).path) != nil }) { return true }
        let names = FileStat.names(in: folder.path) ?? []
        if names.contains(where: { ["xcodeproj", "xcworkspace", "sln", "uproject", "godot"].contains(fileExtension($0)) }) {
            return true
        }
        // A Python environment under any name (env, .env, virtualenv …).
        return names.contains { FileStat(path: folder.appendingPathComponent($0 + "/pyvenv.cfg").path) != nil }
    }

    /// Folders that must stay even when empty: the screenshot folder (or one holding it), and folders
    /// the owner tagged in Finder.
    func isProtected(_ folder: URL) -> Bool {
        let path = folder.standardizedFileURL.path
        if let shots = locations.screenshotFolder?.standardizedFileURL.path, shots == path || shots.hasPrefix(path + "/") {
            return true
        }
        return FileStat.hasTags(folder.path)
    }

    /// Settled: not changed in the last ten minutes, so not still downloading or unpacking,
    /// and not an app that is running or kept in the Dock.
    func isSettled(_ item: Item) -> Bool {
        let path = item.url.standardizedFileURL.path
        guard max(item.stat.modified, item.stat.created) <= now.addingTimeInterval(-600),
              !inUse.contains(where: { $0 == path || $0.hasPrefix(path + "/") }) else { return false }
        // An app opened from Downloads runs from a hidden copy, so check what it is, not just where.
        if item.stat.isDirectory, Self.fileExtension(item.name) == "app", !runningIDs.isEmpty,
           let id = Self.bundleID(of: item.url), runningIDs.contains(id) { return false }
        return true
    }

    // MARK: - Empty folders

    func scanEmptyFolders(_ inventory: Inventory, _ out: inout Collector) {
        let installedKeys = Set(installedAppNames().map { Self.productKey($0.name) }.filter { !$0.isEmpty })
        let documents = home("Documents").standardizedFileURL.path
        let shots = locations.screenshotFolder?.standardizedFileURL.path
        for (item, newest) in inventory.empty where !out.claims(item.url.path) {
            let path = item.url.standardizedFileURL.path
            // macOS saves screenshots here and an app may expect its own folder in Documents to exist.
            if path == shots { continue }
            if item.url.deletingLastPathComponent().standardizedFileURL.path == documents,
               installedKeys.contains(Self.productKey(item.name)) { continue }
            // A tagged folder is organisation the owner set up, waiting to be filled.
            if FileStat.hasTags(path) { continue }
            guard days(since: newest) >= rules.emptyDays else { continue }
            out.add(item, .empty, limit: .age(days: 0), lead: "Empty since " + ago(newest), touched: newest,
                    redundancy: .init(reason: "nothing in it", certainty: 0.9))
        }
    }

    // MARK: - Dead files

    func scanDeadFiles(_ inventory: Inventory, _ out: inout Collector) {
        let landing = Set(landingFolders.map { $0.standardizedFileURL.path })
        let officeOpen = inUse.contains { $0.hasSuffix("/Microsoft Word.app") || $0.hasSuffix("/Microsoft Excel.app")
            || $0.hasSuffix("/Microsoft PowerPoint.app") }
        for item in inventory.links where !out.claims(item.url.path) && isSettled(item) {
            guard case .broken = Self.linkState(item.url) else { continue }
            out.add(item, .dead, limit: .age(days: 0), lead: "Link",
                    redundancy: .init(reason: "points to something that no longer exists", certainty: 0.9))
        }
        for item in inventory.files where !out.claims(item.url.path) && isSettled(item) {
            let name = item.name
            let folder = item.url.deletingLastPathComponent()
            if name.hasPrefix("._"), name.count > 2 {
                // Left by copying from a USB drive. With its file gone, it describes nothing.
                guard FileStat(path: folder.appendingPathComponent(String(name.dropFirst(2))).path) == nil else { continue }
                out.add(item, .dead, limit: .age(days: 0), lead: "Hidden leftover",
                        redundancy: .init(reason: "the file it belonged to is gone", certainty: 0.95))
            } else if name.hasPrefix("~$"), item.stat.size < 4096 {
                guard !officeOpen, days(since: item.stat.lastTouched) >= 1 else { continue }
                out.add(item, .dead, limit: .age(days: 0), lead: "Office lock file",
                        redundancy: .init(reason: "left behind after the document was closed", certainty: 0.9))
            } else if item.stat.size == 0, !name.hasPrefix("."), name != "Icon\r" {
                // Only loose in Downloads or on the Desktop. Inside a folder an empty file is often a marker
                // its folder needs (`__init__.py`, `py.typed`), or a note whose name is the note.
                guard landing.contains(folder.standardizedFileURL.path), !Self.looksLikeMarker(name),
                      days(since: item.stat.modified) >= rules.emptyDays else { continue }
                out.add(item, .dead, limit: .age(days: 0), lead: "Untouched since " + ago(item.stat.modified),
                        redundancy: .init(reason: "an empty file: 0 bytes", certainty: 0.8))
            } else if Self.isBrokenAlias(item) {
                out.add(item, .dead, limit: .age(days: 0), lead: "Alias",
                        redundancy: .init(reason: "points to something that no longer exists", certainty: 0.85))
            }
        }
    }

    /// Names that mean something even when empty: code, markup, settings and well-known markers.
    static func looksLikeMarker(_ name: String) -> Bool {
        let markers: Set<String> = ["__init__.py", "py.typed", "REQUESTED", "INSTALLER", "LICENSE", "README", "CNAME",
                                    "Procfile", "Makefile", "Dockerfile", "keep", "placeholder"]
        if markers.contains(name) { return true }
        let code: Set<String> = ["py", "js", "ts", "jsx", "tsx", "swift", "rb", "go", "rs", "c", "h", "cpp", "java",
                                 "kt", "php", "css", "scss", "html", "json", "yml", "yaml", "toml", "ini", "cfg",
                                 "conf", "lock", "env", "sh", "md", "typed", "keep", "gitkeep"]
        return code.contains(fileExtension(name))
    }

    enum LinkState { case fine, broken, offline }

    /// A symbolic link whose target is missing. One that points at a disk that is not plugged in is
    /// not broken, only waiting.
    static func linkState(_ link: URL) -> LinkState {
        guard let target = try? FileManager.default.destinationOfSymbolicLink(atPath: link.path) else { return .fine }
        let resolved = target.hasPrefix("/") ? URL(fileURLWithPath: target)
            : link.deletingLastPathComponent().appendingPathComponent(target)
        let path = resolved.standardizedFileURL.path
        if path.hasPrefix("/Volumes/") || path.hasPrefix("/Network/") { return .offline }
        switch FileStat.reachability(resolved.path) {
        case .exists: return .fine
        case .missing: return .broken
        // There but out of reach (privacy protection, another app's container, a cloud folder): not broken.
        case .unreadable: return .offline
        }
    }

    /// A Finder alias whose original is gone, and not merely on a disk that is not connected.
    static func isBrokenAlias(_ item: Item) -> Bool {
        #if os(macOS)
        guard item.stat.size < 1_000_000, fileExtension(item.name).isEmpty,
              (try? item.url.resourceValues(forKeys: [.isAliasFileKey]))?.isAliasFile == true else { return false }
        if (try? URL(resolvingAliasFileAt: item.url, options: [.withoutUI, .withoutMounting])) != nil { return false }
        guard let data = try? URL.bookmarkData(withContentsOf: item.url) else { return false }
        let values = URL.resourceValues(forKeys: [.pathKey, .volumeIsInternalKey], fromBookmarkData: data)
        if values?.volumeIsInternal == false { return false }
        if let path = values?.path, path.hasPrefix("/Volumes/") { return false }
        return true
        #else
        return false
        #endif
    }

    /// Names of the apps in Applications, without ".app".
    func installedAppNames() -> [(name: String, url: URL)] {
        locations.applications.flatMap { folder -> [(String, URL)] in
            let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
            return names.filter { Self.fileExtension($0) == "app" }
                .map { (($0 as NSString).deletingPathExtension, folder.appendingPathComponent($0)) }
        }
    }
}
