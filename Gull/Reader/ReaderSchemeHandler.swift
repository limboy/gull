import Foundation
import UniformTypeIdentifiers
import WebKit

/// Books currently loaded into a reader, by the random token their resource
/// URLs carry. Only books in the registry can be fetched, so a page can never
/// address files by path.
final class BookRegistry {
    static let shared = BookRegistry()

    struct Entry {
        let content: Data
        let resources: any BookResourceProvider
    }

    private var entries: [String: Entry] = [:]

    func register(token: String, content: Data, resources: any BookResourceProvider) {
        entries[token] = Entry(content: content, resources: resources)
    }

    func unregister(_ token: String) { entries[token] = nil }

    func entry(_ token: String) -> Entry? { entries[token] }
}

/// Serves `gull://app/…`: the reader shell from the app bundle, plus the
/// active books' content and images. Nothing here touches the network.
final class ReaderSchemeHandler: NSObject, WKURLSchemeHandler {
    private var stopped = Set<ObjectIdentifier>()

    private static let webRoot = Bundle.main.resourceURL!.appendingPathComponent("Web", isDirectory: true)

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app" else {
            fail(task, code: NSURLErrorBadURL); return
        }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)

        if parts.first == "book", parts.count >= 3 {
            guard let entry = BookRegistry.shared.entry(parts[1]) else { fail(task, code: NSURLErrorFileDoesNotExist); return }
            if parts[2] == "content.json" {
                respond(task, url: url, data: entry.content, mimeType: "application/json")
                return
            }
            if parts[2] == "res" {
                let path = parts.dropFirst(3).joined(separator: "/").removingPercentEncoding ?? ""
                let provider = entry.resources
                let id = ObjectIdentifier(task)
                Task {
                    let resource = await Task.detached(priority: .userInitiated) { provider.resource(at: path) }.value
                    guard !self.stopped.contains(id) else { self.stopped.remove(id); return }
                    if let resource {
                        self.respond(task, url: url, data: resource.data, mimeType: resource.mimeType)
                    } else {
                        self.fail(task, code: NSURLErrorFileDoesNotExist)
                    }
                }
                return
            }
            fail(task, code: NSURLErrorFileDoesNotExist)
            return
        }

        // App shell: confine lookups to the bundled Web folder.
        let fileURL = Self.webRoot.appendingPathComponent(parts.joined(separator: "/")).standardizedFileURL
        guard fileURL.path.hasPrefix(Self.webRoot.standardizedFileURL.path + "/"),
              let data = try? Data(contentsOf: fileURL) else {
            fail(task, code: NSURLErrorFileDoesNotExist); return
        }
        let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        respond(task, url: url, data: data, mimeType: mime)
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(task))
    }

    private func respond(_ task: any WKURLSchemeTask, url: URL, data: Data, mimeType: String) {
        let headers = [
            "Content-Type": mimeType.hasPrefix("text/") || mimeType == "application/json" || mimeType == "application/javascript"
                ? "\(mimeType); charset=utf-8" : mimeType,
            "Content-Length": String(data.count),
            "Cache-Control": "no-store",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    private func fail(_ task: any WKURLSchemeTask, code: Int) {
        task.didFailWithError(NSError(domain: NSURLErrorDomain, code: code))
    }
}
