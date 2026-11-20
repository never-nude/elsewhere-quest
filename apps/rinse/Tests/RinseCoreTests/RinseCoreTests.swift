import XCTest
@testable import RinseCore
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A throwaway home folder with files whose ages the tests control.
final class FakeHome {
    let url: URL
    let now = Date()

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rinse-tests-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    @discardableResult
    func file(_ relative: String, kilobytes: Int = 4, daysOld: Int = 0) throws -> URL {
        let target = url.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Random bytes, so no file system can store the file in less space than its length.
        var bytes = [UInt8](repeating: 0, count: kilobytes * 1000)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        try Data(bytes).write(to: target)
        age(target, days: daysOld)
        return target
    }

    @discardableResult
    func folder(_ relative: String, daysOld: Int = 0) throws -> URL {
        let target = url.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
        age(target, days: daysOld)
        return target
    }

    /// Sets both the access and the modification time to `days` ago.
    func age(_ target: URL, days: Int) {
        let then = now.addingTimeInterval(-Double(days) * 86_400 - 60)
        let stamp = timeval(tv_sec: Int(then.timeIntervalSince1970), tv_usec: 0)
        var times = [stamp, stamp]
        XCTAssertEqual(utimes(target.path, &times), 0)
    }

    /// Names the tests want treated as downloaded from the web, or as never opened.
    var downloaded: Set<String> = []
    var neverOpened: Set<String> = []
    var opened: Set<String> = []
    var archive: URL?
    /// Apps running or kept in the Dock, as full paths.
    var inUse: Set<String> = []

    func scan(_ rules: Rules = Rules(), screenshotFolder: URL? = nil) -> ScanResult {
        let (downloaded, neverOpened, opened) = (self.downloaded, self.neverOpened, self.opened)
        return Scanner(
            locations: Locations(home: url, screenshotFolder: screenshotFolder, archive: archive,
                                 applications: [url.appendingPathComponent("Applications")]),
            rules: rules, now: now,
            usage: { url in
                if neverOpened.contains(url.lastPathComponent) { return Usage(lastOpened: nil) }
                if opened.contains(url.lastPathComponent) { return Usage(lastOpened: Date(timeIntervalSince1970: 1)) }
                return nil
            },
            hasOrigin: { downloaded.contains($0.lastPathComponent) }, inUse: inUse).scan()
    }

    /// Writes a file with exactly these bytes, aged.
    @discardableResult
    func write(_ relative: String, _ data: Data, daysOld: Int = 1) throws -> URL {
        let target = url.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: target)
        age(target, days: daysOld)
        return target
    }

    /// Ages a folder and everything in it, the way an unpack or copy made a while ago looks.
    func ageTree(_ relative: String, days: Int) {
        let root = url.appendingPathComponent(relative)
        let inside = (FileManager.default.enumerator(atPath: root.path)?.allObjects as? [String]) ?? []
        for path in inside.reversed() {
            let target = root.appendingPathComponent(path)
            if FileStat(path: target.path)?.isSymlink == false { age(target, days: days) }
        }
        age(root, days: days)
    }

    /// Lays out an app bundle with an identifier and version, built `daysOld` days ago.
    @discardableResult
    func app(_ relative: String, id: String, version: String, build: String = "1", daysOld: Int = 1) throws -> URL {
        let bundle = url.appendingPathComponent(relative)
        let info: [String: Any] = ["CFBundleIdentifier": id, "CFBundleShortVersionString": version, "CFBundleVersion": build]
        try write(relative + "/Contents/Info.plist",
                  try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0), daysOld: daysOld)
        try write(relative + "/Contents/MacOS/" + bundle.deletingPathExtension().lastPathComponent,
                  Data(repeating: 7, count: 3000), daysOld: daysOld)
        for folder in ["Contents/MacOS", "Contents", ""] {
            age(folder.isEmpty ? bundle : bundle.appendingPathComponent(folder), days: daysOld)
        }
        return bundle
    }
}

/// Builds zip archives byte for byte (stored, not compressed), so tests need no outside tools.
struct ZipBuilder {
    enum Item {
        case file(String, Data)
        case folder(String)
        case link(String, String)
    }

    var items: [Item] = []

    func data() -> Data {
        var body = Data()
        var directory = Data()
        func le16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
        func le32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).littleEndian) { Data($0) } }
        for item in items {
            let (name, content, mode): (String, Data, Int)
            switch item {
            case .file(let n, let d): (name, content, mode) = (n, d, 0o100644)
            case .folder(let n): (name, content, mode) = (n.hasSuffix("/") ? n : n + "/", Data(), 0o040755)
            case .link(let n, let target): (name, content, mode) = (n, Data(target.utf8), 0o120755)
            }
            let nameData = Data(name.utf8)
            let offset = body.count
            body += le32(0x0403_4b50) + le16(10) + le16(0x0800) + le16(0) + le16(0) + le16(0)
            let crc = Int(CRC32.of(content))
            body += le32(crc) + le32(content.count) + le32(content.count) + le16(nameData.count) + le16(0)
            body += nameData + content
            directory += le32(0x0201_4b50) + le16(3 << 8 | 20) + le16(10) + le16(0x0800) + le16(0) + le16(0) + le16(0)
            directory += le32(crc) + le32(content.count) + le32(content.count)
            directory += le16(nameData.count) + le16(0) + le16(0) + le16(0) + le16(0)
            directory += le32(mode << 16) + le32(offset) + nameData
        }
        var end = le32(0x0605_4b50) + le16(0) + le16(0) + le16(items.count) + le16(items.count)
        end += le32(directory.count) + le32(body.count) + le16(0)
        return body + directory + end
    }
}

extension Data {
    static func noise(_ count: Int, seed: UInt8 = 1) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        var x = UInt32(seed) &* 2_654_435_761 | 1
        for i in bytes.indices {
            x ^= x << 13
            x ^= x >> 17
            x ^= x << 5
            bytes[i] = UInt8(truncatingIfNeeded: x)
        }
        return Data(bytes)
    }
}

/// Stands in for the Trash by moving items into a folder outside the fake home.
struct FolderTrasher: Trasher {
    let bin: URL
    func trash(_ url: URL) throws {
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        try FileManager.default.moveItem(at: url, to: bin.appendingPathComponent(UUID().uuidString + "-" + url.lastPathComponent))
    }
}

final class ScannerTests: XCTestCase {
    var home: FakeHome!

    override func setUpWithError() throws { home = try FakeHome() }
    override func tearDown() { home = nil }

    private func folder_verdict(_ result: ScanResult) -> Verdict? { find(result, "Old Project")?.verdict }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    func testOldScreenshotsArePreCheckedAndFreshOnesOnlyListed() throws {
        try home.file("Desktop/Screenshot 2026-11-01 at 9.41.00 AM.png", daysOld: 12)
        try home.file("Desktop/Screenshot 2026-11-18 at 8.00.00 AM.png", daysOld: 0)
        try home.file("Desktop/holiday.png", daysOld: 400)
        let result = home.scan()

        let old = try XCTUnwrap(find(result, "Screenshot 2026-11-01 at 9.41.00 AM.png"))
        XCTAssertEqual(old.category, .screenshots)
        XCTAssertEqual(old.verdict, .wash)
        XCTAssertEqual(old.reason, "Taken 12 days ago · no record of you opening it")
        let fresh = try XCTUnwrap(find(result, "Screenshot 2026-11-18 at 8.00.00 AM.png"))
        XCTAssertEqual(fresh.verdict, .leave)
        XCTAssertEqual(fresh.reason, "Taken today · still recent")
        XCTAssertNotEqual(find(result, "holiday.png")?.category, .screenshots, "an ordinary picture is not a screenshot")
        XCTAssertEqual(find(result, "holiday.png")?.verdict, .file, "but a year on the Desktop is long enough to file it")
    }

    func testScreenshotsInACustomFolderAreFound() throws {
        let shots = try home.folder("Pictures/Shots")
        try home.file("Pictures/Shots/Screenshot 1.png", daysOld: 30)
        XCTAssertNil(find(home.scan(), "Screenshot 1.png"))
        XCTAssertEqual(find(home.scan(screenshotFolder: shots), "Screenshot 1.png")?.category, .screenshots)
    }

    func testScreenRecordingsAreTheirOwnCategory() throws {
        try home.file("Desktop/Screen Recording 2026-10-01 at 3.00.00 PM.mov", daysOld: 40)
        try home.file("Movies/wedding.mov", daysOld: 40)
        let result = home.scan()
        XCTAssertEqual(find(result, "Screen Recording 2026-10-01 at 3.00.00 PM.mov")?.category, .recordings)
        XCTAssertNil(find(result, "wedding.mov"))
    }

