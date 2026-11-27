import Foundation

/// One or more files read as if they were laid end to end. A split archive (`.part01`, `.part02` …)
/// is one zip cut into pieces, so its table of contents can only be read across all of them.
struct JoinedFile {
    let paths: [String]
    let sizes: [UInt64]

    var total: UInt64 { sizes.reduce(0, +) }

    init?(paths: [String]) {
        var sizes: [UInt64] = []
        for path in paths {
            guard let st = FileStat(path: path), st.isRegular else { return nil }
            sizes.append(UInt64(st.size))
        }
        self.paths = paths
        self.sizes = sizes
    }

    func read(at offset: UInt64, count: Int) -> Data? {
        guard count >= 0, offset <= total, UInt64(count) <= total - offset else { return nil }
        var result = Data()
        result.reserveCapacity(count)
        var offset = offset
        var remaining = count
        var start: UInt64 = 0
        for (index, size) in sizes.enumerated() where remaining > 0 {
            let end = start + size
            if offset < end {
                let within = offset - start
                let take = Int(min(UInt64(remaining), size - within))
                guard let handle = FileHandle(forReadingAtPath: paths[index]) else { return nil }
                defer { try? handle.close() }
                guard (try? handle.seek(toOffset: within)) != nil,
                      let chunk = try? handle.read(upToCount: take), chunk.count == take else { return nil }
                result.append(chunk)
                offset += UInt64(take)
                remaining -= take
            }
            start = end
        }
        return remaining == 0 ? result : nil
    }
}

/// One thing a zip archive holds.
struct ZipEntry: Equatable {
    enum Kind { case file, directory, symlink }

    /// Relative path inside the archive, without a trailing slash.
    let path: String
    /// Unpacked length. For a symbolic link, the length of the path it points to.
    let size: UInt64
    let kind: Kind
    /// CRC-32 of the unpacked contents (for a link, of the path it points to).
    var crc: UInt32 = 0
}

enum ZipIndex {
    /// The archive's table of contents, or nil if this is not a zip Rinse can read safely.
    static func entries(of file: JoinedFile) -> [ZipEntry]? {
        let total = file.total
        guard total >= 22 else { return nil }
        let tailLength = Int(min(total, 65_557))
        guard let tail = file.read(at: total - UInt64(tailLength), count: tailLength) else { return nil }

        // The end-of-archive record sits in the last 64 KB, after an optional comment.
        var position = tail.count - 22
        var end: Int?
        while position >= 0 {
            if tail.u32(position) == 0x0605_4b50 {
                end = position
                break
            }
            position -= 1
        }
        guard let eocd = end else { return nil }
        var count = UInt64(tail.u16(eocd + 10))
        var directorySize = UInt64(tail.u32(eocd + 12))
        var directoryOffset = UInt64(tail.u32(eocd + 16))

        if count == 0xFFFF || directorySize == 0xFFFF_FFFF || directoryOffset == 0xFFFF_FFFF {
            // Zip64: the real numbers are in a larger record that a locator points to.
            let locator = eocd - 20
            guard locator >= 0, tail.u32(locator) == 0x0706_4b50 else { return nil }
            let recordOffset = tail.u64(locator + 8)
            guard let record = file.read(at: recordOffset, count: 56), record.u32(0) == 0x0606_4b50 else { return nil }
            count = record.u64(32)
            directorySize = record.u64(40)
            directoryOffset = record.u64(48)
        }
        guard count > 0, count <= 2_000_000, directorySize <= 512_000_000,
              directoryOffset <= total, directorySize <= total - directoryOffset,
              let directory = file.read(at: directoryOffset, count: Int(directorySize)) else { return nil }

        var entries: [ZipEntry] = []
        var p = 0
        for _ in 0..<count {
            guard p + 46 <= directory.count, directory.u32(p) == 0x0201_4b50 else { return nil }
            let madeBy = directory.u16(p + 4)
            let crc = directory.u32(p + 16)
            var size = UInt64(directory.u32(p + 24))
            let nameLength = Int(directory.u16(p + 28))
            let extraLength = Int(directory.u16(p + 30))
            let commentLength = Int(directory.u16(p + 32))
            let external = directory.u32(p + 38)
            let next = p + 46 + nameLength + extraLength + commentLength
            guard next <= directory.count else { return nil }
            let nameData = directory.subdata(in: (directory.startIndex + p + 46)..<(directory.startIndex + p + 46 + nameLength))

            if size == 0xFFFF_FFFF {
                // The real size is the first field of the zip64 extra block.
                var q = p + 46 + nameLength
                let extraEnd = q + extraLength
                var found = false
                while q + 4 <= extraEnd {
                    let id = directory.u16(q)
                    let length = Int(directory.u16(q + 2))
                    if id == 0x0001, length >= 8, q + 12 <= extraEnd {
                        size = directory.u64(q + 4)
                        found = true
                        break
                    }
                    q += 4 + length
                }
                guard found else { return nil }
            }
            p = next

            guard var name = String(data: nameData, encoding: .utf8) ?? String(data: nameData, encoding: .isoLatin1),
                  !name.isEmpty else { return nil }
            name = name.replacingOccurrences(of: "\\", with: "/")
            let isDirectoryName = name.hasSuffix("/")
            while name.hasSuffix("/") { name.removeLast() }
            let parts = name.split(separator: "/", omittingEmptySubsequences: false)
            // A name that climbs out of its folder or starts at the root is not something to trust.
            guard !name.isEmpty, !name.hasPrefix("/"), !parts.contains(".."), !parts.contains("") else { return nil }

            let mode = (madeBy >> 8) == 3 ? (external >> 16) & 0o170000 : 0
            let kind: ZipEntry.Kind
            if isDirectoryName || mode == 0o040000 {
                kind = .directory
            } else if mode == 0o120000 {
                kind = .symlink
            } else {
                kind = .file
            }
            entries.append(ZipEntry(path: name, size: kind == .directory ? 0 : size, kind: kind, crc: crc))
        }
        // A table of contents with records left over is not one to trust.
        guard p == directory.count else { return nil }
        return entries
    }

