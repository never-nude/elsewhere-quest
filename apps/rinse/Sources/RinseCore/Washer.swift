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
    /// Why an item must not be moved right now, or nil when it may be.
    /// Checked at the last moment, because the scan that judged it may be hours old.
    static func objection(to finding: Finding, home: URL, archive: URL?) -> String? {
        guard canWash(finding.url, home: home) else { return "Rinse does not move this location" }
        if let archive {
            let path = finding.url.standardizedFileURL.path, filing = archive.standardizedFileURL.path
            if path == filing || path.hasPrefix(filing + "/") { return "Already in the filing folder" }
            if filing.hasPrefix(path + "/") { return "It holds the filing folder" }
        }
        guard let now = FileStat(path: finding.url.path) else { return "Already gone" }
        guard now.isDirectory == finding.isDirectory, now.modified <= finding.lastTouched else {
            return "Changed since Rinse looked"
        }
        return nil
    }
}

public enum Washer {
    /// Sends each finding to the Trash. One failure never stops the rest.
    public static func wash(_ findings: [Finding], home: URL, archive: URL? = nil, trasher: Trasher) -> WashReport {
        var washed: [Finding] = []
        var failures: [WashReport.Failure] = []
        for finding in findings {
            if let objection = SafetyGuard.objection(to: finding, home: home, archive: archive) {
                failures.append(.init(finding: finding, message: objection))
                continue
            }
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