    func testInstallersAreClaimedOnceAndNotAlsoListedAsStaleDownloads() throws {
        try home.file("Downloads/Xcode_26.dmg", daysOld: 45)
        try home.file("Downloads/tool.pkg", daysOld: 1)
        home.downloaded = ["Xcode_26.dmg", "tool.pkg"]
        let result = home.scan()
        XCTAssertEqual(result.findings.filter { $0.url.lastPathComponent == "Xcode_26.dmg" }.count, 1)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.category, .installers)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.verdict, .wash)
        XCTAssertEqual(find(result, "tool.pkg")?.verdict, .leave, "a one-day-old installer may not have been run yet")
    }

    func testStaleDownloadsAreListedButNeverPreChecked() throws {
        try home.file("Downloads/tax-return.pdf", daysOld: 200)
        try home.file("Downloads/Old Project/notes.txt", kilobytes: 50, daysOld: 200)
        home.age(home.url.appendingPathComponent("Downloads/Old Project"), days: 200)
        try home.file("Downloads/fresh.pdf", daysOld: 2)
        let result = home.scan()

        let pdf = try XCTUnwrap(find(result, "tax-return.pdf"))
        XCTAssertEqual(pdf.category, .staleDownloads)
        XCTAssertEqual(pdf.verdict, .file, "a document is filed, never washed")
        XCTAssertEqual(folder_verdict(result), .file)
        let folder = try XCTUnwrap(find(result, "Old Project"))
        XCTAssertTrue(folder.isDirectory)
        XCTAssertGreaterThanOrEqual(folder.bytes, 50_000, "a folder counts everything inside it")
        XCTAssertNil(find(result, "fresh.pdf"))
        XCTAssertNil(find(result, "notes.txt"), "files inside a listed folder are not listed again")
    }

    func testCachesSkipAppleAndTinyOnesAndPreCheckBigOnes() throws {
        var rules = Rules()
        rules.cacheListBytes = 50_000
        rules.cacheSuggestBytes = 300_000
        try home.file("Library/Caches/com.apple.Safari/data", kilobytes: 800)
        try home.file("Library/Caches/com.spotify.client/blob", kilobytes: 800)
        try home.file("Library/Caches/com.medium.app/blob", kilobytes: 100)
        try home.file("Library/Caches/com.tiny.app/blob", kilobytes: 1)
        let result = home.scan(rules)

        XCTAssertNil(find(result, "com.apple.Safari"))
        XCTAssertNil(find(result, "com.tiny.app"))
        XCTAssertEqual(find(result, "com.spotify.client")?.verdict, .wash)
        XCTAssertEqual(find(result, "com.medium.app")?.verdict, .leave)
        XCTAssertEqual(find(result, "com.spotify.client")?.category, .caches)
    }

    func testDeveloperLeftovers() throws {
        var rules = Rules()
        rules.cacheListBytes = 50_000
        rules.cacheSuggestBytes = 300_000
        try home.file("Library/Developer/Xcode/DerivedData/Old-abc/Build/x.o", kilobytes: 100)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Old-abc"), days: 20)
        try home.file("Library/Developer/Xcode/DerivedData/Live-def/Build/x.o", kilobytes: 100)
        try home.file(".npm/_cacache/content/blob", kilobytes: 500)
        try home.file(".cache/pip/wheel", kilobytes: 500)
        try home.file(".cache/somemodels/weights.bin", kilobytes: 500)
        try home.file(".cache/huggingface/token", kilobytes: 500)
        // Xcode writes deep inside a build folder, so the folder's own date says nothing.
        try home.file("Library/Developer/Xcode/DerivedData/Daily-ghi/Logs/Build/today.xcactivitylog", kilobytes: 100)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Daily-ghi"), days: 40)
        home.age(home.url.appendingPathComponent("Library/Developer/Xcode/DerivedData/Daily-ghi/Logs"), days: 40)
        let result = home.scan(rules)

        XCTAssertEqual(find(result, "Old-abc")?.verdict, .wash)
        XCTAssertEqual(find(result, "Live-def")?.verdict, .leave)
        XCTAssertEqual(find(result, "Daily-ghi")?.verdict, .leave, "built today, whatever the top folder says")
        XCTAssertEqual(find(result, "pip")?.verdict, .wash)
        XCTAssertEqual(find(result, "somemodels")?.verdict, .leave, "an unknown tool folder is never pre-chosen")
        XCTAssertNil(find(result, "huggingface"), "model and login stores are not listed at all")
        let npm = try XCTUnwrap(find(result, "_cacache"))
        XCTAssertEqual(npm.name, "npm cache")
        XCTAssertEqual(npm.category, .developer)
        XCTAssertEqual(npm.verdict, .wash)
        XCTAssertEqual(find(result, "pip")?.category, .developer)
    }

    func testBigIdleFilesAreFoundDeepButNotInsidePackages() throws {
        var rules = Rules()
        rules.bigFileBytes = 300_000
        try home.file("Documents/Archive/2019/render.mov", kilobytes: 600, daysOld: 300)
        try home.file("Documents/Archive/2019/small.txt", kilobytes: 2, daysOld: 300)
        try home.file("Documents/active.psd", kilobytes: 600, daysOld: 3)
        try home.file("Movies/Final.fcpbundle/media/clip.mov", kilobytes: 600, daysOld: 300)
        let result = home.scan(rules)

        let render = try XCTUnwrap(find(result, "render.mov"))
        XCTAssertEqual(render.category, .bigIdle)
        XCTAssertEqual(render.verdict, .leave, "same disk: moving it would free nothing")
        XCTAssertNil(find(result, "small.txt"))
        XCTAssertNil(find(result, "active.psd"))
        XCTAssertNil(find(result, "clip.mov"), "a library or project bundle is one document")
    }

    func testIgnoredPathsAndDisabledCategoriesStayOut() throws {
        let shot = try home.file("Desktop/Screenshot keep.png", daysOld: 30)
        try home.file("Downloads/app.dmg", daysOld: 30)
        var rules = Rules()
        rules.ignored = [shot.path]
        rules.disabled = [.installers, .staleDownloads]
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testAnEmptyHomeScansClean() {
        let result = home.scan()
        XCTAssertTrue(result.findings.isEmpty)
        XCTAssertEqual(result.totalBytes, 0)
        XCTAssertTrue(result.categories.isEmpty)
    }

    func testTotals() throws {
        try home.file("Desktop/Screenshot a.png", kilobytes: 100, daysOld: 30)
        try home.file("Desktop/Screenshot b.png", kilobytes: 100, daysOld: 0)
        let result = home.scan()
        XCTAssertEqual(result.categories, [.screenshots])
        XCTAssertGreaterThanOrEqual(result.totalBytes, 200_000)
        XCTAssertLessThan(result.washBytes, result.totalBytes)
        XCTAssertGreaterThan(result.washBytes, 0)
        XCTAssertEqual(result.bytes(in: .screenshots), result.totalBytes)
    }
}

extension ScannerTests {
    func testADiskImageWithNoDownloadRecordIsNeverWashed() throws {
        try home.file("Desktop/Taxes.dmg", daysOld: 45)
        try home.file("Downloads/Installer.dmg", daysOld: 45)
        home.downloaded = ["Installer.dmg"]
        let result = home.scan()
        XCTAssertEqual(find(result, "Installer.dmg")?.verdict, .wash)
        let own = try XCTUnwrap(find(result, "Taxes.dmg"))
        XCTAssertEqual(own.verdict, .file)
        XCTAssertTrue(own.reason.contains("may be your own"))
    }

    func testOpenedScreenshotsAreFiledAndUnopenedOnesGo() throws {
        try home.file("Desktop/Screenshot used.png", daysOld: 30)
        try home.file("Desktop/Screenshot unused.png", daysOld: 30)
        try home.file("Desktop/Screen Recording used.mov", daysOld: 30)
        try home.file("Desktop/Screen Recording unused.mov", daysOld: 30)
        home.opened = ["Screenshot used.png", "Screen Recording used.mov"]
        let result = home.scan()
        XCTAssertEqual(find(result, "Screenshot used.png")?.verdict, .file)
        XCTAssertEqual(find(result, "Screenshot unused.png")?.verdict, .wash)
        XCTAssertEqual(find(result, "Screen Recording used.mov")?.verdict, .file)
        XCTAssertEqual(find(result, "Screen Recording unused.mov")?.verdict, .file, "a recording is never washed on silence")
    }

    func testDownloadsSplitByWhatTheyAre() throws {
        try home.file("Downloads/project.zip", daysOld: 90)
        try home.file("Downloads/statement.pdf", daysOld: 90)
        try home.file("Downloads/clip.mov", daysOld: 90)
        try home.file("Downloads/portfolio.zip", daysOld: 90)
        try home.file("Downloads/IMG_1234.CR2", daysOld: 90)
        try home.file("Downloads/Tool.app/Contents/MacOS/tool", daysOld: 90)
        home.age(home.url.appendingPathComponent("Downloads/Tool.app"), days: 90)
        try FileManager.default.createSymbolicLink(atPath: home.url.appendingPathComponent("Downloads/latest").path,
                                                   withDestinationPath: "project.zip")
        home.downloaded = ["project.zip", "statement.pdf", "clip.mov", "IMG_1234.CR2"]
        let result = home.scan()
        XCTAssertEqual(find(result, "project.zip")?.verdict, .wash)
        XCTAssertEqual(find(result, "portfolio.zip")?.verdict, .file, "an archive with no download record may be the only copy")
        XCTAssertEqual(find(result, "IMG_1234.CR2")?.verdict, .file, "an unknown kind of file is never washed")
        XCTAssertNil(find(result, "Tool.app"))
        XCTAssertNil(find(result, "latest"))
        XCTAssertEqual(find(result, "statement.pdf")?.verdict, .file, "a document stays yours even if it could be fetched again")
        XCTAssertEqual(find(result, "clip.mov")?.verdict, .file)
    }

    func testTheFilingFolderIsNeverScanned() throws {
        home.archive = home.url.appendingPathComponent("Downloads/Filed")
        try home.file("Downloads/Filed/Screenshots/2025-01/Screenshot old.png", daysOld: 300)
        home.age(home.url.appendingPathComponent("Downloads/Filed"), days: 300)
        var rules = Rules()
        rules.bigFileBytes = 1
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testRecommendationsComeSurestFirst() throws {
        try home.file("Desktop/Screenshot a.png", daysOld: 8)
        try home.file("Desktop/Screenshot b.png", daysOld: 300)
        let washes = home.scan().findings(recommended: .wash)
        XCTAssertEqual(washes.map(\.url.lastPathComponent), ["Screenshot b.png", "Screenshot a.png"])
        XCTAssertGreaterThan(washes[0].assessment.confidence, washes[1].assessment.confidence)
    }
}

final class JudgeTests: XCTestCase {
    private func judge(_ kind: Residue, _ name: String = "x", idle: Int = 0, limit: Judge.Limit = .age(days: 7),
                       bytes: Int64 = 0, origin: Bool = false, usage: Usage? = nil, directory: Bool = false,
                       otherDisk: Bool = false) -> Assessment {
        Judge.assess(Judge.Evidence(kind: kind, name: name, isDirectory: directory, bytes: bytes, idleDays: idle,
                                    limit: limit, hasOrigin: origin, usage: usage, filingFreesSpace: otherDisk))
    }

    func testNothingIsRecommendedBeforeItsLimit() {
        for kind in Residue.allCases {
            XCTAssertEqual(judge(kind, idle: 6, limit: .age(days: 7), origin: true).verdict, .leave, "\(kind)")
        }
        XCTAssertEqual(judge(.caches, limit: .size(bytes: 100), bytes: 99).verdict, .leave)
        XCTAssertEqual(judge(.caches, limit: .size(bytes: 100), bytes: 100).verdict, .wash)
    }

    func testConfidenceGrowsWithIdleTimeAndStaysInRange() {
        var last = 0
        for idle in [7, 14, 30, 90, 400, 4000] {
            let a = judge(.screenshots, idle: idle)
            XCTAssertEqual(a.verdict, .wash)
            XCTAssertGreaterThanOrEqual(a.confidence, last)
            XCTAssertTrue((0...100).contains(a.confidence))
            last = a.confidence
        }
        XCTAssertGreaterThan(last, judge(.screenshots, idle: 7).confidence)
    }

    func testYourOwnThingsAreFiledNotWashed() {
        XCTAssertEqual(judge(.staleDownloads, "thesis.pages", idle: 400, limit: .age(days: 30)).verdict, .file)
        XCTAssertEqual(judge(.staleDownloads, "Project", idle: 400, limit: .age(days: 30), directory: true).verdict, .file)
        XCTAssertEqual(judge(.staleDownloads, "photo.heic", idle: 400, limit: .age(days: 30), origin: true,
                             usage: Usage(lastOpened: nil)).verdict, .file)
        for kind in [Residue.staleDownloads, .bigIdle] {
            for name in ["unknown.xyz", "noextension", "passwords.kdbx"] {
                XCTAssertNotEqual(judge(kind, name, idle: 4000, limit: .age(days: 30), origin: true,
                                        usage: Usage(lastOpened: nil), otherDisk: true).verdict, .wash, name)
            }
            XCTAssertNotEqual(judge(kind, "backup.dmg", idle: 4000, limit: .age(days: 30)).verdict, .wash)
            XCTAssertEqual(judge(kind, "bundle.zip", idle: 400, limit: .age(days: 30), origin: true).verdict, .wash)
        }
        XCTAssertEqual(judge(.screenshots, idle: 0, limit: .age(days: 0)).verdict, .leave, "a limit of 0 still means a day")
    }

    func testBigIdleFilesAreOnlyFiledWhenThatFreesSpace() {
        XCTAssertEqual(judge(.bigIdle, "render.mov", idle: 400, limit: .age(days: 60)).verdict, .leave)
        XCTAssertEqual(judge(.bigIdle, "render.mov", idle: 400, limit: .age(days: 60), otherDisk: true).verdict, .file)
        XCTAssertEqual(judge(.bigIdle, "ubuntu.iso", idle: 400, limit: .age(days: 60), origin: true).verdict, .wash)
    }

