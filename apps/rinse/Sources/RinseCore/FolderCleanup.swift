import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// Reuses verified archive matches during a session while both files have the same identities.
public final class ArchiveMatchCache: @unchecked Sendable {
    private struct Pair: Hashable {
        let copy: FileStat.ContentIdentity
        let original: FileStat.ContentIdentity
    }

    private let lock = NSLock()
    private var verified: Set<Pair> = []

    public init() {}

    func contains(_ copy: FileStat, _ original: FileStat) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return verified.contains(Pair(copy: copy.contentIdentity, original: original.contentIdentity))
    }

    func remember(_ copy: FileStat, _ original: FileStat) {
        lock.lock()
        defer { lock.unlock() }
        if verified.count >= 256 { verified.removeAll(keepingCapacity: true) }
        verified.insert(Pair(copy: copy.contentIdentity, original: original.contentIdentity))
    }
}

/// Narrow cleanup rules for the loose items directly in Desktop and Downloads.
enum FolderCleanup {
    private static let archiveExtensions: Set<String> = ["zip", "dmg", "pkg", "xip", "iso", "tar", "tgz", "7z", "rar"]
    private static let copyPattern = #" \([1-9][0-9]*\)$"#
    private static let versionPattern = try! NSRegularExpression(
        pattern: #"^(.+?)[ _-]+(?:(preview|build|release|beta)[ _-]*|v(?=[0-9]))?([0-9]+(?:\.[0-9]+)*)(?:[ _-]+(mac|macos|universal|arm64|aarch64|x64|intel))?$"#,
        options: .caseInsensitive)

