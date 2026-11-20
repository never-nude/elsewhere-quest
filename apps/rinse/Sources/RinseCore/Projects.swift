import Foundation

/// Dependency and build folders inside git projects: `node_modules`, `.build`, `target`, `.venv` …
///
/// A folder is listed only when three things hold: its name is one a tool creates, the file that
/// recreates it is right beside it (`package.json` for `node_modules`, `Package.swift` for `.build` …),
/// and the project's `.gitignore` names it, so it is not part of the project's own files.
/// It is recommended for the Trash only when the whole project has been left alone for a while.
extension Scanner {
    struct BuildFolder {
        let name: String
        /// Any one of these beside the folder means it can be recreated.
        let manifests: [String]
        /// How the owner gets it back.
        let restore: String
        /// A file that must be inside, when the name alone is not proof (a Python environment).
        var marker: String?
        /// False for names a project might also use for its own files (`build`, `dist`).
        var alwaysGenerated = true
    }

    static let javascript = ["package.json"]
    static let python = ["pyproject.toml", "requirements.txt", "Pipfile", "uv.lock", "poetry.lock", "setup.py"]
    static let gradle = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"]

    static let buildFolders: [BuildFolder] = [
        BuildFolder(name: "node_modules", manifests: javascript, restore: "npm install"),
        BuildFolder(name: ".next", manifests: javascript, restore: "a build"),
        BuildFolder(name: ".nuxt", manifests: javascript, restore: "a build"),
        BuildFolder(name: ".svelte-kit", manifests: javascript, restore: "a build"),
        BuildFolder(name: ".turbo", manifests: javascript, restore: "a build"),
        BuildFolder(name: ".parcel-cache", manifests: javascript, restore: "a build"),
        BuildFolder(name: ".angular", manifests: javascript, restore: "a build"),
        BuildFolder(name: "dist", manifests: javascript, restore: "a build", alwaysGenerated: false),
        BuildFolder(name: "build", manifests: javascript + gradle, restore: "a build", alwaysGenerated: false),
        BuildFolder(name: ".build", manifests: ["Package.swift"], restore: "swift build"),
        BuildFolder(name: "target", manifests: ["Cargo.toml"], restore: "cargo build"),
        BuildFolder(name: ".venv", manifests: python, restore: "reinstalling its packages", marker: "pyvenv.cfg"),
        BuildFolder(name: "venv", manifests: python, restore: "reinstalling its packages", marker: "pyvenv.cfg"),
        BuildFolder(name: "Pods", manifests: ["Podfile"], restore: "pod install"),
        BuildFolder(name: ".gradle", manifests: gradle, restore: "a Gradle build"),
    ]

    func scanProjects(_ out: inout Collector) {
        var seen = Set<String>()
        for root in locations.projectRoots {
            for repo in repositories(in: root) {
                let key = repo.resolvingSymlinksInPath().standardizedFileURL.path
                guard seen.insert(key).inserted else { continue }
                scanRepository(repo, &out)
            }
        }
    }

    /// Git projects up to five folders below a root. A project's own subfolders are not searched further.
    func repositories(in root: URL) -> [URL] {
        var found: [URL] = []
        var queue: [(URL, Int)] = [(root, 0)]
        let skipped = Set(Self.buildFolders.map(\.name)).union(["Library", "Applications"])
        while let (folder, depth) = queue.popLast() {
            guard !isArchive(folder) else { continue }
            if FileStat(path: folder.appendingPathComponent(".git").path) != nil {
                found.append(folder)
                continue
            }
            guard depth < 5, let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { continue }
            for name in names where !name.hasPrefix(".") && !skipped.contains(name) {
                let url = folder.appendingPathComponent(name)
                guard let st = FileStat(path: url.path), st.isDirectory,
                      !Self.packageExtensions.contains(Self.fileExtension(name)) else { continue }
                queue.append((url, depth + 1))
            }
        }
        return found
    }

