import AppKit
import RinseCore
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var openAtLogin = LoginItem.isEnabled
    @State private var loginError: String?

    private static let megabyte: Int64 = 1_000_000

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            Form {
                Section("Evening ritual") {
                    Toggle("Remind me to rinse", isOn: $model.prefs.ritualEnabled)
                    DatePicker("At", selection: ritualTime, displayedComponents: .hourAndMinute)
                        .disabled(!model.prefs.ritualEnabled)
                }
                Section("Where Rinse shows up") {
                    Toggle("Show the amount on the Dock icon and in the menu bar", isOn: $model.prefs.showAmount)
                    Toggle("Show a drop in the menu bar", isOn: $model.prefs.showMenuBarItem)
                    Toggle("Open Rinse at login", isOn: $openAtLogin)
                    if let loginError {
                        Text(loginError).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Filing folder") {
                    LabeledContent(model.archive.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")) {
                        Button("Choose…") { chooseArchive() }
                        if model.prefs.archivePath != nil {
                            Button("Use Default") { model.prefs.archivePath = nil }
                        }
                    }
                    Text("Things worth keeping move here, sorted by kind and month. Choose a folder on another disk and filing frees space too.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Section("Count as dormant") {
                    Stepper("Screenshots older than \(days(model.rules.screenshotDays))",
                            value: $model.rules.screenshotDays, in: 1...90)
                    Stepper("Screen recordings older than \(days(model.rules.recordingDays))",
                            value: $model.rules.recordingDays, in: 1...90)
                    Stepper("Installers older than \(days(model.rules.installerDays))",
                            value: $model.rules.installerDays, in: 1...90)
                    Stepper("Xcode builds unused for \(days(model.rules.buildDays))",
                            value: $model.rules.buildDays, in: 1...90)
                    Picker("Caches larger than", selection: $model.rules.cacheSuggestBytes) {
                        ForEach([50, 100, 250, 500, 1000], id: \.self) { size in
                            Text("\(size) MB").tag(Int64(size) * Self.megabyte)
                        }
                    }
                }
                Section("Also weigh up") {
                    Stepper("Downloads untouched for \(days(model.rules.staleDownloadDays))",
                            value: $model.rules.staleDownloadDays, in: 7...365, step: 7)
                    Stepper("Big files idle for \(days(model.rules.bigFileIdleDays))",
                            value: $model.rules.bigFileIdleDays, in: 10...365, step: 10)
                    Picker("Big means at least", selection: $model.rules.bigFileBytes) {
                        ForEach([100, 250, 500, 1000, 5000], id: \.self) { size in
                            Text(ByteFormat.string(Int64(size) * Self.megabyte)).tag(Int64(size) * Self.megabyte)
                        }
                    }
                }
                Section("Look for") {
                    ForEach(Residue.allCases) { category in
                        Toggle(category.title, isOn: enabled(category))
                    }
                }
                if !model.rules.ignored.isEmpty {
                    Section {
                        LabeledContent("\(model.rules.ignored.count) hidden with Never Show This Again") {
                            Button("Show Them Again") { model.rules.ignored = [] }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
            .padding(12)
        }
        .frame(width: 480, height: 620)
        .onChange(of: openAtLogin) { _, on in
            guard on != LoginItem.isEnabled else { return }
            loginError = LoginItem.set(on)
            if loginError != nil { openAtLogin = LoginItem.isEnabled }
        }
        .onDisappear {
            Task { await model.scan() }
        }
    }

    private func chooseArchive() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "File Here"
        panel.message = "Choose where Rinse files things away."
        if panel.runModal() == .OK, let url = panel.url { model.prefs.archivePath = url.path }
    }

    private func days(_ count: Int) -> String {
        count == 1 ? "1 day" : "\(count) days"
    }

    private var ritualTime: Binding<Date> {
        Binding(
            get: {
                Calendar.current.date(bySettingHour: model.prefs.ritualHour, minute: model.prefs.ritualMinute,
                                      second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                model.prefs.ritualHour = parts.hour ?? 21
                model.prefs.ritualMinute = parts.minute ?? 30
            })
    }

    private func enabled(_ category: Residue) -> Binding<Bool> {
        Binding(
            get: { !model.rules.disabled.contains(category) },
            set: { on in
                if on { model.rules.disabled.remove(category) } else { model.rules.disabled.insert(category) }
            })
    }
}