    func testRenamedCapturesAndUnknownToolDataAreProtected() {
        var e = Judge.Evidence(kind: .screenshots, name: "Passport receipt.png", idleDays: 400, limit: .age(days: 7))
        e.renamed = true
        XCTAssertEqual(Judge.assess(e).verdict, .file)
        var tool = Judge.Evidence(kind: .developer, name: "models", bytes: 1_000_000_000, idleDays: 0, limit: .size(bytes: 100))
        tool.regenerable = false
        XCTAssertEqual(Judge.assess(tool).verdict, .leave)
    }
}

final class FilerTests: XCTestCase {
    func testFilingSortsByKindAndMonthAndNeverOverwrites() throws {
        let home = try FakeHome()
        let archive = home.url.appendingPathComponent("Documents/Filed Away")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = TimeZone(identifier: "UTC")!
        try home.file("Downloads/statement.pdf", daysOld: 90)
        let first = home.scan().findings
        XCTAssertEqual(first.map(\.verdict), [.file])
        let month = Filer.folder(for: first[0], home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(month.deletingLastPathComponent().lastPathComponent, "From Downloads")
        XCTAssertEqual(month.lastPathComponent.count, 7)

        let one = Filer.file(first, home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(one.filed.map(\.destination.lastPathComponent), ["statement.pdf"])
        XCTAssertTrue(one.failures.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: first[0].url.path))

        try home.file("Downloads/statement.pdf", daysOld: 90)
        let two = Filer.file(home.scan().findings, home: home.url, archive: archive, calendar: utc)
        XCTAssertEqual(two.filed.map(\.destination.lastPathComponent), ["statement 2.pdf"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: month.path).sorted(), ["statement 2.pdf", "statement.pdf"])
        XCTAssertTrue(home.scan().findings.isEmpty, "filed items are out of Rinse's sight")
    }

    func testABigFileKeepsItsPlaceWhenFiled() throws {
        let home = try FakeHome()
        let other = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-archive-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: other) }
        let url = try home.file("Documents/Clients/Acme/footage/interview.mov", kilobytes: 8, daysOld: 400)
        let finding = Finding(url: url, name: "interview.mov", category: .bigIdle, bytes: 8000,
                              lastTouched: home.now.addingTimeInterval(-400 * 86_400), isDirectory: false,
                              assessment: Assessment(verdict: .file, confidence: 90, reasons: []))
        let report = Filer.file([finding], home: home.url, archive: other)
        XCTAssertEqual(report.filed.first?.destination.path,
                       other.appendingPathComponent("Big and idle/Documents/Clients/Acme/footage/interview.mov").path)
    }

    func testNothingMovesIfItChangedSinceTheScan() throws {
        let home = try FakeHome()
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: bin) }
        let shot = try home.file("Desktop/Screenshot a.png", daysOld: 30)
        let doc = try home.file("Downloads/statement.pdf", daysOld: 90)
        let found = home.scan().findings
        XCTAssertEqual(found.count, 2)
        home.age(shot, days: 0)   // someone edited both after Rinse looked
        home.age(doc, days: 0)
        let wash = Washer.wash(found.filter { $0.verdict == .wash }, home: home.url, trasher: FolderTrasher(bin: bin))
        let file = Filer.file(found.filter { $0.verdict == .file }, home: home.url, archive: home.url.appendingPathComponent("Documents/Filed Away"))
        XCTAssertEqual(wash.failures.map(\.message) + file.failures.map(\.message),
                       ["Changed since Rinse looked", "Changed since Rinse looked"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: shot.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: doc.path))
    }

    func testAFilingFolderInAScannedPlaceGetsItsOwnFolder() throws {
        let home = URL(fileURLWithPath: "/Users/someone")
        func filing(_ path: String?) -> String {
            Locations.filingFolder(chosen: path.map { URL(fileURLWithPath: $0) }, home: home,
                                   screenshotFolder: URL(fileURLWithPath: "/Users/someone/Pictures/Shots")).path
        }
        XCTAssertEqual(filing(nil), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents"), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents/"), "/Users/someone/Documents/Filed Away")
        XCTAssertEqual(filing("/Users/someone"), "/Users/someone/Filed Away")
        XCTAssertEqual(filing("/Users"), "/Users/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Pictures/Shots"), "/Users/someone/Pictures/Shots/Filed Away")
        XCTAssertEqual(filing("/Users/someone/Documents/Archive"), "/Users/someone/Documents/Archive")
        XCTAssertEqual(filing("/Volumes/Backup/Filed"), "/Volumes/Backup/Filed")
    }

    func testFiledThingsNeverComeBackAsFindings() throws {
        let home = try FakeHome()
        home.archive = home.url.appendingPathComponent("Documents")   // the owner picked Documents itself
        try home.file("Downloads/statement.pdf", daysOld: 90)
        let found = home.scan().findings
        let archive = Locations(home: home.url, archive: home.archive).archive
        XCTAssertEqual(archive.lastPathComponent, "Filed Away")
        XCTAssertEqual(Filer.file(found, home: home.url, archive: archive).filed.count, 1)
        var rules = Rules()
        rules.bigFileBytes = 1
        rules.bigFileIdleDays = 1
        XCTAssertTrue(home.scan(rules).findings.isEmpty)
    }

    func testAFolderThatHoldsTheFilingFolderIsNeverAFindingAndNeverWashed() throws {
        let home = try FakeHome()
        home.archive = home.url.appendingPathComponent("Downloads/Old/Filed")
        try home.file("Downloads/Old/Filed/Screenshots/2025-01/keep.png", daysOld: 300)
        let old = home.url.appendingPathComponent("Downloads/Old")
        home.age(old, days: 300)
        XCTAssertTrue(home.scan().findings.isEmpty)
        let forced = Finding(url: old, name: "Old", category: .staleDownloads, bytes: 1, lastTouched: Date(),
                             isDirectory: true, assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = Washer.wash([forced], home: home.url, archive: home.archive,
                                 trasher: FolderTrasher(bin: home.url.appendingPathComponent("bin")))
        XCTAssertEqual(report.failures.map(\.message), ["It holds the filing folder"])
    }

    func testFilingRefusesCachesProtectedPlacesAndItself() throws {
        let home = try FakeHome()
        let archive = try home.folder("Documents/Filed Away")
        func finding(_ url: URL, _ kind: Residue) -> Finding {
            Finding(url: url, name: url.lastPathComponent, category: kind, bytes: 1, lastTouched: Date(),
                    isDirectory: true, assessment: Assessment(verdict: .file, confidence: 100, reasons: []))
        }
        let cache = try home.folder("Library/Caches/com.some.app")
        let documents = home.url.appendingPathComponent("Documents")
        let inside = try home.folder("Documents/Filed Away/Screenshots")
        let report = Filer.file(
            [finding(cache, .caches), finding(documents, .bigIdle), finding(inside, .bigIdle), finding(archive, .bigIdle)],
            home: home.url, archive: archive)
        XCTAssertTrue(report.filed.isEmpty)
        XCTAssertEqual(report.failures.count, 4)
        XCTAssertTrue(FileManager.default.fileExists(atPath: cache.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: inside.path))
    }
}

extension ScannerTests {
    func testAFolderIsAsFreshAsTheNewestThingInside() throws {
        try home.file("Downloads/thesis/chapters/ch3.tex", daysOld: 1)
        try home.file("Downloads/abandoned/notes.txt", daysOld: 200)
        for name in ["thesis", "thesis/chapters", "abandoned"] {
            home.age(home.url.appendingPathComponent("Downloads/" + name), days: 200)
        }
        let result = home.scan()
        XCTAssertNil(find(result, "thesis"), "edited yesterday, whatever the folder's own date says")
        XCTAssertEqual(find(result, "abandoned")?.verdict, .file)
    }

    func testOnlyAWebAddressCountsAsADownloadRecord() throws {
        func record(_ values: [String]) throws -> Data {
            try PropertyListSerialization.data(fromPropertyList: values, format: .binary, options: 0)
        }
        XCTAssertTrue(FileStat.isWebOrigin(try record(["https://example.com/app.dmg", "https://example.com/"])))
        XCTAssertTrue(FileStat.isWebOrigin(try record(["", "HTTP://example.com/file.zip"])))
        XCTAssertFalse(FileStat.isWebOrigin(try record(["Someone's iPhone"])), "AirDrop")
        XCTAssertFalse(FileStat.isWebOrigin(try record(["message:%3Cabc@mail.example%3E"])), "Mail")
        XCTAssertFalse(FileStat.isWebOrigin(try record([])))
        XCTAssertFalse(FileStat.isWebOrigin(Data("not a property list".utf8)))
    }
}

final class RedundancyTests: XCTestCase {
    var home: FakeHome!

    override func setUpWithError() throws { home = try FakeHome() }
    override func tearDown() { home = nil }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    /// The zip Wash-0.2.1.zip in the screenshot: an app with a framework symlink inside.
    private func washZip(_ seed: UInt8 = 1) -> ZipBuilder {
        ZipBuilder(items: [
            .folder("Wash.app"), .folder("Wash.app/Contents"),
            .file("Wash.app/Contents/Info.plist", .noise(300, seed: seed)),
            .file("Wash.app/Contents/MacOS/Wash", .noise(4000, seed: seed &+ 1)),
            .link("Wash.app/Contents/Frameworks/Current", "A"),
            .file("__MACOSX/Wash.app/._Info.plist", .noise(80)),
        ])
    }

    /// Writes the zip's contents out the way Archive Utility would, under another top-level name.
    private func unpack(_ zip: ZipBuilder, as top: String, in folder: String, daysOld: Int = 1) throws {
        for item in zip.items {
            switch item {
            case .file(let name, let data):
                guard !name.hasPrefix("__MACOSX") else { continue }
                try home.write(folder + "/" + top + name.drop(while: { $0 != "/" }), data, daysOld: daysOld)
            case .folder(let name):
                try FileManager.default.createDirectory(
                    at: home.url.appendingPathComponent(folder + "/" + top + name.drop(while: { $0 != "/" })),
                    withIntermediateDirectories: true)
            case .link(let name, let target):
                let path = home.url.appendingPathComponent(folder + "/" + top + name.drop(while: { $0 != "/" }))
                try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.createSymbolicLink(atPath: path.path, withDestinationPath: target)
            }
        }
        home.ageTree(folder + "/" + top, days: daysOld)
    }

    func testAnArchiveAlreadyUnpackedCanGoEvenIfItIsFromToday() throws {
        let zip = washZip()
        try home.write("Downloads/Wash-0.2.1.zip", zip.data())
        try unpack(zip, as: "Wash 2.app", in: "Downloads")   // Wash.app was taken, so Finder made "Wash 2"
        try home.app("Downloads/Wash.app", id: "other.wash", version: "1")
        let finding = try XCTUnwrap(find(home.scan(), "Wash-0.2.1.zip"))
        XCTAssertEqual(finding.category, .redundant)
        XCTAssertEqual(finding.verdict, .wash)
        XCTAssertEqual(finding.keeps?.lastPathComponent, "Wash 2.app")
        XCTAssertTrue(finding.reason.contains("already unpacked as “Wash 2”"), finding.reason)
        XCTAssertGreaterThanOrEqual(finding.assessment.confidence, 90)
    }