    private func scanRepository(_ repo: URL, _ out: inout Collector) {
        // The last sign of work: a commit, a checkout, a fetch, or any file edited outside the build folders.
        var newest = Date.distantPast
        for marker in [".git/HEAD", ".git/index", ".git/logs/HEAD", ".git/FETCH_HEAD"] {
            if let st = FileStat(path: repo.appendingPathComponent(marker).path) { newest = max(newest, st.modified) }
        }
        guard let walker = FileManager.default.enumerator(atPath: repo.path) else { return }
        var builds: [(url: URL, rule: BuildFolder, stat: FileStat)] = []
        var visited = 0
        while let relative = walker.nextObject() as? String {
            visited += 1
            // Too big to be sure nobody is working in it: leave the whole project alone.
            if visited > 400_000 { return }
            let url = repo.appendingPathComponent(relative)
            guard let st = FileStat(path: url.path) else { continue }
            let name = url.lastPathComponent
            guard st.isDirectory else {
                if st.isRegular { newest = max(newest, st.modified) }
                continue
            }
            if name == ".git" {
                walker.skipDescendants()
                continue
            }
            guard let rule = Self.buildFolders.first(where: { $0.name == name }) else { continue }
            if isRebuildable(url, rule: rule, repo: repo) {
                builds.append((url, rule, st))
                walker.skipDescendants()
            } else if rule.alwaysGenerated {
                walker.skipDescendants()
            }
        }
        let project = repo.lastPathComponent
        for build in builds where !out.claims(build.url.path) {
            let bytes = FileStat.treeBytes(build.url.path)
            guard bytes >= rules.cacheListBytes else { continue }
            out.add(Item(url: build.url, name: "\(build.rule.name) in \(project)", stat: build.stat), .projectBuilds,
                    bytes: bytes, limit: .age(days: rules.projectIdleDays),
                    lead: "Project last worked on " + ago(newest), touched: newest,
                    notes: ["comes back with \(build.rule.restore)"])
        }
    }

    func isRebuildable(_ folder: URL, rule: BuildFolder, repo: URL) -> Bool {
        let parent = folder.deletingLastPathComponent()
        guard rule.manifests.contains(where: { FileStat(path: parent.appendingPathComponent($0).path) != nil }) else {
            return false
        }
        if let marker = rule.marker, FileStat(path: folder.appendingPathComponent(marker).path) == nil { return false }
        return isIgnored(folder, repo: repo)
    }

    /// True when a `.gitignore` between the folder and the project root (or the project's own
    /// exclude file, or the owner's global one) names the folder.
    func isIgnored(_ folder: URL, repo: URL) -> Bool {
        let name = folder.lastPathComponent
        let parent = folder.deletingLastPathComponent().standardizedFileURL.path
        let root = repo.standardizedFileURL.path
        var current = folder.deletingLastPathComponent().standardizedFileURL
        while true {
            let here = current.path
            if Self.ignoreFile(current.appendingPathComponent(".gitignore"), names: name, anchoredHere: here == parent) {
                return true
            }
            if here == root || here == "/" || !here.hasPrefix(root) { break }
            current = current.deletingLastPathComponent()
        }
        return Self.ignoreFile(repo.appendingPathComponent(".git/info/exclude"), names: name, anchoredHere: parent == root)
            || Self.ignoreFile(locations.home.appendingPathComponent(".config/git/ignore"), names: name,
                               anchoredHere: parent == root)
    }

    /// Reads one ignore file. Handles the plain patterns tools write (`node_modules`, `/.build`,
    /// `target/`, `**/dist`); anything cleverer is treated as not matching, which only means Rinse
    /// lists less.
    static func ignoreFile(_ url: URL, names name: String, anchoredHere: Bool) -> Bool {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return false }
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), !line.hasPrefix("!") else { continue }
            if line.hasPrefix("**/") { line.removeFirst(3) }
            var anchored = false
            if line.hasPrefix("/") {
                anchored = true
                line.removeFirst()
            }
            while line.hasSuffix("/") { line.removeLast() }
            if line.hasSuffix("/**") { line.removeLast(3) }
            guard line == name else { continue }
            if !anchored || anchoredHere { return true }
        }
        return false
    }
}
