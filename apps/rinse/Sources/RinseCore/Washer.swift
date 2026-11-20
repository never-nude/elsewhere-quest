import Foundation

/// Moves one item to the Trash. The app supplies the real one; tests supply a stand-in.
public protocol Trasher: Sendable {
    func trash(_ url: URL) throws
}

/// The last line of defence: what Rinse will never move, whatever a rule says.
public enum SafetyGuard {
    /// Folders that hold other things. Their contents may go; they may not.
    static let anchors: Set<String> = [
        "Library/Caches", "Library/Developer", "Library/Developer/Xcode",
        "Library/Developer/Xcode/DerivedData", "Library/Developer/Xcode/iOS DeviceSupport",
        "Library/Developer/Xcode/watchOS DeviceSupport", "Library/Developer/Xcode/tvOS DeviceSupport",
        "Library/Developer/CoreSimulator",
    ]

    public static func canWash(_ url: URL, home: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let homePath = home.standardizedFileURL.path
        guard path.hasPrefix(homePath + "/") else { return false }
        let relative = String(path.dropFirst(homePath.count + 1))
        let parts = relative.split(separator: "/")
        // Nothing directly in the home folder: Desktop, Documents, Library and friends stay.
        guard parts.count >= 2, !parts.contains(".."), parts[0] != ".Trash" else { return false }
        if anchors.contains(relative) { return false }
        if parts[0] == "Library" {
            return relative.hasPrefix("Library/Caches/") || relative.hasPrefix("Library/Developer/")
        }
        return true
    }
}

public struct WashReport: Sendable {
    public struct Failure: Sendable, Identifiable {
        public let finding: Finding
        public let message: String
        public var id: String { finding.id }
    }

    public let washed: [Finding]
    public let failures: [Failure]
    public var bytes: Int64 { washed.reduce(0) { $0 + $1.bytes } }
}

extension SafetyGuard {
    /// Kinds whose recorded date is the newest date anywhere inside, so any change inside can be caught.
    static let datedThroughout: Set<Residue> = [.redundant, .empty, .dead, .projectBuilds, .staleDownloads]

    /// Why an item must not be moved right now, or nil when it may be.
    /// Checked at the last moment, because the scan that judged it may be hours old.
    static func objection(to finding: Finding, home: URL, archive: URL?, inUse: Set<String> = [],
                          runningIDs: Set<String> = [], protected: Set<String> = []) -> String? {
        guard canWash(finding.url, home: home) else { return "Rinse does not move this location" }
        let path = finding.url.standardizedFileURL.path
        if let archive {
            let filing = archive.standardizedFileURL.path
            if path == filing || path.hasPrefix(filing + "/") { return "Already in the filing folder" }
            if filing.hasPrefix(path + "/") { return "It holds the filing folder" }
        }
        // A folder macOS saves into (the screenshot folder), or one that holds it.
        if protected.contains(where: { $0 == path || $0.hasPrefix(path + "/") }) { return "It holds your screenshot folder" }
        // Running, or kept in the Dock, right now: moving it would break it.
        if inUse.contains(where: { $0 == path || $0.hasPrefix(path + "/") }) { return "It is open or kept in the Dock" }
        if case .olderBuild(let id) = finding.proof, runningIDs.contains(id) { return "It is open" }
        guard let now = FileStat(path: finding.url.path) else { return "Already gone" }
        guard now.isDirectory == finding.isDirectory, now.modified <= finding.lastTouched else {
            return "Changed since Rinse looked"
        }
        // A folder's own date does not move when something deep inside it changes.
        if now.isDirectory, datedThroughout.contains(finding.category),
           FileStat.treeSummary(finding.url.path).newest > finding.lastTouched.addingTimeInterval(1) {
            return "Changed since Rinse looked"
        }
        if finding.category == .empty, !FileStat.isEmptyTree(finding.url.path) { return "No longer empty" }
        if finding.category == .dead, now.isSymlink, Scanner.linkState(finding.url) != .broken { return "Its target is back" }
        if finding.category == .dead, now.isRegular, finding.bytes == 0, now.size != 0 { return "No longer empty" }
        return nil
    }

