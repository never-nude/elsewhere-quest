import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// What `lstat` says about one path. Symbolic links are never followed.
struct FileStat {
    /// Space allocated on disk, which is what washing actually gives back.
    let bytes: Int64
    /// Length in bytes. For a symbolic link, the length of the path it points to.
    let size: Int64
    let isDirectory: Bool
    let isRegular: Bool
    let isSymlink: Bool
    let modified: Date
    let accessed: Date
    let created: Date
    /// The disk it lives on.
    let device: UInt64
    let inode: UInt64
    /// When the file's contents or details last changed. Unlike the modification date,
    /// nothing can set this back, so it gives away an edit that hid its tracks.
    let changed: Date

    /// The most recent sign of life. A folder's access time is left out: it moves whenever
    /// anything lists the folder, Rinse's own scans included.
    var lastTouched: Date { isDirectory ? max(modified, created) : max(modified, max(accessed, created)) }

    init?(path: String) {
        var st = stat()
        guard lstat(path, &st) == 0 else { return nil }
        let kind = st.st_mode & S_IFMT
        isDirectory = kind == S_IFDIR
        isRegular = kind == S_IFREG
        isSymlink = kind == S_IFLNK
        bytes = Int64(st.st_blocks) * 512
        size = Int64(st.st_size)
        device = UInt64(truncatingIfNeeded: st.st_dev)
        inode = UInt64(truncatingIfNeeded: st.st_ino)
        #if canImport(Darwin)
        modified = Date(st.st_mtimespec)
        accessed = Date(st.st_atimespec)
        created = Date(st.st_birthtimespec)
        changed = Date(st.st_ctimespec)
        #else
        modified = Date(st.st_mtim)
        accessed = Date(st.st_atim)
        created = Date(st.st_mtim)
        changed = Date(st.st_ctim)
        #endif
    }

    /// Runs `body`, then puts back the access times it disturbed, so that Rinse looking inside
    /// a file never makes the file look recently used.
    static func preservingAccessTime<T>(_ paths: [String], _ body: () -> T) -> T {
        var saved: [(String, timespec)] = []
        for path in paths {
            var st = stat()
            guard lstat(path, &st) == 0 else { continue }
            #if canImport(Darwin)
            saved.append((path, st.st_atimespec))
            #else
            saved.append((path, st.st_atim))
            #endif
        }
        let result = body()
        for (path, accessed) in saved {
            var times = [accessed, timespec(tv_sec: 0, tv_nsec: utimeOmit)]
            _ = utimensat(AT_FDCWD, path, &times, AT_SYMLINK_NOFOLLOW)
        }
        return result
    }

    /// "Leave this time alone", for `utimensat`. The C macro does not reach Swift on every platform.
    #if canImport(Darwin)
    private static let utimeOmit = -2
    #else
    private static let utimeOmit = (1 << 30) - 2
    #endif

    /// True when two files, or two folders and everything in them, hold exactly the same bytes.
    static func sameContents(_ a: String, _ b: String) -> Bool {
        guard let sa = FileStat(path: a), let sb = FileStat(path: b) else { return false }
        if sa.isRegular && sb.isRegular {
            guard sa.size == sb.size else { return false }
            return preservingAccessTime([a, b]) { sameBytes(a, b) }
        }
        if sa.isSymlink && sb.isSymlink {
            return (try? FileManager.default.destinationOfSymbolicLink(atPath: a))
                == (try? FileManager.default.destinationOfSymbolicLink(atPath: b))
        }
        guard sa.isDirectory, sb.isDirectory, let la = listing(a), let lb = listing(b), la == lb else { return false }
        return la.allSatisfy { entry in
            entry.kind == "d" || sameContents(a + "/" + entry.path, b + "/" + entry.path)
        }
    }

    struct ListingEntry: Equatable, Hashable {
        let path: String
        let kind: String
        let size: Int64
    }

    /// Everything under a folder, sorted, with kinds and lengths. Nil for very large trees.
    static func listing(_ path: String, limit: Int = 50_000) -> [ListingEntry]? {
        guard let walker = FileManager.default.enumerator(atPath: path) else { return nil }
        var entries: [ListingEntry] = []
        while let relative = walker.nextObject() as? String {
            guard entries.count < limit else { return nil }
            guard let st = FileStat(path: path + "/" + relative) else { return nil }
            if relative.hasSuffix(".DS_Store") { continue }
            let kind = st.isDirectory ? "d" : st.isSymlink ? "l" : st.isRegular ? "f" : "o"
            entries.append(ListingEntry(path: relative, kind: kind, size: st.isDirectory ? 0 : st.size))
        }
        return entries.sorted { $0.path < $1.path }
    }

    private static func sameBytes(_ a: String, _ b: String) -> Bool {
        guard let ha = FileHandle(forReadingAtPath: a), let hb = FileHandle(forReadingAtPath: b) else { return false }
        defer {
            try? ha.close()
            try? hb.close()
        }
        while true {
            let da = (try? ha.read(upToCount: 1 << 20)) ?? nil
            let db = (try? hb.read(upToCount: 1 << 20)) ?? nil
            if da != db { return false }
            if da == nil || da?.isEmpty == true { return true }
        }
    }

