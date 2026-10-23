import Foundation
import UIKit
import WebKit
import Photos
import PhotosUI
import UniformTypeIdentifiers

@MainActor
final class Bridge: NSObject, WKScriptMessageHandlerWithReply, PHPickerViewControllerDelegate {
    private let registry: TransferRegistry
    private weak var presenter: UIViewController?
    private let webRevision: String
    private var presentationBusy = false
    private var photosBusy = false
    private var subjectBusy = false
    private var decodeBusy = false
    private var pickContinuation: CheckedContinuation<Any, Error>?
    private let selection = UISelectionFeedbackGenerator()
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let notification = UINotificationFeedbackGenerator()

    init(registry: TransferRegistry, presenter: UIViewController, webRevision: String) {
        self.registry = registry; self.presenter = presenter; self.webRevision = webRevision
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, NativeConfig.isLocal(url),
              let envelope = message.body as? [String: Any], let op = envelope["op"] as? String,
              let args = (envelope["args"] ?? [:]) as? [String: Any] else {
            replyHandler(NativeError("badArgs", "Invalid bridge message or origin.").envelope, nil)
            return
        }
        Task {
            do { replyHandler(["ok": true, "result": try await dispatch(op: op, args: args)], nil) }
            catch let error as NativeError { replyHandler(error.envelope, nil) }
            catch { replyHandler(NativeError("failed", "The native operation could not finish.").envelope, nil) }
        }
    }

    // One table is shared by the message entry point and contract tests.
    func dispatch(op: String, args: [String: Any]) async throws -> Any {
        let operations: [String: ([String: Any]) async throws -> Any] = [
            "ping": { [self] _ in
                var metadata = NativeConfig.metadata(webRevision: webRevision)
                metadata.removeValue(forKey: "bridge")
                metadata["os"] = UIDevice.current.systemVersion
                return metadata
            },
            "photo.pick": { [self] _ in try await pick() },
            "image.info": { [self] args in
                let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
                let file = lease.url
                return try await Task.detached(priority: .userInitiated) { try ImageProcessor.info(url: file) }.value
            },
            "image.decode": { [self] args in
                let w = try Arguments.integer(args, "w", range: 1...8192), h = try Arguments.integer(args, "h", range: 1...8192)
                guard w * h <= 24_500_000 else { throw NativeError("size", "Image dimensions exceed the working limit.") }
                guard !decodeBusy else { throw NativeError("busy", "A photo is already being developed.") }
                let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
                decodeBusy = true; defer { decodeBusy = false }
                let file = lease.url
                let data = try await Task.detached(priority: .userInitiated) { try ImageProcessor.decode(url: file, width: w, height: h) }.value
                var ref = try await registry.importData(data, name: "Gesso-original.png", type: "image/png")
                ref["w"] = w; ref["h"] = h
                return ref
            },
            "xfer.create": { [self] args in
                try registry.create(name: Arguments.string(args, "name", max: 255), type: Arguments.string(args, "type", max: 127),
                                    size: Arguments.integer(args, "size", range: 1...TransferRegistry.limit))
            },
            "xfer.release": { [self] args in try registry.release(url: Arguments.url(args)); return [:] as [String: Any] },
            "photos.save": { [self] args in try await save(args) },
            "share": { [self] args in try await share(args) },
            "subject.mask": { [self] args in
                let x = try Arguments.number(args, "x"), y = try Arguments.number(args, "y")
                let radius = args["radius"] == nil ? 12 : try Arguments.number(args, "radius")
                guard (0...128).contains(radius) else { throw NativeError("badArgs", "Invalid subject radius.") }
                guard !subjectBusy else { throw NativeError("busy", "Subject detection is already running. Loop around the subject instead.") }
                let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
                subjectBusy = true; defer { subjectBusy = false }
                let file = lease.url
                return try await Task.detached(priority: .userInitiated) { try ImageProcessor.subject(url: file, x: x, y: y, radius: radius) }.value
            },
            "subject.matte": { [self] args in
                let x = try Arguments.number(args, "x"), y = try Arguments.number(args, "y")
                let radius = args["radius"] == nil ? 12 : try Arguments.number(args, "radius")
                guard (0...128).contains(radius) else { throw NativeError("badArgs", "Invalid subject radius.") }
                guard !subjectBusy else { throw NativeError("busy", "Subject detection is already running.") }
                let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
                subjectBusy = true; defer { subjectBusy = false }
                let file = lease.url
                guard let matte = try await Task.detached(priority: .userInitiated, operation: {
                    try ImageProcessor.subjectMatte(url: file, x: x, y: y, radius: radius)
                }).value else { return ["found": false] }
                var ref = try await registry.importData(matte.png, name: "Gesso-subject-matte.png", type: "image/png")
                ref["found"] = true; ref["w"] = matte.width; ref["h"] = matte.height
                return ref
            },
            "haptic": { [self] args in try haptic(Arguments.string(args, "kind", max: 16)); return [:] as [String: Any] },
            "settings.open": { _ in
                guard let url = URL(string: UIApplication.openSettingsURLString) else { throw NativeError("failed", "Settings are unavailable.") }
                await UIApplication.shared.open(url)
                return [:] as [String: Any]
            },
            "clipboard.write": { args in
                guard let text = args["text"] as? String, text.utf8.count <= 256 * 1024 else { throw NativeError("badArgs", "Invalid clipboard text.") }
                UIPasteboard.general.string = text
                return [:] as [String: Any]
            }
        ]
        guard let operation = operations[op] else { throw NativeError("unsupported", "This native operation is unavailable.") }
        return try await operation(args)
    }