    func testAnArchiveIsKeptWhenTheUnpackedCopyDiffers() throws {
        let zip = washZip()
        try home.write("Downloads/Wash-0.2.1.zip", zip.data())
        try unpack(washZip(9), as: "Wash.app", in: "Downloads")   // same names, different contents
        XCTAssertNil(find(home.scan(), "Wash-0.2.1.zip"))
    }

    func testSameLengthsAreNotEnoughTheContentsMustMatch() throws {
        // A rebuilt app often keeps every file's length: here only the version number changed.
        let old = ZipBuilder(items: [.file("Wash.app/Contents/Info.plist", Data("<string>0.2.0</string>".utf8))])
        let new = ZipBuilder(items: [.file("Wash.app/Contents/Info.plist", Data("<string>0.2.1</string>".utf8))])
        try home.write("Downloads/Wash-0.2.1.zip", new.data())
        try unpack(old, as: "Wash.app", in: "Downloads")
        XCTAssertNil(find(home.scan(), "Wash-0.2.1.zip"), "the archive holds a newer build than the unpacked copy")
        XCTAssertEqual(CRC32.of(Data("123456789".utf8)), 0xCBF4_3926, "the standard check value")
    }

    /// The archives real tools make: `zip` (compressed, links kept) and, on a Mac, `ditto`,
    /// which is what Finder's Compress uses.
    func testArchivesMadeByRealTools() throws {
        let tools = [("/usr/bin/zip", ["-q", "-r", "-y"]), ("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent"])]
            .filter { FileManager.default.isExecutableFile(atPath: $0.0) }
        guard !tools.isEmpty else { throw XCTSkip("no zip tool on this machine") }
        try home.write("Downloads/Noctilucent/src/main.swift", Data(String(repeating: "let x = 1\n", count: 500).utf8))
        try home.write("Downloads/Noctilucent/Résumé notes.md", Data("ünïcode name".utf8))
        try FileManager.default.createSymbolicLink(
            atPath: home.url.appendingPathComponent("Downloads/Noctilucent/latest").path, withDestinationPath: "src")
        home.ageTree("Downloads/Noctilucent", days: 1)
        for (tool, flags) in tools {
            let zip = home.url.appendingPathComponent("Downloads/Noctilucent-source.zip")
            try? FileManager.default.removeItem(at: zip)
            let process = Process()
            process.executableURL = URL(fileURLWithPath: tool)
            process.currentDirectoryURL = home.url.appendingPathComponent("Downloads")
            process.arguments = flags + (tool.hasSuffix("ditto") ? ["Noctilucent", zip.path] : [zip.path, "Noctilucent"])
            try process.run()
            process.waitUntilExit()
            XCTAssertEqual(process.terminationStatus, 0, tool)
            home.age(zip, days: 1)
            let entries = try XCTUnwrap(JoinedFile(paths: [zip.path]).flatMap { ZipIndex.entries(of: $0) }, tool)
            XCTAssertTrue(entries.contains { $0.path == "Noctilucent/latest" && $0.kind == .symlink } || tool.hasSuffix("ditto"), tool)
            XCTAssertEqual(find(home.scan(), "Noctilucent-source.zip")?.keeps?.lastPathComponent, "Noctilucent", tool)
            // Change one byte in the unpacked copy and the archive is the only copy again.
            let main = home.url.appendingPathComponent("Downloads/Noctilucent/src/main.swift")
            let original = try Data(contentsOf: main)
            var changed = original
            changed[0] = UInt8(ascii: "v")
            try changed.write(to: main)
            home.ageTree("Downloads/Noctilucent", days: 1)
            XCTAssertNil(find(home.scan(), "Noctilucent-source.zip"), tool)
            try original.write(to: main)
            home.ageTree("Downloads/Noctilucent", days: 1)
        }
    }

    func testAnArchiveWithSeveralTopLevelItemsUnpacksIntoAFolderNamedAfterIt() throws {
        let zip = ZipBuilder(items: [.file("index.html", .noise(500)), .file("app.js", .noise(900, seed: 4))])
        try home.write("Downloads/Worldbook.zip", zip.data())
        try home.write("Downloads/Worldbook/index.html", .noise(500))
        try home.write("Downloads/Worldbook/app.js", .noise(900, seed: 4))
        try home.write("Downloads/Worldbook/notes I added.txt", .noise(10))   // extra files do not matter
        home.ageTree("Downloads/Worldbook", days: 1)
        XCTAssertEqual(find(home.scan(), "Worldbook.zip")?.keeps?.lastPathComponent, "Worldbook")
    }

    func testAFreshArchiveIsLeftAlone() throws {
        let zip = washZip()
        try home.write("Downloads/Wash-0.2.1.zip", zip.data(), daysOld: 0)
        try unpack(zip, as: "Wash.app", in: "Downloads")
        XCTAssertNil(find(home.scan(), "Wash-0.2.1.zip"), "it may still be downloading")
    }

    func testReadingAnArchiveDoesNotMakeItLookUsed() throws {
        let zip = washZip()
        let url = try home.write("Downloads/Unrelated.zip", zip.data(), daysOld: 40)
        let before = try XCTUnwrap(FileStat(path: url.path)).accessed
        _ = home.scan()
        XCTAssertEqual(try XCTUnwrap(FileStat(path: url.path)).accessed.timeIntervalSince1970,
                       before.timeIntervalSince1970, accuracy: 1)
    }

    func testEveryPieceOfASplitArchiveCanGoOnceItIsUnpacked() throws {
        let zip = washZip()
        let bytes = zip.data()
        let cut = [0, bytes.count / 3, 2 * bytes.count / 3, bytes.count]
        for i in 0..<3 {
            try home.write("Downloads/Atrium-Pose.part0\(i + 1)", bytes.subdata(in: cut[i]..<cut[i + 1]))
        }
        try unpack(zip, as: "Wash.app", in: "Downloads")
        let result = home.scan()
        for i in 1...3 {
            let part = try XCTUnwrap(find(result, "Atrium-Pose.part0\(i)"))
            XCTAssertEqual(part.verdict, .wash)
            XCTAssertEqual(part.reason, "Piece \(i) of 3 · the archive is already unpacked as “Wash”")
        }
    }

    func testASplitArchiveWithAMissingPieceIsLeftAlone() throws {
        let bytes = washZip().data()
        try home.write("Downloads/Atrium-Pose.part01", bytes.prefix(200))
        try home.write("Downloads/Atrium-Pose.part03", bytes.suffix(from: 400))
        try unpack(washZip(), as: "Wash.app", in: "Downloads")
        XCTAssertNil(find(home.scan(), "Atrium-Pose.part01"))
    }

    func testOlderBuildsGoAndTheNewestStays() throws {
        try home.app("Downloads/Atrium Pose Preview 7.app", id: "earth.atrium.pose", version: "3.4.1", daysOld: 2)
        try home.app("Downloads/Atrium Pose Preview 8.app", id: "earth.atrium.pose", version: "3.4.3", daysOld: 1)
        try home.app("Downloads/Atrium Pose Preview.app", id: "earth.atrium.pose", version: "1.0", build: "3", daysOld: 3)
        try home.app("Downloads/Other.app", id: "some.other", version: "1.0")
        let result = home.scan()
        XCTAssertNil(find(result, "Atrium Pose Preview 8.app"))
        XCTAssertNil(find(result, "Other.app"))
        let seven = try XCTUnwrap(find(result, "Atrium Pose Preview 7.app"))
        XCTAssertEqual(seven.verdict, .wash)
        XCTAssertEqual(seven.reason, "Atrium Pose Preview 7 3.4.1 · an older build; “Atrium Pose Preview 8” is newer")
        XCTAssertEqual(find(result, "Atrium Pose Preview.app")?.keeps?.lastPathComponent, "Atrium Pose Preview 8.app")
    }

    func testSameVersionBuildsAreOrderedByWhenTheyWereBuilt() throws {
        try home.app("Downloads/Wash.app", id: "quest.wash", version: "0.2", daysOld: 3)
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.2", daysOld: 1)
        let result = home.scan()
        XCTAssertNil(find(result, "Wash 2.app"))
        XCTAssertEqual(find(result, "Wash.app")?.keeps?.lastPathComponent, "Wash 2.app")
    }

    func testAnAppInUseIsNeverMoved() throws {
        let old = try home.app("Downloads/Wash.app", id: "quest.wash", version: "0.1")
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.2")
        home.inUse = [old.path]
        XCTAssertNil(find(home.scan(), "Wash.app"), "running, or kept in the Dock")
    }

    func testABuildInDownloadsGoesWhenTheSameOrNewerIsInstalled() throws {
        try home.app("Applications/Atrium Pose.app", id: "earth.atrium.pose", version: "3.4.3")
        try home.app("Downloads/Atrium Pose.app", id: "earth.atrium.pose", version: "3.4.3")
        try home.app("Downloads/Atrium Pose Preview 6.app", id: "earth.atrium.pose", version: "3.4.0")
        try home.app("Downloads/Wash.app", id: "quest.wash", version: "0.3")
        try home.app("Applications/Wash.app", id: "quest.wash", version: "0.2")
        let result = home.scan()
        XCTAssertEqual(find(result, "Atrium Pose.app")?.reason, "Atrium Pose 3.4.3 · the same build is installed in Applications")
        XCTAssertEqual(find(result, "Atrium Pose Preview 6.app")?.reason,
                       "Atrium Pose Preview 6 3.4.0 · an older build; Atrium Pose 3.4.3 is installed in Applications")
        XCTAssertNil(find(result, "Wash.app"), "newer than the installed one: maybe about to be installed")
        XCTAssertNil(result.findings.first { $0.url.path.contains("/Applications/") }, "Applications is never touched")
    }

    func testInstallersGoOnceTheAppIsInstalled() throws {
        try home.app("Applications/Atrium Pose.app", id: "earth.atrium.pose", version: "3.4.3")
        try home.write("Downloads/Install Atrium Pose.command", .noise(2000))
        let installerApp = ZipBuilder(items: [.file("Atrium Pose Installer.app/Contents/Info.plist", .noise(300, seed: 2))])
        try home.write("Downloads/Atrium-Pose-Installer.zip", installerApp.data())
        try home.write("Downloads/Atrium-Pose-Applications-Installer.zip",
                       ZipBuilder(items: [.file("Atrium Pose.pkg", .noise(900, seed: 3))]).data())
        try home.write("Downloads/Atrium-Pose-Setup.zip", .noise(1200, seed: 3))   // not a zip at all
        try home.write("Downloads/Install Something Else.command", .noise(100, seed: 4))
        try home.write("Downloads/Atrium Pose notes.txt", .noise(100, seed: 5))
        let result = home.scan()
        for name in ["Install Atrium Pose.command", "Atrium-Pose-Installer.zip", "Atrium-Pose-Applications-Installer.zip"] {
            let finding = try XCTUnwrap(find(result, name), name)
            XCTAssertEqual(finding.verdict, .wash)
            XCTAssertTrue(finding.reason.hasSuffix("Atrium Pose is already installed"), finding.reason)
        }
        XCTAssertNil(find(result, "Install Something Else.command"))
        XCTAssertNil(find(result, "Atrium-Pose-Setup.zip"), "a zip counts only when it holds an app, package or disk image")
        XCTAssertNil(find(result, "Atrium Pose notes.txt"), "not an installer")
    }

    func testExactCopiesGoAndTheOriginalStays() throws {
        try home.write("Downloads/Daybreak.zip", .noise(5000, seed: 7), daysOld: 2)
        try home.write("Downloads/Daybreak (1).zip", .noise(5000, seed: 7), daysOld: 1)
        try home.write("Downloads/Similar.zip", .noise(5000, seed: 8))     // same size, other bytes
        try home.write("Downloads/Daybreak/src/main.js", .noise(700, seed: 9))
        try home.write("Downloads/Daybreak 2/src/main.js", .noise(700, seed: 9))
        try home.write("Downloads/Daybreak 3/src/main.js", .noise(700, seed: 10))  // edited copy
        for name in ["Daybreak", "Daybreak 2", "Daybreak 3"] { home.ageTree("Downloads/" + name, days: 1) }
        let result = home.scan()
        XCTAssertNil(find(result, "Daybreak.zip"))
        XCTAssertNil(find(result, "Similar.zip"))
        XCTAssertEqual(find(result, "Daybreak (1).zip")?.reason, "Copy from yesterday · an exact copy of “Daybreak.zip”")
        XCTAssertNil(find(result, "Daybreak"))
        XCTAssertEqual(find(result, "Daybreak 2")?.keeps?.lastPathComponent, "Daybreak")
        XCTAssertNil(find(result, "Daybreak 3"), "different contents")
    }

    func testUnfinishedDownloadsGoAfterADay() throws {
        try home.write("Downloads/movie.mp4.crdownload", .noise(900), daysOld: 2)
        try home.write("Downloads/new.zip.crdownload", .noise(900), daysOld: 0)
        let result = home.scan()
        XCTAssertEqual(find(result, "movie.mp4.crdownload")?.verdict, .wash)
        XCTAssertNil(find(result, "new.zip.crdownload"))
    }

    func testNamesThatMarkACopy() {
        for name in ["Report copy.pdf", "Report copy 2.pdf", "Daybreak (1).zip", "Wash 2.app", "Daybreak 3"] {
            XCTAssertTrue(Scanner.isCopyName(name), name)
        }
        for name in ["Report.pdf", "Daybreak", "Area 51 Notes.txt", "copy.txt", "Version 2026"] {
            XCTAssertFalse(Scanner.isCopyName(name), name)
        }
        XCTAssertEqual(Scanner.productKey("Atrium-Pose-Applications-Installer copy"), "atrium pose")
        XCTAssertEqual(Scanner.productKey("Install Atrium Pose"), "atrium pose")
        XCTAssertEqual(Scanner.splitPart("Atrium-Pose.part08")?.number, 8)
        XCTAssertEqual(Scanner.splitPart("backup.zip.003")?.base, "backup.zip")
        XCTAssertNil(Scanner.splitPart("video.part"))
        XCTAssertNil(Scanner.splitPart("song.mp3"))
    }

    // MARK: - The last check

    func testNothingRedundantMovesIfItsOtherCopyIsGone() throws {
        let zip = washZip()
        try home.write("Downloads/Wash-0.2.1.zip", zip.data())
        try unpack(zip, as: "Wash.app", in: "Downloads")
        let found = home.scan().findings
        XCTAssertEqual(found.count, 1)
        try FileManager.default.removeItem(at: home.url.appendingPathComponent("Downloads/Wash.app"))
        let report = Washer.wash(found, home: home.url, trasher: FolderTrasher(bin: home.url.appendingPathComponent("bin")))
        XCTAssertEqual(report.failures.map(\.message), ["Its other copy is gone or going too"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.url.appendingPathComponent("Downloads/Wash-0.2.1.zip").path))
    }

    func testAnArchiveAndItsOnlyCopyNeverGoTogether() throws {
        let zip = washZip()
        try home.write("Downloads/Wash-0.2.1.zip", zip.data())
        try unpack(zip, as: "Wash.app", in: "Downloads")
        let archive = try XCTUnwrap(home.scan().findings.first)
        let copy = home.url.appendingPathComponent("Downloads/Wash.app")
        let overruled = Finding(url: copy, name: "Wash.app", category: .staleDownloads, bytes: 1, lastTouched: Date(),
                                isDirectory: true, assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = Washer.wash([overruled, archive], home: home.url,
                                 trasher: FolderTrasher(bin: FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-\(UUID())")))
        XCTAssertEqual(report.washed.map(\.name), ["Wash.app"])
        XCTAssertEqual(report.failures.map(\.message), ["Its other copy is gone or going too"])
    }

    func testAChainOfCopiesIsFineWhileTheLastOneStays() throws {
        // Wash-macOS.zip unpacked as Wash.app, which is an older build of Wash 2.app.
        let zip = washZip()
        try home.write("Downloads/Wash-macOS.zip", zip.data())
        try unpack(zip, as: "Wash.app", in: "Downloads")
        try home.write("Downloads/Wash.app/Contents/Info.plist",
                       try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "quest.wash",
                                                                             "CFBundleShortVersionString": "0.1"],
                                                          format: .xml, options: 0), daysOld: 3)
        home.ageTree("Downloads/Wash.app", days: 3)
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.2")
        let found = home.scan().findings
        XCTAssertEqual(Set(found.map(\.name)), ["Wash.app"], "the zip no longer matches, the old build does")
        // Put the zip back in step with the edited app and look again.
        let edited = ZipBuilder(items: zip.items.map { item in
            if case .file("Wash.app/Contents/Info.plist", _) = item,
               let data = FileManager.default.contents(atPath: home.url.appendingPathComponent("Downloads/Wash.app/Contents/Info.plist").path) {
                return .file("Wash.app/Contents/Info.plist", data)
            }
            return item
        })
        try home.write("Downloads/Wash-macOS.zip", edited.data())
        let both = home.scan().findings
        XCTAssertEqual(Set(both.map(\.name)), ["Wash.app", "Wash-macOS.zip"])
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-\(UUID())")
        defer { try? FileManager.default.removeItem(at: bin) }
        let report = Washer.wash(both, home: home.url, trasher: FolderTrasher(bin: bin))
        XCTAssertTrue(report.failures.isEmpty, "\(report.failures.map(\.message))")
        XCTAssertTrue(FileManager.default.fileExists(atPath: home.url.appendingPathComponent("Downloads/Wash 2.app").path))
    }
}

