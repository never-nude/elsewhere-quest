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

/// Moves items into the filing folder, sorted as `Kind/2026-11/name`. Nothing is ever overwritten.
public enum Filer {
    public static func file(_ findings: [Finding], home: URL, archive: URL,
                            calendar: Calendar = .current) -> FileReport {
        var filed: [FileReport.Filed] = []
        var failures: [WashReport.Failure] = []
        let archivePath = archive.standardizedFileURL.path
        for finding in findings {
            let source = finding.url.standardizedFileURL.path
            func fail(_ message: String) { failures.append(.init(finding: finding, message: message)) }

            guard finding.category != .caches, finding.category != .developer else {
                fail("Caches are not worth filing")
                continue
            }
            guard SafetyGuard.canWash(finding.url, home: home) else {
                fail("Rinse does not move this location")
                continue
            }
            guard source != archivePath, !source.hasPrefix(archivePath + "/"), !archivePath.hasPrefix(source + "/") else {
                fail("Already in the filing folder")
                continue
            }
            guard FileManager.default.fileExists(atPath: source) else {
                fail("Already gone")
                continue
            }
            do {
                let folder = self.folder(for: finding, archive: archive, calendar: calendar)
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

    /// `archive/Screenshots/2026-11`, by the month the item was last touched.
    public static func folder(for finding: Finding, archive: URL, calendar: Calendar = .current) -> URL {
        let parts = calendar.dateComponents([.year, .month], from: finding.lastTouched)
        let month = String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
        return archive.appendingPathComponent(finding.category.title).appendingPathComponent(month)
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
