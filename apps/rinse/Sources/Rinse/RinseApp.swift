import AppKit
import RinseCore
import SwiftUI

@main
struct RinseApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            MenuPanel().environment(model)
        } label: {
            Image(systemName: model.hasResidue ? "drop.fill" : "drop")
            if model.prefs.showSizeInMenuBar, model.hasResidue {
                Text(ByteFormat.string(model.selectedBytes))
            }
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Rinse lives in the menu bar: no Dock icon, even when run straight from `swift run`.
        NSApp.setActivationPolicy(.accessory)
        AppModel.shared.start()
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
