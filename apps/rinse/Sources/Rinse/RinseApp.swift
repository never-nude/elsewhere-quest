import AppKit
import RinseCore
import SwiftUI

@main
struct RinseApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        @Bindable var model = model
        // Wash is an ordinary Dock app. The menu bar drop is an extra, and can be switched off.
        MenuBarExtra(isInserted: $model.prefs.showMenuBarItem) {
            MenuPanel().environment(model)
        } label: {
            Image(systemName: model.hasResidue ? "drop.fill" : "drop")
            if model.prefs.showAmount, model.hasResidue {
                Text(ByteFormat.string(model.washBytes))
            }
        }
        .menuBarExtraStyle(.window)
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") { model.openReview(settings: true) }
                    .keyboardShortcut(",", modifiers: .command)
            }
            CommandGroup(replacing: .newItem) {
                Button("Show Wash") { model.openReview() }
                    .keyboardShortcut("0", modifiers: .command)
                Button("Look Again") { Task { await model.scan() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // A bare `swift run` binary has no Info.plist to say so, so say it here: Dock icon, menus, windows.
        NSApp.setActivationPolicy(.regular)
        MainMenu.installIfMissing()
        let launchedAtLogin = Platform.wasLaunchedAtLogin()
        // Present after launch handling, before requesting notification permission.
        DispatchQueue.main.async {
            let model = AppModel.shared
            if !launchedAtLogin { model.openReview() }
            model.start()
        }
    }

    /// Clicking the Dock icon brings the window back.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppModel.shared.openReview()
        return false
    }

    /// Closing the window leaves Wash running, so the evening reminder and the Dock badge keep working.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}

extension Color {
    /// The one accent: clean water.
    static let water = Color(red: 0.13, green: 0.60, blue: 0.72)
}

extension ShapeStyle where Self == LinearGradient {
    static var waterGradient: LinearGradient {
        LinearGradient(colors: [Color(red: 0.35, green: 0.80, blue: 0.86), .water],
                       startPoint: .top, endPoint: .bottom)
    }
}
