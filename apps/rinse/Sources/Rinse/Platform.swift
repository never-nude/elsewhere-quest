import AppKit
import RinseCore
import ServiceManagement
import SwiftUI
import UserNotifications

/// The real Trash. Items can be put back from Finder until the Trash is emptied.
struct SystemTrasher: Trasher {
    func trash(_ url: URL) throws {
        try FileManager.default.trashItem(at: url, resultingItemURL: nil)
    }
}

enum Platform {
    /// Where macOS saves screenshots, if the owner moved it off the Desktop.
    static func screenshotFolder() -> URL? {
        let value = CFPreferencesCopyAppValue("location" as CFString, "com.apple.screencapture" as CFString)
        guard let raw = value as? String, !raw.isEmpty else { return nil }
        return URL(fileURLWithPath: (raw as NSString).expandingTildeInPath)
    }

    /// Asks Finder to empty the Trash. This is the only step that cannot be undone.
    /// Returns an error message, or nil when it worked.
    @MainActor
    static func emptyTrash() -> String? {
        var error: NSDictionary?
        NSAppleScript(source: "tell application \"Finder\" to empty trash")?.executeAndReturnError(&error)
        guard let error else { return nil }
        return (error[NSAppleScript.errorMessage] as? String) ?? "Finder could not empty the Trash."
    }
}

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    /// Returns an error message, or nil when it worked.
    static func set(_ on: Bool) -> String? {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

/// The evening reminder.
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Notifier()
    var onOpen: (@MainActor () -> Void)?

    /// Notifications need a real app bundle; a bare `swift run` binary has none.
    private var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    func prepare() {
        guard isAvailable else { return }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func announce(bytes: Int64) {
        guard isAvailable else { return }
        let content = UNMutableNotificationContent()
        content.title = "Time to rinse"
        content.body = "\(ByteFormat.string(bytes)) of residue is ready to wash off."
        content.sound = .default
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(identifier: "rinse.ritual", content: content, trigger: nil))
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let open = onOpen
        DispatchQueue.main.async { MainActor.assumeIsolated { open?() } }
        completionHandler()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}

/// The one real window. It is managed by hand so that a notification or the menu bar can open it.
@MainActor
final class ReviewWindow {
    static let shared = ReviewWindow()
    private var window: NSWindow?

    var isVisible: Bool { window?.isVisible ?? false }

    func show(model: AppModel) {
        if window == nil {
            let hosting = NSHostingController(rootView: ReviewView().environment(model))
            hosting.sizingOptions = []
            let made = NSWindow(contentViewController: hosting)
            made.title = "Rinse"
            made.styleMask = [.titled, .closable, .miniaturizable, .resizable]
            made.isReleasedWhenClosed = false
            made.contentMinSize = NSSize(width: 560, height: 480)
            made.setContentSize(NSSize(width: 720, height: 680))
            made.center()
            made.setFrameAutosaveName("RinseMainWindow")
            window = made
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    func owns(_ other: NSWindow?) -> Bool {
        other != nil && other === window
    }
}

/// SwiftUI normally builds the menu bar. If it has not, this gives the app the essentials.
@MainActor
enum MainMenu {
    static func installIfMissing() {
        guard (NSApp.mainMenu?.items.isEmpty ?? true) else { return }
        let main = NSMenu()

        let app = NSMenu()
        app.addItem(withTitle: "About Rinse", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Rinse", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Rinse", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu(app, title: "Rinse"))

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        main.addItem(submenu(edit, title: "Edit"))

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        main.addItem(submenu(window, title: "Window"))

        NSApp.mainMenu = main
        NSApp.windowsMenu = window
    }

    private static func submenu(_ menu: NSMenu, title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }
}
