import Foundation
import UniformTypeIdentifiers

enum NativeConfig {
    static let origin = "gesso://localhost"
    static let entryURL = URL(string: origin + "/gesso/")!
    static let studioURL = URL(string: origin + "/gesso/studio/index.html")!
    static let capabilities = ["photos", "decode", "subject", "subject-matte", "haptic", "transfer-post"]
    static var app: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "1" }
    static func metadata(webRevision: String) -> [String: Any] {
        ["api": 1, "bridge": "gesso", "origin": origin, "app": app, "build": build,
         "web": webRevision, "capabilities": capabilities]
    }
    static func injectionScript(webRevision: String) -> String {
        let json = String(data: try! JSONSerialization.data(withJSONObject: metadata(webRevision: webRevision), options: [.sortedKeys]), encoding: .utf8)!
        return "Object.defineProperty(window,'__gessoNative',{value:Object.freeze(\(json)),writable:false,configurable:false});"
    }
    static func isLocal(_ url: URL) -> Bool {
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.scheme == "gesso" && c.host == "localhost" && c.user == nil && c.password == nil && c.port == nil
    }
}

struct NativeError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
    var envelope: [String: Any] { ["ok": false, "error": ["code": code, "message": message]] }
}

enum Arguments {
    static func string(_ args: [String: Any], _ key: String, max: Int = 1024) throws -> String {
        guard let value = args[key] as? String, !value.isEmpty, value.utf8.count <= max else {
            throw NativeError("badArgs", "Invalid \(key).")
        }
        return value
    }
    static func number(_ args: [String: Any], _ key: String) throws -> Double {
        guard let n = args[key] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else {
            throw NativeError("badArgs", "Invalid \(key).")
        }
        return n.doubleValue
    }
    static func integer(_ args: [String: Any], _ key: String, range: ClosedRange<Int>) throws -> Int {
        let n = try number(args, key)
        guard n.rounded() == n, n >= Double(range.lowerBound), n <= Double(range.upperBound) else {
            throw NativeError("badArgs", "Invalid \(key).")
        }
        return Int(n)
    }
    static func url(_ args: [String: Any]) throws -> URL {
        let text = try string(args, "url")
        guard let url = URL(string: text), NativeConfig.isLocal(url) else { throw NativeError("badUrl", "Invalid transfer URL.") }
        return url
    }
}