final class SweepTests: XCTestCase {
    var home: FakeHome!

    override func setUpWithError() throws { home = try FakeHome() }
    override func tearDown() { home = nil }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    /// Makes a folder (and any folders above it, below the top folder) dated `daysOld` days ago.
    private func folder(_ relative: String, daysOld: Int) throws {
        try FileManager.default.createDirectory(at: home.url.appendingPathComponent(relative), withIntermediateDirectories: true)
        let parts = relative.split(separator: "/")
        for depth in stride(from: parts.count, through: 2, by: -1) {
            home.age(home.url.appendingPathComponent(parts.prefix(depth).joined(separator: "/")), days: daysOld)
        }
    }

    func testArchivesAnywhereInDocumentsAreChecked() throws {
        let zip = ZipBuilder(items: [.file("Scans/page1.pdf", .noise(4000)), .file("Scans/page2.pdf", .noise(4000, seed: 2))])
        try home.write("Documents/Taxes/2025/Scans.zip", zip.data(), daysOld: 3)
        try home.write("Documents/Taxes/2025/Scans/page1.pdf", .noise(4000), daysOld: 3)
        try home.write("Documents/Taxes/2025/Scans/page2.pdf", .noise(4000, seed: 2), daysOld: 3)
        home.ageTree("Documents/Taxes", days: 3)
        XCTAssertEqual(find(home.scan(), "Scans.zip")?.keeps?.lastPathComponent, "Scans")
    }

    func testNothingInsideAGitProjectIsTouched() throws {
        let zip = ZipBuilder(items: [.file("fixture/data.json", .noise(500))])
        try home.write("Documents/Code/app/.git/HEAD", Data("x".utf8), daysOld: 30)
        try home.write("Documents/Code/app/tests/fixture.zip", zip.data(), daysOld: 30)
        try home.write("Documents/Code/app/tests/fixture/data.json", .noise(500), daysOld: 30)
        try home.write("Documents/Code/app/empty.txt", Data(), daysOld: 30)
        try folder("Documents/Code/app/logs", daysOld: 30)
        home.ageTree("Documents/Code", days: 30)
        XCTAssertTrue(home.scan().findings.isEmpty, "\(home.scan().findings.map(\.name))")
    }

    func testEmptyFoldersGoOnlyTheTopMostOneIsListed() throws {
        try folder("Documents/Old Plans/Drafts/Final", daysOld: 30)
        try home.write("Documents/Old Plans/.DS_Store", .noise(10), daysOld: 30)
        home.ageTree("Documents/Old Plans", days: 30)
        try folder("Downloads/Just Made", daysOld: 1)
        try folder("Documents/Zoom", daysOld: 30)               // Zoom made this and expects it
        try home.app("Applications/zoom.us.app", id: "us.zoom", version: "6")
        try home.app("Applications/Zoom.app", id: "us.zoom.xos", version: "6")
        try folder("Documents/Shots", daysOld: 30)              // where screenshots are saved
        try folder("Documents/Kept/inner", daysOld: 30)
        try home.write("Documents/Kept/note.txt", .noise(20), daysOld: 30)
        let result = home.scan(screenshotFolder: home.url.appendingPathComponent("Documents/Shots"))
        let empties = result.findings.filter { $0.category == .empty }
        XCTAssertEqual(Set(empties.map(\.name)), ["Old Plans", "inner"])
        XCTAssertEqual(find(result, "Old Plans")?.verdict, .wash)
        XCTAssertNil(find(result, "Documents"), "the top folders themselves never go")
    }

    func testAFolderThatFillsUpAfterTheScanStays() throws {
        try folder("Documents/Old Plans/Drafts", daysOld: 30)
        let found = home.scan().findings.filter { $0.category == .empty }
        XCTAssertEqual(found.map(\.name), ["Old Plans"])
        try home.write("Documents/Old Plans/Drafts/new idea.txt", .noise(50), daysOld: 30)
        home.age(home.url.appendingPathComponent("Documents/Old Plans/Drafts"), days: 30)
        let report = Washer.wash(found, home: home.url, trasher: FolderTrasher(bin: home.url.appendingPathComponent("bin")))
        XCTAssertEqual(report.failures.map(\.message), ["No longer empty"])
    }

    func testDeadFiles() throws {
        let docs = home.url.appendingPathComponent("Documents")
        try home.write("Documents/real.txt", .noise(30), daysOld: 30)
        try FileManager.default.createSymbolicLink(atPath: docs.appendingPathComponent("gone link").path, withDestinationPath: "missing.txt")
        try FileManager.default.createSymbolicLink(atPath: docs.appendingPathComponent("good link").path, withDestinationPath: "real.txt")
        try FileManager.default.createSymbolicLink(atPath: docs.appendingPathComponent("on backup disk").path,
                                                   withDestinationPath: "/Volumes/Backup/photos")
        try home.write("Documents/._Report.pdf", .noise(4096), daysOld: 30)           // Report.pdf is gone
        try home.write("Documents/._real.txt", .noise(4096), daysOld: 30)             // real.txt is there
        try home.write("Documents/~$Budget.xlsx", .noise(162), daysOld: 2)
        try home.write("Downloads/blank.txt", Data(), daysOld: 30)
        try home.write("Downloads/just now.txt", Data(), daysOld: 1)
        try home.write("Documents/Icon\r", Data(), daysOld: 30)
        home.ageTree("Documents", days: 30)
        for link in ["gone link", "good link", "on backup disk"] {
            var times = [timeval(tv_sec: Int(home.now.timeIntervalSince1970) - 30 * 86_400, tv_usec: 0),
                         timeval(tv_sec: Int(home.now.timeIntervalSince1970) - 30 * 86_400, tv_usec: 0)]
            _ = lutimes(docs.appendingPathComponent(link).path, &times)
        }
        let dead = Dictionary(uniqueKeysWithValues: home.scan().findings.filter { $0.category == .dead }.map { ($0.name, $0.reason) })
        XCTAssertEqual(Set(dead.keys), ["gone link", "._Report.pdf", "~$Budget.xlsx", "blank.txt"])
        XCTAssertEqual(dead["gone link"], "Link · points to something that no longer exists")
        XCTAssertEqual(dead["blank.txt"], "Untouched since 30 days ago · an empty file: 0 bytes")
    }

