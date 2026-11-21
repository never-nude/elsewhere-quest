import Foundation

public struct FileReport: Sendable {
    public struct Filed: Sendable, Identifiable {
        public let finding: Finding
        public let destination: URL
        public var id: String { finding.id }
    }

    public let filed: [Filed]
    public let failures: [WashReport.Failure]
}

/// Moves items into the filing folder. Nothing is ever overwritten.
public enum Filer {
    public static func file(_ findings: [Finding], home: URL, archive: URL, inUse: Set<String> = [],
                            runningIDs: Set<String> = [], protected: [URL] = [],
                            calendar: Calendar = .current) -> FileReport {
        let inUse = Set(inUse.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
        let protected = Set(protected.map { $0.standardizedFileURL.path })
        var filed: [FileReport.Filed] = []
        var failures: [WashReport.Failure] = []
        for finding in findings {
            func fail(_ message: String) { failures.append(.init(finding: finding, message: message)) }

            guard finding.category.canBeFiled else {
                fail("Only things that are yours get filed")
                continue
            }
            if let objection = SafetyGuard.objection(to: finding, home: home, archive: archive, inUse: inUse,
                                                     runningIDs: runningIDs, protected: protected) {
                fail(objection)
                continue
            }
            do {
                let folder = self.folder(for: finding, home: home, archive: archive, calendar: calendar)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let destination = freeName(finding.url.lastPathComponent, in: folder)
                try FileManager.default.moveItem(at: finding.url, to: destination)
                filed.append(.init(finding: finding, destination: destination))
            } catch {
                fail(error.localizedDescription)
            }
        }
        return FileReport(filed: filed, failures: failures)
    }

    /// Clutter is sorted by month: `archive/Screenshots/2026-11`, `archive/From Downloads/2026-11`.
    /// A big file that sat in its own place keeps that place, so where it came from is not lost:
    /// `archive/Big and idle/Documents/Clients/Acme`.
    public static func folder(for finding: Finding, home: URL, archive: URL, calendar: Calendar = .current) -> URL {
        // Idle things are sorted by where they were lying: "From Downloads", "From Desktop".
        let kindName = finding.category == .staleDownloads
            ? "From " + finding.url.deletingLastPathComponent().lastPathComponent
            : finding.category.title
        let kind = archive.appendingPathComponent(kindName)
        if finding.category == .bigIdle {
            let parent = finding.url.deletingLastPathComponent().standardizedFileURL.path
            let homePath = home.standardizedFileURL.path
            if parent.hasPrefix(homePath + "/") {
                return kind.appendingPathComponent(String(parent.dropFirst(homePath.count + 1)))
            }
        }
        let parts = calendar.dateComponents([.year, .month], from: finding.lastTouched)
        return kind.appendingPathComponent(String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0))
    }

    /// The name itself if it is free, otherwise "name 2.ext", "name 3.ext" and so on.
    static func freeName(_ name: String, in folder: URL) -> URL {
        var candidate = folder.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: candidate.path) else { return candidate }
        let ext = (name as NSString).pathExtension
        let base = (name as NSString).deletingPathExtension
        var n = 2
        repeat {
            candidate = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        } while FileManager.default.fileExists(atPath: candidate.path)
        return candidate
    }
}
