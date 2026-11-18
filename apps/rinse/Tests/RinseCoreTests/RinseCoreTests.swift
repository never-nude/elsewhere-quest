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

    func scan(_ rules: Rules = Rules(), screenshotFolder: URL? = nil) -> ScanResult {
        Scanner(locations: Locations(home: url, screenshotFolder: screenshotFolder), rules: rules, now: now).scan()
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
        XCTAssertTrue(old.suggested)
        XCTAssertEqual(old.reason, "Taken 12 days ago")
        let fresh = try XCTUnwrap(find(result, "Screenshot 2026-11-18 at 8.00.00 AM.png"))
        XCTAssertFalse(fresh.suggested)
        XCTAssertNil(find(result, "holiday.png"), "an ordinary picture is not a screenshot")
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
        let result = home.scan()
        XCTAssertEqual(result.findings.filter { $0.url.lastPathComponent == "Xcode_26.dmg" }.count, 1)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.category, .installers)
        XCTAssertEqual(find(result, "Xcode_26.dmg")?.suggested, true)
        XCTAssertEqual(find(result, "tool.pkg")?.suggested, false, "a one-day-old installer may not have been run yet")
    }

    func testStaleDownloadsAreListedButNeverPreChecked() throws {
        try home.file("Downloads/tax-return.pdf", daysOld: 200)
        try home.file("Downloads/Old Project/notes.txt", kilobytes: 50, daysOld: 200)
        home.age(home.url.appendingPathComponent("Downloads/Old Project"), days: 200)
        try home.file("Downloads/fresh.pdf", daysOld: 2)
        let result = home.scan()

        let pdf = try XCTUnwrap(find(result, "tax-return.pdf"))
        XCTAssertEqual(pdf.category, .staleDownloads)
        XCTAssertFalse(pdf.suggested)
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
        XCTAssertEqual(find(result, "com.spotify.client")?.suggested, true)
        XCTAssertEqual(find(result, "com.medium.app")?.suggested, false)
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
        let result = home.scan(rules)

        XCTAssertEqual(find(result, "Old-abc")?.suggested, true)
        XCTAssertEqual(find(result, "Live-def")?.suggested, false)
        let npm = try XCTUnwrap(find(result, "_cacache"))
        XCTAssertEqual(npm.name, "npm cache")
        XCTAssertEqual(npm.category, .developer)
        XCTAssertTrue(npm.suggested)
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
        XCTAssertFalse(render.suggested)
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
        XCTAssertLessThan(result.suggestedBytes, result.totalBytes)
        XCTAssertEqual(result.bytes(in: .screenshots), result.totalBytes)
    }
}

final class WasherTests: XCTestCase {
    func testWashMovesFilesAndReportsWhatItCouldNot() throws {
        let home = try FakeHome()
        let bin = FileManager.default.temporaryDirectory.appendingPathComponent("rinse-bin-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: bin) }
        let shot = try home.file("Desktop/Screenshot a.png", daysOld: 30)
        try home.file("Downloads/app.dmg", daysOld: 30)
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
                              isDirectory: true, suggested: true, reason: "")
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
