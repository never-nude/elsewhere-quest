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
    let isDirectory: Bool
    let isRegular: Bool
    let modified: Date
    let accessed: Date
    let created: Date
    /// The disk it lives on.
    let device: UInt64

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
        #if canImport(Darwin)
        modified = Date(st.st_mtimespec)
        accessed = Date(st.st_atimespec)
        created = Date(st.st_birthtimespec)
        #else
        modified = Date(st.st_mtim)
        accessed = Date(st.st_atim)
        created = Date(st.st_mtim)
        #endif
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

    /// True when macOS recorded where the file was downloaded from, so it can be fetched again.
    static func hasOrigin(_ path: String) -> Bool {
        #if canImport(Darwin)
        return getxattr(path, "com.apple.metadata:kMDItemWhereFroms", nil, 0, 0, XATTR_NOFOLLOW) >= 0
        #else
        return false
        #endif
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