    /// Disk space of a file, or of a folder and everything under it.
    static func treeBytes(_ path: String) -> Int64 {
        guard let top = FileStat(path: path) else { return 0 }
        guard top.isDirectory else { return top.bytes }
        var total = top.bytes
        guard let walker = FileManager.default.enumerator(atPath: path) else { return total }
        while let relative = walker.nextObject() as? String {
            if let st = FileStat(path: path + "/" + relative) { total += st.bytes }
        }
        return total
    }

    /// The disk a path is on, or would be on once created: the nearest folder that exists decides.
    static func device(ofNearestExisting url: URL) -> UInt64? {
        var current = url.standardizedFileURL
        while true {
            if let st = FileStat(path: current.path) { return st.device }
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { return nil }
            current = parent
        }
    }

    /// Disk space and the most recent sign of life anywhere in a folder (or of a single file).
    /// A folder's own dates do not move when something deep inside it is edited.
    static func treeSummary(_ path: String) -> (bytes: Int64, newest: Date) {
        guard let top = FileStat(path: path) else { return (0, .distantPast) }
        guard top.isDirectory else { return (top.bytes, top.lastTouched) }
        var total = top.bytes
        var newest = top.lastTouched
        guard let walker = FileManager.default.enumerator(atPath: path) else { return (total, newest) }
        while let relative = walker.nextObject() as? String {
            guard let st = FileStat(path: path + "/" + relative) else { continue }
            total += st.bytes
            // A folder's access time moves whenever anything lists it, this scan included.
            newest = max(newest, st.isDirectory ? st.modified : st.lastTouched)
        }
        return (total, newest)
    }

    /// True when macOS recorded that the file came from a web address, so it can plausibly be fetched again.
    /// AirDrop, Mail and Messages write the same attribute with other values; those do not count.
    static func hasOrigin(_ path: String) -> Bool {
        #if canImport(Darwin)
        let name = "com.apple.metadata:kMDItemWhereFroms"
        let size = getxattr(path, name, nil, 0, 0, XATTR_NOFOLLOW)
        guard size > 0 else { return false }
        var data = Data(count: size)
        let read = data.withUnsafeMutableBytes { getxattr(path, name, $0.baseAddress, size, 0, XATTR_NOFOLLOW) }
        guard read == size else { return false }
        return isWebOrigin(data)
        #else
        return false
        #endif
    }

    /// The attribute is a property list holding an array of strings.
    static func isWebOrigin(_ data: Data) -> Bool {
        guard let list = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [Any] else { return false }
        return list.contains { item in
            guard let text = (item as? String)?.lowercased() else { return false }
            return text.hasPrefix("https://") || text.hasPrefix("http://")
        }
    }

    /// Every name in a folder, straight from the file system. Foundation's listing on a Mac leaves out
    /// `._` files (the leftovers USB drives make), which are exactly what the dead-file rule looks for.
    static func names(in path: String) -> [String]? {
        guard let dir = opendir(path) else { return nil }
        defer { closedir(dir) }
        var names: [String] = []
        while let entry = readdir(dir) {
            let name = withUnsafePointer(to: &entry.pointee.d_name) {
                String(cString: UnsafeRawPointer($0).assumingMemoryBound(to: CChar.self))
            }
            if name != "." && name != ".." { names.append(name) }
        }
        return names
    }

    enum Reachability { case exists, missing, unreadable }

    /// Whether something is at a path, following links. Only "no such file" counts as missing:
    /// a path Rinse is not allowed to look at is not proof that nothing is there.
    static func reachability(_ path: String) -> Reachability {
        var st = stat()
        if stat(path, &st) == 0 { return .exists }
        return errno == ENOENT || errno == ENOTDIR ? .missing : .unreadable
    }

    /// True when the owner gave it a Finder tag (a colour or a name).
    static func hasTags(_ path: String) -> Bool {
        #if canImport(Darwin)
        return getxattr(path, "com.apple.metadata:_kMDItemUserTags", nil, 0, 0, XATTR_NOFOLLOW) > 0
        #else
        return false
        #endif
    }

    /// True for a folder with nothing in it but other such folders and Finder's own `.DS_Store`.
    static func isEmptyTree(_ path: String) -> Bool {
        guard let names = Self.names(in: path) else { return false }
        for name in names where name != ".DS_Store" && name != ".localized" {
            let child = path + "/" + name
            guard let st = FileStat(path: child), st.isDirectory, isEmptyTree(child) else { return false }
        }
        return true
    }

    /// True when macOS itself tagged the file as a screen capture.
    static func isMarkedScreenCapture(_ path: String) -> Bool {
        #if canImport(Darwin)
        return getxattr(path, "com.apple.metadata:kMDItemIsScreenCapture", nil, 0, 0, XATTR_NOFOLLOW) >= 0
        #else
        return false
        #endif
    }
}

private extension Date {
    init(_ t: timespec) {
        self.init(timeIntervalSince1970: TimeInterval(t.tv_sec) + TimeInterval(t.tv_nsec) / 1_000_000_000)
    }
}
