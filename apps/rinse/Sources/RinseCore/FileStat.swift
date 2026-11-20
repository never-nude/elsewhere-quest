import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// What `lstat` says about one path. Symbolic links are never followed.
struct FileStat: Sendable {
    /// Space allocated on disk, which is what washing actually gives back.
    let bytes: Int64
    let isDirectory: Bool
    let isRegular: Bool
    let modified: Date
    let accessed: Date
    let created: Date
    let changed: Date
    /// The disk it lives on.
    let device: UInt64
    let inode: UInt64
    let linkCount: UInt64
    let length: Int64

    /// The most recent sign of life.
    var lastTouched: Date { max(modified, max(accessed, created)) }

    init?(path: String) {
        var st = stat()
        guard lstat(path, &st) == 0 else { return nil }
        let kind = st.st_mode & S_IFMT
        isDirectory = kind == S_IFDIR
        isRegular = kind == S_IFREG
        bytes = Int64(st.st_blocks) * 512
        device = UInt64(truncatingIfNeeded: st.st_dev)
        inode = UInt64(truncatingIfNeeded: st.st_ino)
        linkCount = UInt64(truncatingIfNeeded: st.st_nlink)
        length = Int64(st.st_size)
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

    func sameFile(path: String) -> Bool {
        guard let latest = FileStat(path: path), latest.isRegular else { return false }
        return contentIdentity == latest.contentIdentity
    }

    struct ContentIdentity: Hashable, Sendable {
        let device: UInt64
        let inode: UInt64
        let modified: Date
        let changed: Date
        let length: Int64
        let linkCount: UInt64
    }

    var contentIdentity: ContentIdentity {
        ContentIdentity(device: device, inode: inode, modified: modified, changed: changed,
                        length: length, linkCount: linkCount)
    }

    enum WalkAction { case descend, skip, stop }

    /// Read directory entries and their lstat data once. Never descend through symlinks.
    static func walk(_ root: String, includeHidden: Bool, visit: (String, String, FileStat) -> WalkAction) {
        var pending = [root]
        while let folder = pending.popLast() {
            let fd = open(folder, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard fd >= 0 else { continue }
            guard let directory = fdopendir(fd) else { _ = close(fd); continue }
            defer { closedir(directory) }
            while let entry = readdir(directory) {
                let capacity = MemoryLayout.size(ofValue: entry.pointee.d_name)
                let name = withUnsafePointer(to: &entry.pointee.d_name) { pointer in
                    pointer.withMemoryRebound(to: CChar.self, capacity: capacity) { String(validatingUTF8: $0) }
                }
                guard let name, name != ".", name != "..", includeHidden || !name.hasPrefix(".") else { continue }
                let path = folder + "/" + name
                guard let stat = FileStat(path: path) else { continue }
                switch visit(path, name, stat) {
                case .descend: if stat.isDirectory { pending.append(path) }
                case .skip: continue
                case .stop: return
                }
            }
        }
    }

    /// Disk space of a file, or of a folder and everything under it.
    static func treeBytes(_ path: String) -> Int64 {
        guard let top = FileStat(path: path) else { return 0 }
        guard top.isDirectory else { return top.bytes }
        var total = top.bytes
        walk(path, includeHidden: true) { _, _, stat in
            total += stat.bytes
            return .descend
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
    static func staleTreeSummary(_ path: String, top: FileStat, cutoff: Date) -> (bytes: Int64, newest: Date)? {
        guard top.isDirectory else { return top.lastTouched <= cutoff ? (top.bytes, top.lastTouched) : nil }
        var total = top.bytes
        var newest = top.modified
        guard newest <= cutoff else { return nil }
        walk(path, includeHidden: true) { _, _, st in
            total += st.bytes
            // A folder's access time moves whenever anything lists it, this scan included.
            newest = max(newest, st.isDirectory ? st.modified : st.lastTouched)
            return newest <= cutoff ? .descend : .stop
        }
        return newest <= cutoff ? (total, newest) : nil
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
