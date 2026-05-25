import SwiftUI
import WebKit

struct WebCalendarView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.load(URLRequest(url: WidgetConfig.appURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