    func testOfficeLockFilesStayWhileOfficeIsOpen() throws {
        try home.write("Documents/~$Budget.xlsx", .noise(162), daysOld: 2)
        home.inUse = ["/Applications/Microsoft Excel.app"]
        XCTAssertNil(find(home.scan(), "~$Budget.xlsx"))
    }

    func testALooseDownloadAlreadyFiledInDocumentsCanGo() throws {
        try home.write("Documents/Taxes/2025/invoice.pdf", .noise(9000, seed: 3), daysOld: 20)
        try home.write("Downloads/invoice.pdf", .noise(9000, seed: 3), daysOld: 2)
        home.ageTree("Documents/Taxes", days: 20)
        let copy = try XCTUnwrap(find(home.scan(), "invoice.pdf"))
        XCTAssertEqual(copy.url.deletingLastPathComponent().lastPathComponent, "Downloads")
        XCTAssertEqual(copy.reason, "Copy from 2 days ago · an exact copy of “invoice.pdf” in Documents/Taxes/2025")
    }

    func testCopiesInsideOrganisedFoldersAreLeftAlone() throws {
        // The same logo in two project folders: each folder needs its own.
        try home.write("Documents/Client A/logo.png", .noise(5000, seed: 4), daysOld: 20)
        try home.write("Documents/Client B/logo.png", .noise(5000, seed: 4), daysOld: 10)
        // A file inside a folder unpacked in Downloads belongs to that folder.
        try home.write("Downloads/Kit/logo.png", .noise(5000, seed: 4), daysOld: 5)
        // But a "copy" right beside its twin is clutter.
        try home.write("Documents/Client A/brief.pdf", .noise(3000, seed: 5), daysOld: 20)
        try home.write("Documents/Client A/brief copy.pdf", .noise(3000, seed: 5), daysOld: 10)
        for f in ["Documents/Client A", "Documents/Client B", "Downloads/Kit"] { home.ageTree(f, days: 5) }
        let redundant = home.scan().findings.filter { $0.category == .redundant }
        XCTAssertEqual(redundant.map(\.name), ["brief copy.pdf"])
        XCTAssertEqual(redundant.first?.reason, "Copy from 5 days ago · an exact copy of “brief.pdf”")
    }

    func testOnlyRealInstallersCount() throws {
        try home.app("Applications/Notes Pro.app", id: "notes.pro", version: "1")
        try home.write("Downloads/Install Notes Pro.pkg", .noise(800), daysOld: 2)
        try home.write("Downloads/Install Notes Pro Guide.pdf", .noise(800, seed: 2), daysOld: 2)
        try home.write("Documents/Setup Notes Pro.pdf", .noise(800, seed: 3), daysOld: 2)
        let result = home.scan()
        XCTAssertEqual(find(result, "Install Notes Pro.pkg")?.category, .redundant)
        XCTAssertNotEqual(find(result, "Install Notes Pro Guide.pdf")?.category, .redundant)
        XCTAssertNil(find(result, "Setup Notes Pro.pdf"))
    }

    func testOldBuildsDeepInDownloadsAreFound() throws {
        try home.app("Downloads/Atrium Pose for Mac/Atrium Pose.app", id: "earth.atrium.pose", version: "3.4.1", daysOld: 3)
        try home.app("Downloads/Atrium Pose Preview 8.app", id: "earth.atrium.pose", version: "3.4.3", daysOld: 1)
        home.ageTree("Downloads/Atrium Pose for Mac", days: 3)
        XCTAssertEqual(find(home.scan(), "Atrium Pose.app")?.keeps?.lastPathComponent, "Atrium Pose Preview 8.app")
    }

    func testAProjectOnTheDesktopIsNotFiledAway() throws {
        try home.write("Desktop/sketch/.git/HEAD", Data("x".utf8), daysOld: 90)
        try home.write("Desktop/sketch/index.html", .noise(300), daysOld: 90)
        try home.write("Desktop/notes.pages", .noise(300, seed: 2), daysOld: 90)
        home.ageTree("Desktop/sketch", days: 90)
        let result = home.scan()
        XCTAssertNil(find(result, "sketch"))
        XCTAssertEqual(find(result, "notes.pages")?.verdict, .file)
    }
}

/// The findings of the third review: each one a way Rinse could have lost something, now refused.
final class LastCheckTests: XCTestCase {
    var home: FakeHome!
    var bin: URL!

    override func setUpWithError() throws {
        home = try FakeHome()
        bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-\(UUID())")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: bin)
        home = nil
    }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    private func wash(_ findings: [Finding], inUse: Set<String> = [], runningIDs: Set<String> = []) -> WashReport {
        Washer.wash(findings, home: home.url, inUse: inUse, runningIDs: runningIDs, trasher: FolderTrasher(bin: bin))
    }

    private func daybreak() throws -> Finding {
        let zip = ZipBuilder(items: [.file("Daybreak/a.psd", .noise(3000)), .file("Daybreak/b.psd", .noise(3000, seed: 2))])
        try home.write("Downloads/Daybreak.zip", zip.data())
        try home.write("Downloads/Daybreak/a.psd", .noise(3000))
        try home.write("Downloads/Daybreak/b.psd", .noise(3000, seed: 2))
        home.ageTree("Downloads/Daybreak", days: 1)
        return try XCTUnwrap(find(home.scan(), "Daybreak.zip"))
    }

    func testAnArchiveStaysIfItsUnpackedCopyWasEditedAfterTheScan() throws {
        let zip = try daybreak()
        try home.write("Downloads/Daybreak/a.psd", .noise(3000, seed: 9), daysOld: 1)   // edited, same length
        XCTAssertEqual(wash([zip]).failures.map(\.message), ["Its unpacked copy has changed"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: zip.url.path))
    }

    func testAnArchiveStaysIfPartOfItsUnpackedCopyWasDeleted() throws {
        let zip = try daybreak()
        try FileManager.default.removeItem(at: home.url.appendingPathComponent("Downloads/Daybreak/b.psd"))
        XCTAssertEqual(wash([zip]).failures.map(\.message), ["Its unpacked copy has changed"])
    }

    func testAnUnchangedArchiveStillGoes() throws {
        let zip = try daybreak()
        XCTAssertEqual(wash([zip]).washed.map(\.name), ["Daybreak.zip"])
    }

    func testADuplicateFolderWorkedInAfterTheScanStays() throws {
        try home.write("Downloads/Site/src/a.txt", .noise(500))
        try home.write("Downloads/Site copy/src/a.txt", .noise(500))
        home.ageTree("Downloads/Site", days: 1)
        home.ageTree("Downloads/Site copy", days: 1)
        let copy = try XCTUnwrap(find(home.scan(), "Site copy"))
        try home.write("Downloads/Site copy/src/a.txt", .noise(500, seed: 3), daysOld: 0)   // saved just now, deep inside
        XCTAssertEqual(wash([copy]).failures.map(\.message), ["Changed since Rinse looked"])
    }

    func testADuplicateStaysIfTheKeptCopyChanged() throws {
        try home.write("Downloads/notes.pdf", .noise(800, seed: 4), daysOld: 2)
        try home.write("Downloads/notes (1).pdf", .noise(800, seed: 4), daysOld: 1)
        let copy = try XCTUnwrap(find(home.scan(), "notes (1).pdf"))
        try home.write("Downloads/notes.pdf", .noise(800, seed: 5), daysOld: 2)
        XCTAssertEqual(wash([copy]).failures.map(\.message), ["The two copies are no longer the same"])
    }

    func testACopyWithSomethingInsideItGoingIsNoCopy() throws {
        // A backup zip of a project, and a build folder inside that same project, in one rinse.
        let zip = try daybreak()
        let inside = Finding(url: home.url.appendingPathComponent("Downloads/Daybreak/b.psd"), name: "b.psd",
                             category: .staleDownloads, bytes: 1, lastTouched: Date(), isDirectory: false,
                             assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = wash([zip, inside])
        XCTAssertEqual(report.washed.map(\.name), ["b.psd"])
        XCTAssertEqual(report.failures.map(\.message), ["Its other copy is gone or going too"])
    }

    func testAnAppThatIsOpenNowStays() throws {
        let old = try home.app("Downloads/Wash.app", id: "quest.wash", version: "0.1")
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.2")
        let finding = try XCTUnwrap(find(home.scan(), "Wash.app"))
        XCTAssertEqual(wash([finding], inUse: [old.path]).failures.map(\.message), ["It is open or kept in the Dock"])
        XCTAssertEqual(wash([finding], runningIDs: ["quest.wash"]).failures.map(\.message), ["It is open"])
    }

    func testAnAppOpenedFromAHiddenCopyIsSeenAsOpen() throws {
        try home.app("Downloads/Wash.app", id: "quest.wash", version: "0.1")
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.2")
        let scanner = Scanner(locations: Locations(home: home.url, applications: []), now: home.now,
                              hasOrigin: { _ in false }, runningIDs: ["quest.wash"])
        XCTAssertNil(scanner.scan().findings.first { $0.name == "Wash.app" })
    }

    func testDifferentAppsThatShareAnIdentifierAreNotBuildsOfEachOther() throws {
        func write(_ path: String, id: String, name: String, version: String) throws {
            let info: [String: Any] = ["CFBundleIdentifier": id, "CFBundleName": name, "CFBundleExecutable": name,
                                       "CFBundleShortVersionString": version]
            try home.write(path + "/Contents/Info.plist", try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0))
            try home.write(path + "/Contents/MacOS/" + name, .noise(500, seed: UInt8(version.count)))
            home.ageTree(path, days: 1)
        }
        try write("Desktop/Tally.app", id: "com.vibe.app", name: "Tally", version: "1.0")
        try write("Downloads/Pond.app", id: "com.vibe.app", name: "Pond", version: "2.0")
        try write("Downloads/Old Thing.app", id: "com.example.app", name: "Thing", version: "1.0")
        try write("Downloads/New Thing.app", id: "com.example.app", name: "Thing", version: "2.0")
        let redundant = home.scan().findings.filter { $0.category == .redundant }
        XCTAssertTrue(redundant.isEmpty, "\(redundant.map(\.name))")
    }

    func testTheReleaseIsNewerThanItsBeta() throws {
        try home.app("Downloads/Foo.app", id: "dev.foo", version: "2.0", build: "200", daysOld: 2)
        try home.app("Downloads/Foo Beta.app", id: "dev.foo", version: "2.0 beta 3", build: "199", daysOld: 1)
        let result = home.scan()
        XCTAssertNil(find(result, "Foo.app"))
        XCTAssertEqual(find(result, "Foo Beta.app")?.keeps?.lastPathComponent, "Foo.app")
        XCTAssertEqual(Scanner.splitVersion("1.4.0-rc.1").core, [1, 4, 0])
        XCTAssertTrue(Scanner.splitVersion("1.4.0-rc.1").prerelease)
        XCTAssertFalse(Scanner.splitVersion("1.4.0").prerelease)
    }

