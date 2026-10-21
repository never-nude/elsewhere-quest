import Foundation
import UniformTypeIdentifiers

@MainActor
final class TransferLease {
    let url: URL
    let type: String
    let size: Int
    private var onRelease: (() -> Void)?
    init(url: URL, type: String, size: Int, release: @escaping () -> Void) {
        self.url = url; self.type = type; self.size = size; onRelease = release
    }
    func release() { let callback = onRelease; onRelease = nil; callback?() }
}

@MainActor
final class TransferRegistry {
    static let limit = 128 * 1024 * 1024
    private struct Entry {
        let file: URL
        let name: String
        let type: String
        let size: Int
        var complete = false
        var attempted = false
        var hidden = false
        var leases = 0
    }
    let directory: URL
    private var entries: [String: Entry] = [:]

    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Names alone are sufficient; don't read timestamps for temporary cleanup.
        for name in try FileManager.default.contentsOfDirectory(atPath: directory.path) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    static func issuedName(_ url: URL) throws -> String {
        guard NativeConfig.isLocal(url), let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              c.query == nil, c.fragment == nil, c.percentEncodedPath == c.path,
              c.path.hasPrefix("/xfer/") else { throw NativeError("badUrl", "Invalid transfer URL.") }
        let name = String(c.path.dropFirst(6))
        let parts = name.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 2, UUID(uuidString: String(parts[0])) != nil,
              parts[0].count == 36, (1...12).contains(parts[1].count),
              parts[1].allSatisfy({ $0.isASCII && ($0.isLowercase || $0.isNumber) }) else {
            throw NativeError("badUrl", "Invalid transfer name.")
        }
        return name
    }

    func create(name: String, type: String, size: Int) throws -> [String: Any] {
        guard (1...Self.limit).contains(size), !name.isEmpty, name.utf8.count <= 255,
              !name.contains("/"), !name.contains("\\"), !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              type.utf8.count <= 127, type.range(of: "^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+$", options: .regularExpression) != nil else {
            throw NativeError("badArgs", "Invalid transfer name, type or size.")
        }
        let ext = UTType(mimeType: type)?.preferredFilenameExtension ?? "bin"
        let issued = UUID().uuidString.lowercased() + "." + ext.lowercased()
        entries[issued] = Entry(file: directory.appendingPathComponent(issued), name: name, type: type, size: size)
        return reference(issued)
    }

    func importFile(_ source: URL, name: String, type: String) async throws -> [String: Any] {
        let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: source, options: .mappedIfSafe) }.value
        return try await importData(data, name: name, type: type)
    }

    func importData(_ data: Data, name: String, type: String) async throws -> [String: Any] {
        let ref = try create(name: name, type: type, size: data.count)
        let url = URL(string: ref["url"] as! String)!
        try await complete(url: url, body: data)
        return ref
    }

    func complete(url: URL, body: Data?) async throws {
        let name = try Self.issuedName(url)
        guard var entry = entries[name], !entry.hidden else { throw NativeError("badUrl", "Transfer no longer exists.") }
        guard !entry.attempted else { throw NativeError("busy", "Transfer upload was already attempted.") }
        // A reservation consumes exactly one POST, including malformed bodies or failed writes.
        entry.attempted = true
        entries[name] = entry
        guard let body, body.count == entry.size else { throw NativeError("transfer", "The upload body is missing or has the wrong size.") }
        entry.leases += 1
        entries[name] = entry
        do {
            let file = entry.file
            try await Task.detached(priority: .userInitiated) { try body.write(to: file, options: .atomic) }.value
            if var current = entries[name] { current.complete = true; entries[name] = current }
        } catch {
            releaseLease(name)
            throw NativeError("transfer", "Could not finish the upload.")
        }
        releaseLease(name)
    }

    func lease(url: URL) throws -> TransferLease {
        let name = try Self.issuedName(url)
        guard var entry = entries[name], entry.complete, !entry.hidden else { throw NativeError("badUrl", "Transfer is not readable.") }
        entry.leases += 1
        entries[name] = entry
        return TransferLease(url: entry.file, type: entry.type, size: entry.size) { [weak self] in self?.releaseLease(name) }
    }

    func data(for url: URL) async throws -> Data {
        let lease = try lease(url: url)
        defer { lease.release() }
        let file = lease.url
        return try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file, options: .mappedIfSafe) }.value
    }

    func type(for url: URL) throws -> String {
        let name = try Self.issuedName(url)
        guard let entry = entries[name], entry.complete, !entry.hidden else { throw NativeError("badUrl", "Transfer is not readable.") }
        return entry.type
    }

    func release(url: URL) throws {
        let name = try Self.issuedName(url)
        guard var entry = entries[name] else { return }
        entry.hidden = true
        entries[name] = entry
        removeIfUnused(name)
    }

    private func reference(_ name: String) -> [String: Any] {
        let entry = entries[name]!
        return ["url": NativeConfig.origin + "/xfer/" + name, "name": entry.name, "type": entry.type, "size": entry.size]
    }
    private func releaseLease(_ name: String) {
        guard var entry = entries[name] else { return }
        entry.leases = max(0, entry.leases - 1)
        entries[name] = entry
        removeIfUnused(name)
    }
    private func removeIfUnused(_ name: String) {
        guard let entry = entries[name], entry.hidden, entry.leases == 0 else { return }
        entries.removeValue(forKey: name)
        try? FileManager.default.removeItem(at: entry.file)
    }
}