    static func isSplitArchive(_ name: String) -> Bool {
        name.range(of: #"(?:\.part[0-9]+(?:\.[^.]+)?|\.(?:zip|7z)\.[0-9]+|\.[zr][0-9]{2})$"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func splitArchiveBase(for name: String) -> String? {
        let file = name.lowercased() as NSString
        let ext = file.pathExtension
        guard ext.count == 3, ext.hasPrefix("z") || ext.hasPrefix("r") else { return nil }
        guard ext.range(of: #"^[zr][0-9]{2}$"#, options: .regularExpression) != nil else { return nil }
        return file.deletingPathExtension + (ext.hasPrefix("z") ? ".zip" : ".rar")
    }

    static func originalName(of name: String) -> String? {
        let file = name as NSString
        let stem = file.deletingPathExtension
        guard stem.hasSuffix(")"), archiveExtensions.contains(file.pathExtension.lowercased()) else { return nil }
        let original = stem.replacingOccurrences(of: copyPattern, with: "", options: .regularExpression)
        guard !original.isEmpty, original != stem else { return nil }
        return original + "." + file.pathExtension
    }

    struct Build {
        let family: String
        let version: [Int]
    }

    static func build(named name: String) -> Build? {
        let file = name as NSString
        let ext = file.pathExtension.lowercased()
        guard ["zip", "dmg"].contains(ext) else { return nil }
        let stem = file.deletingPathExtension
        guard let match = versionPattern.firstMatch(in: stem, range: NSRange(stem.startIndex..., in: stem)),
              let project = Range(match.range(at: 1), in: stem),
              let number = Range(match.range(at: 3), in: stem) else { return nil }
        let components = stem[number].split(separator: ".")
        let explicitVersion = match.range(at: 2).location != NSNotFound || stem[stem.index(before: number.lowerBound)].lowercased() == "v"
        guard explicitVersion || components.count >= 2 else { return nil }
        var version = components.compactMap { Int($0) }
        guard version.count == components.count else { return nil }
        while version.count > 1 && version.last == 0 { version.removeLast() }
        let channel = Range(match.range(at: 2), in: stem).map { stem[$0].lowercased() } ?? "release"
        let variant = Range(match.range(at: 4), in: stem).map { stem[$0].lowercased() } ?? ""
        let normalizedProject = stem[project].lowercased().split { " _-".contains($0) }.joined(separator: " ")
        guard !normalizedProject.isEmpty else { return nil }
        return Build(family: "\(normalizedProject)/\(channel)/\(variant)/\(ext)", version: version)
    }

    static func isEmptyFolder(_ url: URL) -> Bool {
        guard FileStat(path: url.path)?.isDirectory == true,
              let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return false }
        return names.isEmpty
    }

    static func isMatchingCopy(_ url: URL, of original: URL, cache: ArchiveMatchCache? = nil) -> Bool {
        guard url.deletingLastPathComponent() == original.deletingLastPathComponent(),
              originalName(of: url.lastPathComponent) == original.lastPathComponent,
              let copy = FileStat(path: url.path), let kept = FileStat(path: original.path),
              copy.isRegular, kept.isRegular, copy.linkCount == 1, kept.linkCount == 1,
              copy.length > 0, copy.length == kept.length else { return false }
        if cache?.contains(copy, kept) == true {
            return copy.sameFile(path: url.path) && kept.sameFile(path: original.path)
        }
        do {
            let copyHandle = try openRegularFile(url)
            defer { try? copyHandle.close() }
            let originalHandle = try openRegularFile(original)
            defer { try? originalHandle.close() }
            var remaining = copy.length
            while remaining > 0 {
                let count = Int(min(remaining, 256 * 1024))
                guard let chunk = try copyHandle.read(upToCount: count), chunk.count == count,
                      chunk == (try originalHandle.read(upToCount: count)) else { return false }
                remaining -= Int64(count)
            }
            guard copy.sameFile(path: url.path), kept.sameFile(path: original.path) else { return false }
            cache?.remember(copy, kept)
            return true
        } catch {
            return false
        }
    }

    /// Reads container markers without extracting files or mounting a disk image.
    static func looksLikeArchive(_ url: URL, expectedSize: Int64) -> Bool {
        do {
            let handle = try openRegularFile(url)
            defer { try? handle.close() }
            if url.pathExtension.lowercased() == "dmg" {
                guard expectedSize > 512 else { return false }
                try handle.seek(toOffset: UInt64(expectedSize - 512))
                return try handle.read(upToCount: 4) == Data("koly".utf8)
            }
            guard expectedSize >= 22, try handle.read(upToCount: 4) == Data([0x50, 0x4b, 0x03, 0x04]) else {
                return false
            }
            let tailSize = min(expectedSize, 65_557)
            try handle.seek(toOffset: UInt64(expectedSize - tailSize))
            guard let tail = try handle.read(upToCount: Int(tailSize)),
                  let end = tail.range(of: Data([0x50, 0x4b, 0x05, 0x06]), options: .backwards),
                  tail.count - end.lowerBound >= 22 else { return false }
            let record = tail[end.lowerBound...]
            // ZIPs spanning multiple disks are not standalone build archives.
            let commentLength = Int(record[record.startIndex + 20]) + 256 * Int(record[record.startIndex + 21])
            guard record.dropFirst(4).prefix(4).allSatisfy({ $0 == 0 }), record.count == 22 + commentLength else {
                return false
            }
            let directoryOffset = littleEndianUInt32(record.dropFirst(16).prefix(4))
            let directorySize = littleEndianUInt32(record.dropFirst(12).prefix(4))
            guard directorySize >= 46, directoryOffset + directorySize == expectedSize - tailSize + Int64(end.lowerBound) else {
                return false
            }
            try handle.seek(toOffset: UInt64(directoryOffset))
            return try handle.read(upToCount: 4) == Data([0x50, 0x4b, 0x01, 0x02])
        } catch {
            return false
        }
    }

    private static func littleEndianUInt32(_ bytes: Data) -> Int64 {
        bytes.enumerated().reduce(0) { value, byte in value | (Int64(byte.element) << (8 * byte.offset)) }
    }

    static func retainsNewerBuilds(for url: URL, archives: [URL]) -> Bool {
        guard let old = build(named: url.lastPathComponent),
              let oldStat = FileStat(path: url.path), oldStat.isRegular, oldStat.linkCount == 1,
              looksLikeArchive(url, expectedSize: oldStat.length) else { return false }
        let versions = archives.compactMap { archive -> [Int]? in
            guard archive.deletingLastPathComponent() == url.deletingLastPathComponent(),
                  let newer = build(named: archive.lastPathComponent), newer.family == old.family,
                  old.version.lexicographicallyPrecedes(newer.version),
                  let stat = FileStat(path: archive.path), stat.isRegular, stat.linkCount == 1,
                  looksLikeArchive(archive, expectedSize: stat.length), stat.sameFile(path: archive.path) else { return nil }
            return newer.version
        }
        return Set(versions).count >= 2 && oldStat.sameFile(path: url.path)
    }

    private static func openRegularFile(_ url: URL) throws -> FileHandle {
        let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw CocoaError(.fileReadUnknown) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
            _ = close(fd)
            throw CocoaError(.fileReadUnsupportedScheme)
        }
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
}
