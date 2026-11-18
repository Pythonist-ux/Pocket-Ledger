import SwiftUI
import UIKit
import WebKit

private let appBackground = UIColor(red: 10 / 255, green: 11 / 255, blue: 15 / 255, alpha: 1)

@main
struct PocketLedgerApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .statusBarHidden(true)               // fullscreen: no status bar
                .persistentSystemOverlays(.hidden)   // fullscreen: hide the home indicator
                .onOpenURL { WebBridge.shared.handle(url: $0) }
        }
    }
}

struct ContentView: View {
    var body: some View {
        ZStack {
            Color(uiColor: appBackground).ignoresSafeArea()
            WebViewContainer().ignoresSafeArea()
        }
    }
}

/// Connects the web UI to iOS: file export, data persistence, and the `pocketledger://` URL scheme.
final class WebBridge: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    static let shared = WebBridge()

    weak var webView: WKWebView?
    var ready = false
    private var pending: [String] = []

    // MARK: Persistence
    // WKWebView's localStorage for file:// pages can be cleared by iOS, so the app also keeps its own
    // copy of the ledger on disk and hands it back to the page at startup.
    private static var storeURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("ledger.json")
    }

    static func loadSeed() -> String? {
        try? String(contentsOf: storeURL, encoding: .utf8)
    }

    // MARK: Shortcuts / URL scheme  ->  pocketledger://add?text=<bank message>
    func handle(url: URL) {
        guard url.scheme == "pocketledger",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let text = items.first(where: { $0.name == "text" || $0.name == "auto_notif" })?.value,
              !text.isEmpty
        else { return }
        if ready, let webView = webView {
            send([text], to: webView)
        } else {
            pending.append(text)
        }
    }

    private func send(_ texts: [String], to webView: WKWebView) {
        guard let data = try? JSONSerialization.data(withJSONObject: texts),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.PL && PL.ingestMany(\(json))", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        if !pending.isEmpty {
            send(pending, to: webView)
            pending.removeAll()
        }
    }

    // MARK: Messages from JavaScript
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "plPersist":
            if let json = message.body as? String {
                try? json.write(to: Self.storeURL, atomically: true, encoding: .utf8)
            }
        case "plSave":
            guard let body = message.body as? [String: Any],
                  let name = body["name"] as? String,
                  let base64 = body["base64"] as? String,
                  let data = Data(base64Encoded: base64) else { return }
            let file = FileManager.default.temporaryDirectory
                .appendingPathComponent((name as NSString).lastPathComponent)
            do { try data.write(to: file) } catch { return }
            DispatchQueue.main.async { Self.present(file) }
        default:
            break
        }
    }

    /// Opens the share sheet ("Save to Files", AirDrop, Mail, Numbers, Excel...).
    private static func present(_ file: URL) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first,
              var top = scene.keyWindow?.rootViewController else { return }
        while let next = top.presentedViewController { top = next }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = top.view   // required on iPad
        sheet.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 1, width: 0, height: 0)
        top.present(sheet, animated: true)
    }
}

struct WebViewContainer: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        let controller = config.userContentController
        controller.add(WebBridge.shared, name: "plSave")
        controller.add(WebBridge.shared, name: "plPersist")
        if let seed = WebBridge.loadSeed(),
           let data = try? JSONSerialization.data(withJSONObject: [seed]),
           let array = String(data: data, encoding: .utf8) {
            controller.addUserScript(WKUserScript(
                source: "window.__PL_SEED = \(array)[0];",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true))
        }

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = WebBridge.shared
        webView.isOpaque = false
        webView.backgroundColor = appBackground
        webView.scrollView.backgroundColor = appBackground
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.showsVerticalScrollIndicator = false
        webView.scrollView.showsHorizontalScrollIndicator = false
        webView.allowsLinkPreview = false

        WebBridge.shared.ready = false
        WebBridge.shared.webView = webView

        if let url = Bundle.main.url(forResource: "index", withExtension: "html") {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        }
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
