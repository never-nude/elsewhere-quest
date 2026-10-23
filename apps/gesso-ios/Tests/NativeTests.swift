import XCTest
import WebKit
import UIKit
import ImageIO
import CoreImage
import UniformTypeIdentifiers
@testable import Gesso

@MainActor
final class NativeTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("gesso-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    func testPinnedIdentityAndArgumentValidation() throws {
        XCTAssertEqual(NativeConfig.origin, "gesso://localhost")
        XCTAssertEqual(NativeConfig.entryURL.absoluteString, "gesso://localhost/gesso/")
        XCTAssertThrowsError(try Arguments.integer(["w": true], "w", range: 1...8192))
        XCTAssertThrowsError(try Arguments.integer(["w": 1.5], "w", range: 1...8192))
        XCTAssertThrowsError(try Arguments.number(["x": Double.infinity], "x"))
        XCTAssertTrue(NativeConfig.injectionScript(webRevision: "test").contains("configurable:false"))
        let filename = Bridge.photoName(String(repeating: "画", count: 200) + "/\n", extension: "dng")
        XCTAssertLessThanOrEqual(filename.utf8.count, 255)
        XCTAssertFalse(filename.contains("/")); XCTAssertFalse(filename.contains("\n"))
    }

    func testTransferLifecycleFiveMegabytesAndDeferredDeletion() async throws {
        let registry = try TransferRegistry(directory: directory())
        let size = 5 * 1024 * 1024
        let bytes = Data((0..<size).map { UInt8($0 & 255) })
        let badRef = try registry.create(name: "bad.jpg", type: "image/jpeg", size: size)
        let badURL = URL(string: badRef["url"] as! String)!
        do { try await registry.complete(url: badURL, body: Data([1])); XCTFail("A short upload must fail") }
        catch let error as NativeError { XCTAssertEqual(error.code, "transfer") }
        do { try await registry.complete(url: badURL, body: bytes); XCTFail("A failed upload consumes its reservation") }
        catch let error as NativeError { XCTAssertEqual(error.code, "busy") }
        XCTAssertThrowsError(try registry.lease(url: badURL))
        try registry.release(url: badURL)
        let ref = try registry.create(name: "photo.jpg", type: "image/jpeg", size: size)
        let url = URL(string: ref["url"] as! String)!
        XCTAssertThrowsError(try registry.lease(url: url))
        try await registry.complete(url: url, body: bytes)
        let read = try await registry.data(for: url)
        XCTAssertEqual(read, bytes)
        do { try await registry.complete(url: url, body: bytes); XCTFail("A duplicate upload must fail") }
        catch let error as NativeError { XCTAssertEqual(error.code, "busy") }
        let lease = try registry.lease(url: url)
        try registry.release(url: url)
        try registry.release(url: url)
        XCTAssertThrowsError(try registry.lease(url: url))
        XCTAssertTrue(FileManager.default.fileExists(atPath: lease.url.path))
        XCTAssertEqual(try Data(contentsOf: lease.url), bytes)
        lease.release()
        XCTAssertFalse(FileManager.default.fileExists(atPath: lease.url.path))
        try registry.release(url: url)
    }

    func testTransferURLRejectionAndStartupPurge() throws {
        let root = try directory()
        let stale = root.appendingPathComponent("old-file")
        try Data([1]).write(to: stale)
        let registry = try TransferRegistry(directory: root)
        XCTAssertFalse(FileManager.default.fileExists(atPath: stale.path))
        let id = UUID().uuidString.lowercased()
        for text in ["file:///xfer/\(id).png", "gesso://elsewhere/xfer/\(id).png", "gesso://localhost:80/xfer/\(id).png",
                     "gesso://user@localhost/xfer/\(id).png", "gesso://localhost/xfer/\(id).png?a=1",
                     "gesso://localhost/xfer/\(id).png#fragment", "gesso://localhost/xfer/../\(id).png",
                     "gesso://localhost/xfer/\(id)%2epng", "gesso://localhost/xfer/\(id).png/other"] {
            XCTAssertThrowsError(try TransferRegistry.issuedName(URL(string: text)!), text)
        }
        XCTAssertThrowsError(try registry.create(name: "../photo.jpg", type: "image/jpeg", size: 1))
        XCTAssertThrowsError(try registry.create(name: "photo.jpg", type: "image/jpeg", size: TransferRegistry.limit + 1))
        XCTAssertThrowsError(try registry.create(name: "photo.jpg", type: "image/jpeg\nInjected", size: 1))
    }

    func testDecodeBakesEXIFOrientationAndExactPNGSize() async throws {
        let root = try directory()
        let input = root.appendingPathComponent("rotated.jpg")
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 20))
        let image = renderer.image { c in
            UIColor.red.setFill(); c.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
            UIColor.blue.setFill(); c.fill(CGRect(x: 20, y: 0, width: 20, height: 20))
        }.cgImage!
        let dest = CGImageDestinationCreateWithURL(input as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, image, [kCGImagePropertyOrientation: 6] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        let info = try ImageProcessor.info(url: input)
        // The renderer uses the screen scale; orientation swaps its physical dimensions.
        XCTAssertEqual(info["natW"] as? Int, image.height)
        XCTAssertEqual(info["natH"] as? Int, image.width)
        XCTAssertEqual(info["raw"] as? Bool, false)
        let png = try await Task.detached { try ImageProcessor.decode(url: input, width: 10, height: 20) }.value
        let source = CGImageSourceCreateWithData(png as CFData, nil)!
        let output = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        XCTAssertEqual(output.width, 10); XCTAssertEqual(output.height, 20)
        XCTAssertEqual(output.bitsPerComponent, 8)
        XCTAssertEqual(CGImageSourceGetType(source)! as String, UTType.png.identifier)
        let ci = CIImage(cgImage: output), context = CIContext()
        var top: [UInt8] = [0, 0, 0, 0], bottom = top
        context.render(ci, toBitmap: &top, rowBytes: 4, bounds: CGRect(x: 5, y: 17, width: 1, height: 1), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        context.render(ci, toBitmap: &bottom, rowBytes: 4, bounds: CGRect(x: 5, y: 2, width: 1, height: 1), format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!)
        XCTAssertGreaterThan(top[0], 220); XCTAssertLessThan(top[2], 35)
        XCTAssertGreaterThan(bottom[2], 220); XCTAssertLessThan(bottom[0], 35)
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as! [CFString: Any]
        XCTAssertTrue(properties[kCGImagePropertyOrientation] == nil || properties[kCGImagePropertyOrientation] as? Int == 1)
    }

    func testBridgeRejectsUnknownOperationAndBadDimensions() async throws {
        let registry = try TransferRegistry(directory: directory())
        let bridge = Bridge(registry: registry, presenter: UIViewController(), webRevision: "test")
        do { _ = try await bridge.dispatch(op: "heal", args: [:]); XCTFail("Reserved operation must reject") }
        catch let error as NativeError { XCTAssertEqual(error.code, "unsupported") }
        do { _ = try await bridge.dispatch(op: "image.decode", args: ["w": 8192, "h": 8192]); XCTFail("Oversize decode must reject") }
        catch let error as NativeError { XCTAssertEqual(error.code, "size") }
    }

    func testSchemeMIMEPathsAndStoppedTask() async throws {
        let root = try directory()
        try "export const x = 1;".write(to: root.appendingPathComponent("module.js"), atomically: true, encoding: .utf8)
        let outside = try directory().appendingPathComponent("private.txt")
        try Data([42]).write(to: outside)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("leak.txt"), withDestinationURL: outside)
        let registry = try TransferRegistry(directory: directory())
        let handler = SchemeHandler(registry: registry, bundleRoot: root)
        let webView = WKWebView()
        for (path, status) in [("module.js", 200), ("missing.js", 404), ("../private.txt", 404), ("%2e%2e/private.txt", 404), ("leak.txt", 404), ("sub%2fmodule.js", 404)] {
            let done = expectation(description: path)
            let task = SchemeTask(url: URL(string: NativeConfig.origin + "/gesso/" + path)!)
            task.finished = { done.fulfill() }
            handler.webView(webView, start: task)
            await fulfillment(of: [done], timeout: 5)
            XCTAssertEqual(task.response?.statusCode, status, path)
            if path == "module.js" { XCTAssertEqual(task.response?.mimeType, "text/javascript") }
            XCTAssertEqual(task.response?.value(forHTTPHeaderField: "Accept-Ranges"), "none")
        }
        let noCallbacks = expectation(description: "stopped task receives no callbacks")
        noCallbacks.isInverted = true
        let stopped = SchemeTask(url: URL(string: NativeConfig.origin + "/gesso/module.js")!)
        stopped.callback = { noCallbacks.fulfill() }
        handler.webView(webView, start: stopped)
        handler.webView(webView, stop: stopped)
        await fulfillment(of: [noCallbacks], timeout: 0.2)
        XCTAssertEqual(stopped.callbackCount, 0)
    }
}