    /// Mac bookkeeping that Archive Utility folds into the unpacked files instead of writing out.
    static func isBookkeeping(_ path: String) -> Bool {
        let parts = path.split(separator: "/")
        guard let first = parts.first, let last = parts.last else { return true }
        return first == "__MACOSX" || last == ".DS_Store" || last.hasPrefix("._")
    }

    /// Where the archive's contents already sit unpacked in `folder`, if they do: every file and link
    /// present with the same kind, length and checksum. Extra files in the unpacked copy do not matter.
    ///
    /// Archive Utility unpacks a single top-level item next to the archive, and several into a folder
    /// named after it, adding " 2", " 3" … when the name is taken. Each of those places is tried.
    static func unpackedCopy(of entries: [ZipEntry], archiveName: String, in folder: URL, excluding: Set<String> = []) -> URL? {
        let kept = entries.filter { !isBookkeeping($0.path) }
        guard kept.contains(where: { $0.kind != .directory }) else { return nil }
        let tops = Set(kept.map { String($0.path.split(separator: "/")[0]) })

        func candidates(_ name: String) -> [String] { [name] + (2...30).map { numbered(name, $0) } }

        if tops.count == 1, let top = tops.first {
            for name in candidates(top) {
                let root = folder.appendingPathComponent(name)
                if !excluding.contains(root.standardizedFileURL.path),
                   matches(kept, at: root, map: { $0 == top ? "" : String($0.dropFirst(top.count + 1)) }) {
                    return root
                }
            }
        } else {
            for name in candidates(archiveName) {
                let root = folder.appendingPathComponent(name)
                if !excluding.contains(root.standardizedFileURL.path), matches(kept, at: root, map: { $0 }) {
                    return root
                }
            }
        }
        return nil
    }

    /// Runs the same check again for one known place, as found by `unpackedCopy`. `top` is the
    /// archive's single top-level name when it has one, nil when it unpacked into a folder of its own.
    static func isUnpackedCopy(_ entries: [ZipEntry], at root: URL, top: String?) -> Bool {
        let kept = entries.filter { !isBookkeeping($0.path) }
        guard kept.contains(where: { $0.kind != .directory }) else { return false }
        if let top {
            guard Set(kept.map { String($0.path.split(separator: "/")[0]) }) == [top] else { return false }
            return matches(kept, at: root, map: { $0 == top ? "" : String($0.dropFirst(top.count + 1)) })
        }
        return matches(kept, at: root, map: { $0 })
    }

    /// The single top-level name of an archive's contents, or nil when it has several.
    static func singleTop(_ entries: [ZipEntry]) -> String? {
        let tops = Set(entries.filter { !isBookkeeping($0.path) }.map { String($0.path.split(separator: "/")[0]) })
        return tops.count == 1 ? tops.first : nil
    }

    /// "Wash.app" becomes "Wash 2.app"; "Daybreak" becomes "Daybreak 2", as Finder names a second copy.
    static func numbered(_ name: String, _ n: Int) -> String {
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        return ext.isEmpty || base.isEmpty ? "\(name) \(n)" : "\(base) \(n).\(ext)"
    }