    func testTheBuildYouActuallyOpenIsKept() throws {
        try home.app("Desktop/Wash.app", id: "quest.wash", version: "0.2")
        try home.app("Downloads/Wash 2.app", id: "quest.wash", version: "0.3")
        home.opened = ["Wash.app"]     // opened through Spotlight; the newer one never was
        XCTAssertNil(find(home.scan(), "Wash.app"))
    }

    func testThingsNamedSetupThatAreNotInstallersStay() throws {
        try home.app("Applications/Blender.app", id: "org.blender", version: "4")
        try home.app("Applications/Obsidian.app", id: "md.obsidian", version: "1")
        try home.write("Desktop/Blender Setup.blend", .noise(900), daysOld: 2)
        try home.write("Desktop/Obsidian Setup/My Vault/note.md", .noise(90), daysOld: 2)
        home.ageTree("Desktop/Obsidian Setup", days: 2)
        try home.write("Desktop/Install Blender.command", .noise(90, seed: 2), daysOld: 2)   // the owner's own script
        try home.write("Documents/Install Obsidian.dmg", .noise(900, seed: 3), daysOld: 2)  // kept in Documents on purpose
        XCTAssertTrue(home.scan().findings.filter { $0.category == .redundant }.isEmpty)
    }

    func testASafariDownloadStillGrowingStays() throws {
        try home.write("Downloads/Xcode.xip.download/Xcode.xip", .noise(5000), daysOld: 0)
        home.age(home.url.appendingPathComponent("Downloads/Xcode.xip.download"), days: 3)
        XCTAssertNil(find(home.scan(), "Xcode.xip.download"))
    }
}

/// The findings of the fourth review, on the whole-folder sweep.
final class SweepSafetyTests: XCTestCase {
    var home: FakeHome!
    var bin: URL!

    override func setUpWithError() throws {
        home = try FakeHome()
        bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-\(UUID())")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: bin)
        home = nil
    }

    private func find(_ result: ScanResult, _ name: String) -> Finding? {
        result.findings.first { $0.url.lastPathComponent == name }
    }

    private func folder(_ relative: String, daysOld: Int) throws {
        try FileManager.default.createDirectory(at: home.url.appendingPathComponent(relative), withIntermediateDirectories: true)
        let parts = relative.split(separator: "/")
        for depth in stride(from: parts.count, through: 2, by: -1) {
            home.age(home.url.appendingPathComponent(parts.prefix(depth).joined(separator: "/")), days: daysOld)
        }
    }

    func testAnEmptyNestHoldingTheScreenshotFolderStays() throws {
        try folder("Documents/Captures/Screenshots", daysOld: 30)
        try folder("Documents/Old/Empty", daysOld: 30)
        let shots = home.url.appendingPathComponent("Documents/Captures/Screenshots")
        let empties = home.scan(screenshotFolder: shots).findings.filter { $0.category == .empty }
        XCTAssertEqual(empties.map(\.name), ["Old"])
        // And at the moment of moving, whatever the list says.
        let forced = Finding(url: home.url.appendingPathComponent("Documents/Captures"), name: "Captures", category: .empty,
                             bytes: 0, lastTouched: home.now, isDirectory: true,
                             assessment: Assessment(verdict: .wash, confidence: 90, reasons: []))
        let report = Washer.wash([forced], home: home.url, protected: [shots], trasher: FolderTrasher(bin: bin))
        XCTAssertEqual(report.failures.map(\.message), ["It holds your screenshot folder"])
    }

    func testEmptyFilesInsideFoldersAreLeftAlone() throws {
        try home.write("Documents/Code/tool/src/tool/__init__.py", Data(), daysOld: 30)
        try home.write("Documents/Code/tool/src/tool/py.typed", Data(), daysOld: 30)
        try home.write("Desktop/Call Dana re lease.txt", Data(), daysOld: 30)      // a note whose name is the note…
        try home.write("Desktop/Notes/idea.md", Data(), daysOld: 30)
        try home.write("Downloads/blank.txt", Data(), daysOld: 30)                 // …but loose in Downloads, clutter
        try home.write("Downloads/__init__.py", Data(), daysOld: 30)
        home.ageTree("Documents/Code", days: 30)
        home.ageTree("Desktop/Notes", days: 30)
        let dead = Set(home.scan().findings.filter { $0.category == .dead }.map(\.name))
        XCTAssertEqual(dead, ["blank.txt", "Call Dana re lease.txt"])
    }

    func testAProjectWithoutGitIsNotCleanedInsideOrFiled() throws {
        try home.write("Desktop/taxes-script/main.py", .noise(300), daysOld: 40)
        try home.write("Desktop/taxes-script/requirements.txt", Data("requests".utf8), daysOld: 40)
        try home.write("Desktop/taxes-script/env/pyvenv.cfg", Data("home = /usr/bin".utf8), daysOld: 40)
        try home.write("Desktop/taxes-script/out/old.txt", Data(), daysOld: 40)
        home.ageTree("Desktop/taxes-script", days: 40)
        XCTAssertTrue(home.scan().findings.isEmpty, "\(home.scan().findings.map(\.name))")
    }

    func testAVersionedDocumentsFolderIsLeftWhole() throws {
        try home.write("Documents/.git/HEAD", Data("x".utf8), daysOld: 30)
        try folder("Documents/notes/empty", daysOld: 30)
        try home.write("Documents/notes/pkg/__init__.py", Data(), daysOld: 30)
        XCTAssertTrue(home.scan().findings.filter { [.empty, .dead, .redundant].contains($0.category) }.isEmpty)
    }

    func testNumberedSetsAreNotCopiesOfEachOther() throws {
        try home.write("Documents/MyGame/sprites/walk 1.png", .noise(900, seed: 6), daysOld: 20)
        try home.write("Documents/MyGame/sprites/walk 2.png", .noise(900, seed: 6), daysOld: 20)
        try home.write("Documents/Reports/Week 30.xlsx", .noise(700, seed: 7), daysOld: 20)
        try home.write("Documents/Reports/Week 31.xlsx", .noise(700, seed: 7), daysOld: 20)
        try home.write("Documents/Reports/Summary.pdf", .noise(500, seed: 8), daysOld: 20)
        try home.write("Documents/Reports/Summary 2.pdf", .noise(500, seed: 8), daysOld: 20)   // a real second copy
        home.ageTree("Documents/MyGame", days: 20)
        home.ageTree("Documents/Reports", days: 20)
        let redundant = home.scan().findings.filter { $0.category == .redundant }.map(\.name)
        XCTAssertEqual(redundant, ["Summary 2.pdf"])
        XCTAssertTrue(Scanner.isCopy("Report copy 2.pdf", of: "Report.pdf"))
        XCTAssertTrue(Scanner.isCopy("Report (1).pdf", of: "Report.pdf"))
        XCTAssertFalse(Scanner.isCopy("Report copy.docx", of: "Report.pdf"))
        XCTAssertFalse(Scanner.isCopy("walk 2.png", of: "walk 1.png"))
    }

    func testAFolderHoldingAnAppInTheDockIsNotFiled() throws {
        let app = try home.app("Desktop/Tools/HandBrake.app", id: "fr.handbrake", version: "1", daysOld: 40)
        try home.write("Desktop/Tools/readme.pdf", .noise(200), daysOld: 40)
        home.ageTree("Desktop/Tools", days: 40)
        XCTAssertNil(find(home.scan(), "Tools"), "a folder holding an app is where the app lives")
        let forced = Finding(url: home.url.appendingPathComponent("Desktop/Tools"), name: "Tools", category: .staleDownloads,
                             bytes: 1, lastTouched: home.now, isDirectory: true,
                             assessment: Assessment(verdict: .file, confidence: 80, reasons: []))
        let report = Filer.file([forced], home: home.url, archive: home.url.appendingPathComponent("Documents/Filed Away"),
                                inUse: [app.path])
        XCTAssertEqual(report.failures.map(\.message), ["It is open or kept in the Dock"])
    }

    func testALinkRinseCannotReadIsNotBroken() throws {
        XCTAssertEqual(FileStat.reachability("/definitely/not/here"), .missing)
        XCTAssertEqual(FileStat.reachability(home.url.path), .exists)
        // A path through a file (ENOTDIR) is missing too.
        let file = try home.write("Documents/plain.txt", .noise(10))
        XCTAssertEqual(FileStat.reachability(file.path + "/inside"), .missing)
    }

    func testAnUnchangedUnpackedCopyIsNotReadAgain() throws {
        let zip = ZipBuilder(items: [.file("Kit/a.bin", .noise(4000)), .file("Kit/b.bin", .noise(4000, seed: 2))])
        try home.write("Downloads/Kit.zip", zip.data())
        try home.write("Downloads/Kit/a.bin", .noise(4000))
        try home.write("Downloads/Kit/b.bin", .noise(4000, seed: 2))
        home.ageTree("Downloads/Kit", days: 1)
        XCTAssertNotNil(find(home.scan(), "Kit.zip"))
        let before = ZipIndex.checksumsRead
        XCTAssertNotNil(find(home.scan(), "Kit.zip"))
        XCTAssertEqual(ZipIndex.checksumsRead, before, "the second look used the cache")
    }

    func testFoldersKeptInSyncAreNotCleanedInside() throws {
        try home.write("Documents/Dropbox/.dropbox", Data("x".utf8), daysOld: 30)
        try folder("Documents/Dropbox/Shared/Empty", daysOld: 30)
        home.ageTree("Documents/Dropbox", days: 30)
        XCTAssertTrue(home.scan().findings.filter { $0.category == .empty }.isEmpty)
    }
}

final class ProjectTests: XCTestCase {
    var home: FakeHome!
    var rules = Rules()

    override func setUpWithError() throws {
        home = try FakeHome()
        rules.cacheListBytes = 10_000
    }

    override func tearDown() { home = nil }

    private func project(_ path: String, daysOld: Int, ignore: String = "node_modules/\n") throws {
        try home.write(path + "/.git/HEAD", Data("ref: refs/heads/main\n".utf8), daysOld: daysOld)
        try home.write(path + "/package.json", Data("{}".utf8), daysOld: daysOld)
        try home.write(path + "/package-lock.json", Data("{}".utf8), daysOld: daysOld)
        try home.write(path + "/src/index.js", .noise(400), daysOld: daysOld)
        try home.write(path + "/.gitignore", Data(ignore.utf8), daysOld: daysOld)
        try home.write(path + "/node_modules/react/index.js", .noise(30_000), daysOld: daysOld)
        home.ageTree(path, days: daysOld)
    }

    func testDependenciesOfAnIdleProjectCanGo() throws {
        try project("Documents/ChatGPT/Atrium", daysOld: 40)
        let finding = try XCTUnwrap(home.scan(rules).findings.first { $0.url.lastPathComponent == "node_modules" })
        XCTAssertEqual(finding.category, .projectBuilds)
        XCTAssertEqual(finding.name, "node_modules in Atrium")
        XCTAssertEqual(finding.verdict, .wash)
        XCTAssertEqual(finding.reason, "Project last worked on 40 days ago · comes back with npm install")
    }