@MainActor
private final class SchemeTask: NSObject, @preconcurrency WKURLSchemeTask {
    let request: URLRequest
    var response: HTTPURLResponse?
    var callbackCount = 0
    var finished: (() -> Void)?
    var callback: (() -> Void)?
    init(url: URL) { request = URLRequest(url: url) }
    private func called() { callbackCount += 1; callback?() }
    func didReceive(_ response: URLResponse) { called(); self.response = response as? HTTPURLResponse }
    func didReceive(_ data: Data) { called() }
    func didFinish() { called(); finished?() }
    func didFailWithError(_ error: Error) { called(); finished?() }
}

@MainActor
final class WebViewSmokeTests: XCTestCase, WKNavigationDelegate {
    private var navigationExpectation: XCTestExpectation?
    private var window: UIWindow?
    private var retained: [AnyObject] = []

    private func navigate(_ webView: WKWebView) async throws {
        let expectation = expectation(description: "custom-origin navigation")
        navigationExpectation = expectation
        webView.navigationDelegate = self
        webView.load(URLRequest(url: NativeConfig.entryURL))
        await fulfillment(of: [expectation], timeout: 30)
        navigationExpectation = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { navigationExpectation?.fulfill() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        XCTFail("Navigation failed: \(error)"); navigationExpectation?.fulfill()
    }

    private func harness(root: URL) throws -> WKWebView {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("gesso-web-test-" + UUID().uuidString, isDirectory: true)
        let registry = try TransferRegistry(directory: directory)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let controller = UIViewController()
        let bridge = Bridge(registry: registry, presenter: controller, webRevision: "smoke")
        let scheme = SchemeHandler(registry: registry, bundleRoot: root)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(scheme, forURLScheme: "gesso")
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "gesso")
        config.userContentController.addUserScript(WKUserScript(source: NativeConfig.injectionScript(webRevision: "smoke"), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
        controller.view = webView
        let window = UIWindow(frame: webView.bounds); window.rootViewController = controller; window.makeKeyAndVisible()
        self.window = window
        retained = [registry, bridge, scheme, controller, webView]
        return webView
    }

    override func tearDown() {
        window?.isHidden = true; window = nil; retained = []; super.tearDown()
    }

    func testActualEditorHostLoadsPinnedEntryAndRunsSmoke() async throws {
        let controller = EditorViewController()
        controller.loadViewIfNeeded()
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = controller; window.makeKeyAndVisible()
        self.window = window; retained = [controller, controller.webView]
        let loaded = expectation(for: NSPredicate(format: "loading == false"), evaluatedWith: controller.webView!, handler: nil)
        await fulfillment(of: [loaded], timeout: 30)
        let result = try await controller.webView.callAsyncJavaScript(DebugSmoke.initialScript, arguments: [:], in: nil, contentWorld: .page) as! [String: Any]
        XCTAssertEqual(result["editor"] as? Bool, true)
        XCTAssertEqual(result["origin"] as? String, NativeConfig.origin)
        XCTAssertEqual(result["postBytes"] as? Int, 5 * 1024 * 1024)
        _ = try await controller.webView.callAsyncJavaScript(DebugSmoke.reloadScript, arguments: [:], in: nil, contentWorld: .page)
    }

    func testRealCustomOriginArrayBufferPOSTFiveMBAndModuleWorker() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("gesso-shell-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        try "<!doctype html><title>Gesso native smoke</title>".write(to: root.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        try "export const answer = 42;".write(to: root.appendingPathComponent("answer.js"), atomically: true, encoding: .utf8)
        try "import {answer} from './answer.js'; self.onmessage = () => postMessage(answer);".write(to: root.appendingPathComponent("worker.js"), atomically: true, encoding: .utf8)
        try "<!doctype html><script src='child.js'></script>".write(to: root.appendingPathComponent("child.html"), atomically: true, encoding: .utf8)
        try "webkit.messageHandlers.gesso.postMessage({op:'ping',args:{}}).then(reply=>parent.postMessage({iframe:reply},'*'));".write(to: root.appendingPathComponent("child.js"), atomically: true, encoding: .utf8)
        let webView = try harness(root: root)
        try await navigate(webView)
        let result = try await webView.callAsyncJavaScript("""
          const bridge = window.webkit.messageHandlers.gesso;
          const ping = await bridge.postMessage({op:'ping',args:{}});
          if (!ping.ok || ping.result.api !== 1) throw Error('ping rejected');
          const bad = await bridge.postMessage({op:'xfer.create',args:{name:'bad.jpg',type:'image/jpeg',size:4}});
          const badPost = await fetch(bad.result.url,{method:'POST',body:new Uint8Array(1).buffer});
          const retried = await fetch(bad.result.url,{method:'POST',body:new Uint8Array(4).buffer});
          await bridge.postMessage({op:'xfer.release',args:{url:bad.result.url}});
          const unknown = await bridge.postMessage({op:'heal',args:{}});
          const malformed = await bridge.postMessage({op:'ping',args:[]});
          const iframe = await new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(Error('iframe reply timeout')),5000);
            const listener=e=>{if(e.data?.iframe){clearTimeout(timer);removeEventListener('message',listener);frame.remove();resolve(e.data.iframe);}};
            addEventListener('message',listener);
            const frame=document.createElement('iframe');frame.src='/gesso/child.html';document.body.append(frame);
          });
          const size = 5 * 1024 * 1024;
          const bytes = new Uint8Array(size);
          for(let i=0;i<size;i++) bytes[i] = i & 255;
          const created = await bridge.postMessage({op:'xfer.create',args:{name:'large.jpg',type:'image/jpeg',size}});
          if(!created.ok) throw Error(JSON.stringify(created));
          const url = created.result.url;
          const before = await fetch(url);
          const upload = await fetch(url,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:bytes.buffer});
          const uploaded = await upload.json();
          if(upload.status !== 200 || uploaded.size !== size) throw Error('POST failed: '+JSON.stringify(uploaded));
          const read = new Uint8Array(await (await fetch(url)).arrayBuffer());
          if(read.length !== size) throw Error('wrong size');
          for(let i=0;i<size;i++) if(read[i] !== (i & 255)) throw Error('wrong byte '+i);
          const duplicate = await fetch(url,{method:'POST',body:bytes.buffer});
          await bridge.postMessage({op:'xfer.release',args:{url}});
          const after = await fetch(url);
          const workerResult = await new Promise((resolve,reject)=>{
            const worker = new Worker('/gesso/worker.js',{type:'module'});
            const timeout = setTimeout(()=>{worker.terminate();reject(Error('module worker timeout'));},10000);
            worker.onmessage = ({data})=>{clearTimeout(timeout);worker.terminate();resolve(data);};
            worker.onerror = e=>{clearTimeout(timeout);worker.terminate();reject(Error(e.message));};
            worker.postMessage('run');
          });
          return {before:before.status,after:after.status,duplicate:duplicate.status,bad:badPost.status,retried:retried.status,size:read.length,worker:workerResult,secure:isSecureContext,origin:location.origin,unknown:unknown.error?.code,malformed:malformed.error?.code,iframe:iframe.error?.code};
          """, arguments: [:], in: nil, contentWorld: .page) as! [String: Any]
        XCTAssertEqual(result["before"] as? Int, 404)
        XCTAssertEqual(result["after"] as? Int, 404)
        XCTAssertEqual(result["duplicate"] as? Int, 409)
        XCTAssertEqual(result["bad"] as? Int, 400); XCTAssertEqual(result["retried"] as? Int, 409)
        XCTAssertEqual(result["size"] as? Int, 5 * 1024 * 1024)
        XCTAssertEqual(result["worker"] as? Int, 42)
        XCTAssertEqual(result["secure"] as? Bool, true)
        XCTAssertEqual(result["origin"] as? String, NativeConfig.origin)
        XCTAssertEqual(result["unknown"] as? String, "unsupported")
        XCTAssertEqual(result["malformed"] as? String, "badArgs")
        XCTAssertEqual(result["iframe"] as? String, "badArgs")
    }

    func testStorageSurvivesReloadAtPinnedOrigin() async throws {
        let root = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true)
        let webView = try harness(root: root)
        try await navigate(webView)
        let first = try await webView.callAsyncJavaScript(DebugSmoke.initialScript, arguments: [:], in: nil, contentWorld: .page) as! [String: Any]
        XCTAssertEqual(first["editor"] as? Bool, true)
        XCTAssertEqual((first["moduleJPEG"] as? [String: Any])?["type"] as? String, "image/jpeg")
        try await navigate(webView)
        let stored = try await webView.callAsyncJavaScript(DebugSmoke.reloadScript, arguments: [:], in: nil, contentWorld: .page) as! [String: Any]
        XCTAssertEqual(stored["localStorage"] as? Bool, true); XCTAssertEqual(stored["indexedDB"] as? Bool, true)
    }
}