    /// For a redundant item: proof, run again now, that its other copy will still be there afterwards
    /// and still is what the scan said it was. Nil when the item may go.
    static func proofObjection(_ finding: Finding, batch: [Finding]) -> String? {
        guard let direct = finding.keeps else { return nil }
        guard survivingCopy(of: finding, batch: batch) != nil else { return "Its other copy is gone or going too" }
        // When the direct copy is going too, the chain above vouches for it; otherwise prove the link again.
        let directPath = direct.standardizedFileURL.path
        guard !batch.contains(where: { $0.url.standardizedFileURL.path == directPath }) else { return nil }
        switch finding.proof {
        case .none, .installer:
            return nil
        case .unpacked(let pieces, let top):
            guard let file = JoinedFile(paths: pieces),
                  let entries = FileStat.preservingAccessTime(pieces, { ZipIndex.entries(of: file) }),
                  ZipIndex.isUnpackedCopy(entries, at: direct, top: top) else { return "Its unpacked copy has changed" }
            return nil
        case .duplicate:
            return FileStat.sameContents(finding.url.path, direct.path) ? nil : "The two copies are no longer the same"
        case .olderBuild(let id):
            return Scanner.bundleID(of: direct) == id ? nil : "The newer build is not there any more"
        }
    }

    /// For a redundant item: the copy that must survive, after following any chain through other
    /// items in the same batch (an archive whose unpacked app is itself an old build is fine, as
    /// long as the newest build stays). Nil when no copy is left standing, or when something inside
    /// a copy along the way is going (a copy with a piece missing is no copy).
    static func survivingCopy(of finding: Finding, batch: [Finding]) -> URL? {
        guard var copy = finding.keeps else { return nil }
        let own = finding.url.standardizedFileURL.path
        let going = Dictionary(batch.map { ($0.url.standardizedFileURL.path, $0.keeps) }, uniquingKeysWith: { a, _ in a })
        var visited: Set<String> = [own]
        while true {
            let path = copy.standardizedFileURL.path
            guard visited.insert(path).inserted else { return nil }
            if going.keys.contains(where: { $0 != own && ($0.hasPrefix(path + "/") || path.hasPrefix($0 + "/")) }) {
                return nil
            }
            guard let next = going[path] else { break }
            guard let further = next else { return nil }
            copy = further
        }
        return FileManager.default.fileExists(atPath: copy.path) ? copy : nil
    }
}

public enum Washer {
    /// Sends each finding to the Trash. Every item is checked first, while everything is still where
    /// the scan saw it; then the ones that passed are moved. One failure never stops the rest.
    public static func wash(_ findings: [Finding], home: URL, archive: URL? = nil, inUse: Set<String> = [],
                            runningIDs: Set<String> = [], protected: [URL] = [], trasher: Trasher) -> WashReport {
        let inUse = Set(inUse.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
        let protected = Set(protected.map { $0.standardizedFileURL.path })
        var cleared: [Finding] = []
        var failures: [WashReport.Failure] = []
        for finding in findings {
            if let objection = SafetyGuard.objection(to: finding, home: home, archive: archive,
                                                     inUse: inUse, runningIDs: runningIDs, protected: protected)
                ?? SafetyGuard.proofObjection(finding, batch: findings) {
                failures.append(.init(finding: finding, message: objection))
            } else {
                cleared.append(finding)
            }
        }
        var washed: [Finding] = []
        for finding in cleared {
            do {
                try trasher.trash(finding.url)
                washed.append(finding)
            } catch {
                failures.append(.init(finding: finding, message: error.localizedDescription))
            }
        }
        return WashReport(washed: washed, failures: failures)
    }
}