    /// Copies already checked byte for byte, by place and archive, with a fingerprint of the copy's
    /// files (names, lengths, file numbers, modification and change dates) at the time. An unchanged copy is not read again,
    /// so the hourly look stays cheap; any change to the copy means a full check.
    private static var verified: [Int: Int] = [:]
    private static let lock = NSLock()

    private static func matches(_ entries: [ZipEntry], at root: URL, map: (String) -> String) -> Bool {
        guard FileStat(path: root.path) != nil else { return false }
        var place = Hasher()
        place.combine(root.standardizedFileURL.path)
        var fingerprint = Hasher()
        // Names, kinds and lengths first: cheap, and enough to rule out almost every wrong place.
        for entry in entries {
            let relative = map(entry.path)
            let target = relative.isEmpty ? root.path : root.path + "/" + relative
            guard let st = FileStat(path: target) else { return false }
            switch entry.kind {
            case .directory:
                guard st.isDirectory else { return false }
            case .file:
                guard st.isRegular, UInt64(st.size) == entry.size else { return false }
            case .symlink:
                guard st.isSymlink, UInt64(st.size) == entry.size else { return false }
            }
            place.combine(entry.path)
            place.combine(entry.crc)
            fingerprint.combine(target)
            fingerprint.combine(st.size)
            fingerprint.combine(st.inode)
            fingerprint.combine(st.modified.timeIntervalSince1970)
            fingerprint.combine(st.changed.timeIntervalSince1970)
        }
        let key = place.finalize(), stamp = fingerprint.finalize()
        lock.lock()
        let known = verified[key] == stamp
        lock.unlock()
        if known { return true }
        // Then the contents. Same lengths are not enough: a rebuilt app often keeps them.
        for entry in entries where entry.kind != .directory {
            let relative = map(entry.path)
            let target = relative.isEmpty ? root.path : root.path + "/" + relative
            guard checksum(of: target, kind: entry.kind) == entry.crc else { return false }
        }
        // Putting the access times back moves each file's change time, so the stamp is taken afresh.
        var after = Hasher()
        for entry in entries {
            let relative = map(entry.path)
            let target = relative.isEmpty ? root.path : root.path + "/" + relative
            guard let st = FileStat(path: target) else { return false }
            after.combine(target)
            after.combine(st.size)
            after.combine(st.inode)
            after.combine(st.modified.timeIntervalSince1970)
            after.combine(st.changed.timeIntervalSince1970)
        }
        lock.lock()
        verified[key] = after.finalize()
        lock.unlock()
        return true
    }

    /// CRC-32 of a file's bytes, or of the path a link points to. Leaves the file's access time alone.
    /// How many files have been read for a checksum, so tests can see the cache at work.
    static var checksumsRead = 0

    static func checksum(of path: String, kind: ZipEntry.Kind) -> UInt32? {
        lock.lock()
        checksumsRead += 1
        lock.unlock()
        if kind == .symlink {
            guard let target = try? FileManager.default.destinationOfSymbolicLink(atPath: path) else { return nil }
            return CRC32.of(Data(target.utf8))
        }
        return FileStat.preservingAccessTime([path]) {
            guard let handle = FileHandle(forReadingAtPath: path) else { return nil }
            defer { try? handle.close() }
            var crc = CRC32()
            while let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty { crc.update(chunk) }
            return crc.value
        }
    }
}

/// The checksum zip archives record for every file.
struct CRC32 {
    private static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }

    private var state: UInt32 = 0xFFFF_FFFF

    mutating func update(_ data: Data) {
        var c = state
        data.withUnsafeBytes { buffer in
            for byte in buffer { c = Self.table[Int((c ^ UInt32(byte)) & 0xFF)] ^ (c >> 8) }
        }
        state = c
    }

    var value: UInt32 { state ^ 0xFFFF_FFFF }

    static func of(_ data: Data) -> UInt32 {
        var crc = CRC32()
        crc.update(data)
        return crc.value
    }
}

private extension Data {
    func u16(_ i: Int) -> UInt16 {
        UInt16(self[startIndex + i]) | UInt16(self[startIndex + i + 1]) << 8
    }

    func u32(_ i: Int) -> UInt32 {
        (0..<4).reduce(UInt32(0)) { $0 | UInt32(self[startIndex + i + $1]) << (8 * UInt32($1)) }
    }

    func u64(_ i: Int) -> UInt64 {
        (0..<8).reduce(UInt64(0)) { $0 | UInt64(self[startIndex + i + $1]) << (8 * UInt64($1)) }
    }
}