    func testAProjectInUseKeepsItsDependencies() throws {
        try project("Developer/Live", daysOld: 40)
        try home.write("Developer/Live/src/today.js", .noise(100), daysOld: 0)
        let finding = try XCTUnwrap(home.scan(rules).findings.first { $0.url.lastPathComponent == "node_modules" })
        XCTAssertEqual(finding.verdict, .leave)
        XCTAssertTrue(finding.reason.contains("the project is still in use"))
    }

    func testAFolderTheProjectDoesNotIgnoreIsNotListed() throws {
        try project("Documents/Vendored", daysOld: 40, ignore: "dist\n")
        XCTAssertTrue(home.scan(rules).findings.filter { $0.category == .projectBuilds }.isEmpty)
    }

    func testOnlyRecognisedAndRecreatableFoldersAreListed() throws {
        try home.write("Documents/Py/.git/HEAD", Data("x".utf8), daysOld: 40)
        try home.write("Documents/Py/requirements.txt", Data("x".utf8), daysOld: 40)
        try home.write("Documents/Py/.gitignore", Data(".venv\n/venv\nbuild/\n".utf8), daysOld: 40)
        try home.write("Documents/Py/.venv/pyvenv.cfg", Data("x".utf8), daysOld: 40)
        try home.write("Documents/Py/.venv/lib/big.so", .noise(30_000), daysOld: 40)
        try home.write("Documents/Py/venv/lib/notreally.so", .noise(30_000), daysOld: 40)   // no pyvenv.cfg
        try home.write("Documents/Py/build/output.bin", .noise(30_000), daysOld: 40)       // no manifest for it
        try home.write("Documents/Swift/.git/HEAD", Data("x".utf8), daysOld: 40)
        try home.write("Documents/Swift/Package.swift", Data("x".utf8), daysOld: 40)
        try home.write("Documents/Swift/.gitignore", Data("/.build\n".utf8), daysOld: 40)
        try home.write("Documents/Swift/.build/debug/x.o", .noise(30_000), daysOld: 40)
        let names = Set(home.scan(rules).findings.filter { $0.category == .projectBuilds }.map(\.name))
        XCTAssertEqual(names, [".venv in Py", ".build in Swift"])
    }

    func testABuildThatIsRunOrRebuiltIsInUse() throws {
        try home.write("Developer/tool/.git/HEAD", Data("x".utf8), daysOld: 40)
        try home.write("Developer/tool/Cargo.toml", Data("x".utf8), daysOld: 40)
        try home.write("Developer/tool/.gitignore", Data("/target\n".utf8), daysOld: 40)
        try home.write("Developer/tool/src/main.rs", .noise(300), daysOld: 40)
        try home.write("Developer/tool/target/release/tool", .noise(30_000), daysOld: 0)   // rebuilt today
        let finding = try XCTUnwrap(home.scan(rules).findings.first { $0.name == "target in tool" })
        XCTAssertEqual(finding.verdict, .leave)
    }

    func testDependenciesWithoutALockfileAreNotListed() throws {
        try project("Documents/Loose", daysOld: 40)
        try FileManager.default.removeItem(at: home.url.appendingPathComponent("Documents/Loose/package-lock.json"))
        XCTAssertTrue(home.scan(rules).findings.filter { $0.category == .projectBuilds }.isEmpty)
    }

    func testASubmoduleOrAReIncludedFolderIsLeftAlone() throws {
        try project("Developer/App", daysOld: 40, ignore: "node_modules/\ndist\n!packages/web/dist\n")
        // A submodule with its own committed dist.
        try home.write("Developer/App/vendor/lib/.git", Data("gitdir: ../../.git/modules/lib".utf8), daysOld: 40)
        try home.write("Developer/App/vendor/lib/package.json", Data("{}".utf8), daysOld: 40)
        try home.write("Developer/App/vendor/lib/dist/lib.js", .noise(30_000), daysOld: 40)
        // A package whose dist the root .gitignore brings back.
        try home.write("Developer/App/packages/web/package.json", Data("{}".utf8), daysOld: 40)
        try home.write("Developer/App/packages/web/dist/app.js", .noise(30_000), daysOld: 40)
        let names = Set(home.scan(rules).findings.filter { $0.category == .projectBuilds }.map(\.name))
        XCTAssertEqual(names, ["node_modules in App"])
    }

    func testIgnorePatterns() throws {
        let file = home.url.appendingPathComponent("ignore")
        try Data("# deps\n**/node_modules\n/target/\n!keep\nbuild/**\n".utf8).write(to: file)
        XCTAssertTrue(Scanner.ignoreFile(file, names: "node_modules", anchoredHere: false))
        XCTAssertTrue(Scanner.ignoreFile(file, names: "target", anchoredHere: true))
        XCTAssertFalse(Scanner.ignoreFile(file, names: "target", anchoredHere: false), "anchored to the root")
        XCTAssertTrue(Scanner.ignoreFile(file, names: "build", anchoredHere: false))
        XCTAssertFalse(Scanner.ignoreFile(file, names: "keep", anchoredHere: true))
        XCTAssertFalse(Scanner.ignoreFile(file, names: "deps", anchoredHere: true))
    }
}

final class RulesMigrationTests: XCTestCase {
    func testSettingsFromAnEarlierVersionKeepTheOwnersChoices() throws {
        let old = Data(#"{"screenshotDays":12,"ignored":["/Users/x/a.png"],"disabled":["installers","somethingRemoved"]}"#.utf8)
        let rules = try JSONDecoder().decode(Rules.self, from: old)
        XCTAssertEqual(rules.screenshotDays, 12)
        XCTAssertEqual(rules.ignored, ["/Users/x/a.png"])
        XCTAssertEqual(rules.disabled, [.installers])
        XCTAssertEqual(rules.projectIdleDays, Rules().projectIdleDays)
        XCTAssertEqual(try JSONDecoder().decode(Rules.self, from: JSONEncoder().encode(rules)), rules)
    }
}

final class WasherTests: XCTestCase {
    func testWashMovesFilesAndReportsWhatItCouldNot() throws {
        let home = try FakeHome()
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: bin) }
        let shot = try home.file("Desktop/Screenshot a.png", daysOld: 30)
        try home.file("Downloads/app.dmg", daysOld: 30)
        home.downloaded = ["app.dmg"]
        let scan = home.scan()
        XCTAssertEqual(scan.findings.count, 2)

        try FileManager.default.removeItem(at: home.url.appendingPathComponent("Downloads/app.dmg"))
        let report = Washer.wash(scan.findings, home: home.url, trasher: FolderTrasher(bin: bin))

        XCTAssertEqual(report.washed.map(\.url), [shot])
        XCTAssertEqual(report.failures.map(\.message), ["Already gone"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: shot.path))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: bin.path).count, 1)
        XCTAssertEqual(report.bytes, report.washed[0].bytes)
    }

    func testWashRefusesProtectedLocationsEvenIfHandedThem() throws {
        let home = try FakeHome()
        let desktop = try home.folder("Desktop")
        let finding = Finding(url: desktop, name: "Desktop", category: .bigIdle, bytes: 1, lastTouched: Date(),
                              isDirectory: true, assessment: Assessment(verdict: .wash, confidence: 100, reasons: []))
        let report = Washer.wash([finding], home: home.url, trasher: FolderTrasher(bin: home.url.appendingPathComponent("x")))
        XCTAssertTrue(report.washed.isEmpty)
        XCTAssertEqual(report.failures.count, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: desktop.path))
    }

    func testSafetyGuard() {
        let home = URL(fileURLWithPath: "/Users/someone")
        func ok(_ path: String) -> Bool { SafetyGuard.canWash(URL(fileURLWithPath: path), home: home) }

        XCTAssertTrue(ok("/Users/someone/Desktop/Screenshot.png"))
        XCTAssertTrue(ok("/Users/someone/Library/Caches/com.spotify.client"))
        XCTAssertTrue(ok("/Users/someone/Library/Developer/Xcode/DerivedData/App-abc"))
        XCTAssertTrue(ok("/Users/someone/.npm/_cacache"))

        XCTAssertFalse(ok("/Users/someone"))
        XCTAssertFalse(ok("/Users/someone/Desktop"))
        XCTAssertFalse(ok("/Users/someone/Library"))
        XCTAssertFalse(ok("/Users/someone/Library/Caches"))
        XCTAssertFalse(ok("/Users/someone/Library/Developer/Xcode/DerivedData"))
        XCTAssertFalse(ok("/Users/someone/Library/Application Support/Notes"))
        XCTAssertFalse(ok("/Users/someone/Library/Mail/V10"))
        XCTAssertFalse(ok("/Users/someone/.Trash/thing"))
        XCTAssertFalse(ok("/Users/someone/Desktop/../../other/file"))
        XCTAssertFalse(ok("/Users/someone-else/Desktop/file"))
        XCTAssertFalse(ok("/Applications/Safari.app"))
        XCTAssertFalse(ok("/"))
    }
}

final class LedgerTests: XCTestCase {
    private var calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/New_York")!
        return c
    }()

    private func day(_ d: Int, hour: Int = 21) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 11, day: d, hour: hour))!
    }

    func testStreakCountsConsecutiveDaysAndForgivesAnOpenToday() {
        var ledger = Ledger()
        XCTAssertEqual(ledger.streak(asOf: day(18), calendar: calendar), 0)
        ledger.record(bytes: 10, count: 1, at: day(14))
        ledger.record(bytes: 10, count: 1, at: day(16))
        ledger.record(bytes: 10, count: 2, at: day(17))
        ledger.record(bytes: 10, count: 1, at: day(17, hour: 23))
        XCTAssertEqual(ledger.streak(asOf: day(18, hour: 9), calendar: calendar), 2, "today is still open")
        ledger.record(bytes: 10, count: 1, at: day(18))
        XCTAssertEqual(ledger.streak(asOf: day(18, hour: 22), calendar: calendar), 3)
        XCTAssertEqual(ledger.streak(asOf: day(20), calendar: calendar), 0, "a missed day ends it")
        XCTAssertEqual(ledger.totalBytes, 50)
    }

    func testAnEmptyWashIsNotRecorded() {
        var ledger = Ledger()
        ledger.record(bytes: 0, count: 0, at: Date())
        XCTAssertTrue(ledger.entries.isEmpty)
    }

    func testLedgerSurvivesSavingAndLoading() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-ledger-\(UUID()).json")
        defer { try? FileManager.default.removeItem(at: url) }
        var ledger = Ledger()
        ledger.record(bytes: 1234, count: 3, at: Date(timeIntervalSince1970: 1_800_000_000))
        try ledger.save(to: url)
        XCTAssertEqual(Ledger.load(from: url), ledger)
        XCTAssertEqual(Ledger.load(from: url.appendingPathExtension("missing")), Ledger())
    }

    func testByteFormat() {
        XCTAssertEqual(ByteFormat.string(0), "0 KB")
        XCTAssertEqual(ByteFormat.string(512_000), "512 KB")
        XCTAssertEqual(ByteFormat.string(48_400_000), "48 MB")
        XCTAssertEqual(ByteFormat.string(3_420_000_000), "3.4 GB")
        XCTAssertEqual(ByteFormat.string(2_000_000_000), "2 GB")
        XCTAssertEqual(ByteFormat.string(128_600_000_000), "129 GB")
        XCTAssertEqual(ByteFormat.string(1_500_000_000_000), "1.5 TB")
    }
}
