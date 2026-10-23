import SwiftUI
import UIKit
import WebKit

@main
struct GessoApp: App {
    var body: some Scene {
        WindowGroup { EditorHost().ignoresSafeArea().preferredColorScheme(.dark) }
    }
}

private struct EditorHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> EditorViewController { EditorViewController() }
    func updateUIViewController(_ uiViewController: EditorViewController, context: Context) {}
}

@MainActor
final class EditorViewController: UIViewController, WKNavigationDelegate {
    private(set) var webView: WKWebView!
    private var bridge: Bridge!
    private var schemeHandler: SchemeHandler!
    private var registry: TransferRegistry!
    #if DEBUG
    private var smokeStage = 0
    private var smokeResult: [String: Any] = [:]
    #endif

    override func loadView() {
        do {
            registry = try TransferRegistry(directory: FileManager.default.temporaryDirectory.appendingPathComponent("gesso-transfers", isDirectory: true))
        } catch {
            let label = UILabel(); label.text = "Gesso couldn't prepare temporary storage. Reopen the app to try again."
            label.numberOfLines = 0; label.textColor = .white; label.backgroundColor = .black
            view = label
            return
        }
        let revision = Bundle.main.url(forResource: "revision", withExtension: "txt", subdirectory: "web")
            .flatMap { try? String(contentsOf: $0, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) } ?? "unknown"
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        schemeHandler = SchemeHandler(registry: registry, bundleRoot: root)
        config.setURLSchemeHandler(schemeHandler, forURLScheme: "gesso")
        bridge = Bridge(registry: registry, presenter: self, webRevision: revision)
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "gesso")
        config.userContentController.addUserScript(WKUserScript(source: NativeConfig.injectionScript(webRevision: revision), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 13/255, green: 12/255, blue: 11/255, alpha: 1)
        webView.underPageBackgroundColor = webView.backgroundColor!
        webView.scrollView.backgroundColor = webView.backgroundColor
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        #if DEBUG
        webView.isInspectable = true
        #endif
        view = webView
        excludeWebKitFromBackup()
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification, UIApplication.didReceiveMemoryWarningNotification] {
            NotificationCenter.default.addObserver(self, selector: #selector(flush), name: name, object: nil)
        }
        webView.load(URLRequest(url: entryURL))
    }

    private var entryURL: URL {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-GessoProbe") { return URL(string: NativeConfig.origin + "/gesso/?probe=1")! }
        if ProcessInfo.processInfo.arguments.contains("-GessoSmoke") { return NativeConfig.entryURL }
        #endif
        return NativeConfig.studioURL
    }

    @objc private func flush() {
        webView?.evaluateJavaScript("window.gessoStudio?.engine?.flush?.() ?? window.gesso?.flush?.()", completionHandler: nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.load(URLRequest(url: entryURL))
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 preferences: WKWebpagePreferences, decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
        // All executable content is bundled and navigation stays on this pinned origin.
        let local = navigationAction.request.url.map {
            NativeConfig.isLocal($0) && (URLComponents(url: $0, resolvingAgainstBaseURL: false)?.path.hasPrefix("/gesso/") ?? false)
        } ?? false
        decisionHandler(local ? .allow : .cancel, preferences)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        excludeWebKitFromBackup()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-GessoSmoke") { runSmoke() }
        #endif
    }

    #if DEBUG
    private func runSmoke() {
        guard smokeStage == 0 || smokeStage == 2 else { return }
        let first = smokeStage == 0
        smokeStage = first ? 1 : 3
        Task {
            do {
                let value = try await webView.callAsyncJavaScript(first ? DebugSmoke.initialScript : DebugSmoke.reloadScript,
                                                                 arguments: [:], in: nil, contentWorld: .page)
                guard let result = value as? [String: Any] else { throw NativeError("failed", "Smoke test returned no result.") }
                smokeResult.merge(result) { _, new in new }
                if first { smokeStage = 2; webView.reload() }
                else { smokeResult["ok"] = true; DebugSmoke.write(smokeResult) }
            } catch {
                smokeResult["ok"] = false; smokeResult["error"] = String(describing: error)
                DebugSmoke.write(smokeResult)
            }
        }
    }
    #endif

    private func excludeWebKitFromBackup() {
        guard let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first else { return }
        var directory = library.appendingPathComponent("WebKit", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            try directory.setResourceValues(values)
        } catch { /* Best effort; release validation verifies the actual store location. */ }
    }
}
