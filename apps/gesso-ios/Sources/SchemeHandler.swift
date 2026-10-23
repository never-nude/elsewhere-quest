import Foundation
import WebKit
import UniformTypeIdentifiers

@MainActor
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    private let registry: TransferRegistry
    private let bundleRoot: URL
    private var live = Set<ObjectIdentifier>()

    init(registry: TransferRegistry, bundleRoot: URL) {
        self.registry = registry; self.bundleRoot = bundleRoot.resolvingSymlinksInPath()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let id = ObjectIdentifier(urlSchemeTask)
        live.insert(id)
        let request = urlSchemeTask.request
        Task { [weak self] in
            guard let self else { return }
            let response = await self.load(request)
            // Stop and delivery share the main actor; nothing can interleave these callbacks.
            guard self.live.remove(id) != nil else { return }
            let url = request.url ?? NativeConfig.entryURL
            let headers = ["Content-Type": response.type, "Content-Length": String(response.data.count),
                           "Cache-Control": "no-store", "Accept-Ranges": "none",
                           "Content-Security-Policy": "default-src 'self' blob: data:; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'"]
            urlSchemeTask.didReceive(HTTPURLResponse(url: url, statusCode: response.status, httpVersion: "HTTP/1.1", headerFields: headers)!)
            urlSchemeTask.didReceive(response.data)
            urlSchemeTask.didFinish()
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        live.remove(ObjectIdentifier(urlSchemeTask))
    }

    private struct Response { let status: Int; let type: String; let data: Data }
    private func json(_ status: Int, _ object: [String: Any]) -> Response {
        Response(status: status, type: "application/json", data: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
    }

    private func load(_ request: URLRequest) async -> Response {
        guard let url = request.url, NativeConfig.isLocal(url),
              let c = URLComponents(url: url, resolvingAgainstBaseURL: false), c.fragment == nil else {
            return json(404, ["error": "Invalid local URL."])
        }
        let method = request.httpMethod ?? "GET"
        if url.path.hasPrefix("/xfer/") {
            guard c.query == nil else { return json(404, ["error": "Invalid transfer URL."]) }
            do {
                _ = try TransferRegistry.issuedName(url)
                if method == "POST" {
                    // WebKit reliably transports ArrayBuffer bodies; missing bytes are explicit errors.
                    do { try await registry.complete(url: url, body: request.httpBody) }
                    catch let error as NativeError {
                        let code = error.code == "busy" ? 409 : error.code == "badUrl" ? 404 : 400
                        return json(code, ["error": error.message])
                    }
                    return json(200, ["size": request.httpBody?.count ?? 0])
                }
                guard method == "GET" else { return json(405, ["error": "Use GET or POST."]) }
                let lease = try registry.lease(url: url)
                defer { lease.release() }
                let file = lease.url, type = lease.type
                let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file, options: .mappedIfSafe) }.value
                return Response(status: 200, type: type, data: data)
            } catch { return json(404, ["error": "Unknown transfer."]) }
        }
        guard method == "GET" else { return json(405, ["error": "Use GET."]) }
        guard c.path.hasPrefix("/gesso/"), !c.path.contains("\\"), !c.path.contains("%"),
              !c.percentEncodedPath.lowercased().contains("%2f"), !c.percentEncodedPath.lowercased().contains("%5c") else {
            return json(404, ["error": "Unknown resource."])
        }
        var relative = String(c.path.dropFirst(7))
        if relative.isEmpty { relative = "index.html" }
        guard !relative.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." || $0.isEmpty }) else {
            return json(404, ["error": "Invalid resource path."])
        }
        let file = bundleRoot.appendingPathComponent(relative).resolvingSymlinksInPath()
        guard file.path.hasPrefix(bundleRoot.path + "/") else { return json(404, ["error": "Invalid resource path."]) }
        let ext = file.pathExtension.lowercased()
        let type = ["js": "text/javascript", "mjs": "text/javascript", "html": "text/html; charset=utf-8", "css": "text/css", "json": "application/json", "webmanifest": "application/manifest+json", "svg": "image/svg+xml"] [ext]
            ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        do {
            let data = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: file, options: .mappedIfSafe) }.value
            return Response(status: 200, type: type, data: data)
        } catch { return json(404, ["error": "Resource not found."]) }
    }
}