    private func pick() async throws -> Any {
        guard !presentationBusy, let presenter, presenter.presentedViewController == nil else { throw NativeError("busy", "Finish the open sheet first.") }
        presentationBusy = true
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-GessoStubPicker") {
            defer { presentationBusy = false }
            let renderer = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 24))
            let data = renderer.pngData { context in UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 32, height: 24)) }
            return try await registry.importData(data, name: "Gesso-test.png", type: "image/png")
        }
        #endif
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        return try await withCheckedThrowingContinuation { continuation in
            pickContinuation = continuation
            presenter.present(picker, animated: true)
        }
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        guard let provider = results.first?.itemProvider else {
            picker.dismiss(animated: true) { [weak self] in
                guard let self else { return }
                self.finishPick(.success(NSNull()))
            }
            return
        }
        let identifiers = provider.registeredTypeIdentifiers
        let identifier = identifiers.first(where: { UTType($0)?.conforms(to: .rawImage) == true })
            ?? identifiers.first(where: { UTType($0)?.conforms(to: .image) == true }) ?? UTType.image.identifier
        let type = UTType(identifier)
        let ext = type?.preferredFilenameExtension ?? "img"
        let mime = type?.preferredMIMEType ?? "application/octet-stream"
        let name = Self.photoName(provider.suggestedName ?? "Photo", extension: ext)
        let staging = registry.directory.appendingPathComponent("picker-" + UUID().uuidString + "." + ext)
        // Provider-owned URLs expire when this callback returns: copy before crossing actors.
        provider.loadFileRepresentation(forTypeIdentifier: identifier) { [weak self] url, error in
            let copied: Result<URL, Error>
            do {
                guard let url else { throw NativeError("unreadable", "The selected photo is unavailable.") }
                try FileManager.default.copyItem(at: url, to: staging)
                copied = .success(staging)
            } catch { copied = .failure(error) }
            Task { @MainActor [weak self] in
                guard let self else { try? FileManager.default.removeItem(at: staging); return }
                // Wait until dismissal before permitting another presentation.
                await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                    picker.dismiss(animated: true) { continuation.resume() }
                }
                defer { try? FileManager.default.removeItem(at: staging) }
                do {
                    let file = try copied.get()
                    let ref = try await self.registry.importFile(file, name: name, type: mime)
                    self.finishPick(.success(ref))
                } catch { self.finishPick(.failure(NativeError("unreadable", "Could not copy the selected photo."))) }
            }
        }
    }

    private func finishPick(_ result: Result<Any, Error>) {
        let continuation = pickContinuation
        pickContinuation = nil; presentationBusy = false
        continuation?.resume(with: result)
    }

    static func photoName(_ suggested: String, extension ext: String) -> String {
        let safe = suggested.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\\", with: "_")
            .filter { !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }
        let budget = max(1, 255 - ext.utf8.count - 1)
        var stem = ""
        for character in safe {
            guard stem.utf8.count + character.utf8.count <= budget else { break }
            stem.append(character)
        }
        return (stem.isEmpty ? "Photo" : stem) + "." + ext
    }

    private func save(_ args: [String: Any]) async throws -> Any {
        guard !photosBusy else { throw NativeError("busy", "A Photos save is already running.") }
        let name = try Arguments.string(args, "name", max: 255)
        let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
        photosBusy = true
        defer { photosBusy = false }
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("-GessoStubPhotos") { return ["saved": true] }
        #endif
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        if status == .denied { return ["saved": false, "reason": "denied"] as [String: Any] }
        if status == .restricted { return ["saved": false, "reason": "restricted"] as [String: Any] }
        guard status == .authorized || status == .limited else { return ["saved": false, "reason": "failed"] as [String: Any] }
        let file = lease.url
        let success: Bool = await withCheckedContinuation { continuation in
            PHPhotoLibrary.shared().performChanges {
                let asset = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = name
                asset.addResource(with: .photo, fileURL: file, options: options)
            } completionHandler: { success, _ in continuation.resume(returning: success) }
        }
        if success { return ["saved": true] }
        return ["saved": false, "reason": "failed", "message": "Photos could not save the image. Try again or Share."] as [String: Any]
    }

    private func share(_ args: [String: Any]) async throws -> Any {
        guard !presentationBusy, let presenter, presenter.presentedViewController == nil else { throw NativeError("busy", "Finish the open sheet first.") }
        let name = try Arguments.string(args, "name", max: 255)
        guard !name.contains("/"), !name.contains("\\"), name != ".", name != ".." else { throw NativeError("badArgs", "Invalid share filename.") }
        let lease = try registry.lease(url: Arguments.url(args)); defer { lease.release() }
        presentationBusy = true
        defer { presentationBusy = false }
        let directory = registry.directory.appendingPathComponent("share-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent(name)
        let source = lease.url
        try await Task.detached(priority: .userInitiated) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: file)
        }.value
        let activity = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        activity.popoverPresentationController?.sourceView = presenter.view
        activity.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        return await withCheckedContinuation { continuation in
            activity.completionWithItemsHandler = { activityType, completed, _, _ in
                continuation.resume(returning: ["completed": completed, "activity": activityType?.rawValue as Any? ?? NSNull()] as [String: Any])
            }
            presenter.present(activity, animated: true)
        }
    }

    private func haptic(_ kind: String) throws {
        switch kind {
        case "prepare": selection.prepare(); light.prepare(); medium.prepare(); notification.prepare()
        case "tick": selection.selectionChanged()
        case "light": light.impactOccurred()
        case "medium": medium.impactOccurred()
        case "success": notification.notificationOccurred(.success)
        case "warning": notification.notificationOccurred(.warning)
        case "error": notification.notificationOccurred(.error)
        default: throw NativeError("badArgs", "Invalid haptic kind.")
        }
    }
}
