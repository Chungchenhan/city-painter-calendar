import SwiftUI
import UIKit
import WebKit

struct WebCalendarView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.scrollView.bounces = false
        webView.load(URLRequest(url: WidgetConfig.appURL, cachePolicy: .reloadIgnoringLocalCacheData))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            presentAlert(message: message) {
                completionHandler()
            }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            presentConfirm(message: message) { confirmed in
                completionHandler(confirmed)
            }
        }

        private func presentAlert(message: String, completion: @escaping () -> Void) {
            guard let presenter = topViewController() else {
                completion()
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "確定", style: .default) { _ in completion() })
            presenter.present(alert, animated: true)
        }

        private func presentConfirm(message: String, completion: @escaping (Bool) -> Void) {
            guard let presenter = topViewController() else {
                completion(false)
                return
            }
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completion(false) })
            alert.addAction(UIAlertAction(title: "確定", style: .destructive) { _ in completion(true) })
            presenter.present(alert, animated: true)
        }

        private func topViewController() -> UIViewController? {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
            let root = scene?.windows.first { $0.isKeyWindow }?.rootViewController
            var top = root
            while let presented = top?.presentedViewController {
                top = presented
            }
            return top
        }
    }
}
