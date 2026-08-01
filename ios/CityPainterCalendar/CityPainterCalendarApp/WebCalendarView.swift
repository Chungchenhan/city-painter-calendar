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
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true

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
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            guard navigationAction.targetFrame == nil,
                  let presenter = topViewController() else {
                return nil
            }

            let popupWebView = WKWebView(frame: .zero, configuration: configuration)
            popupWebView.uiDelegate = self
            popupWebView.allowsBackForwardNavigationGestures = true
            popupWebView.allowsLinkPreview = false
            popupWebView.scrollView.keyboardDismissMode = .interactive

            let popupController = PopupWebViewController(webView: popupWebView)
            let navigationController = UINavigationController(rootViewController: popupController)
            navigationController.modalPresentationStyle = .fullScreen
            presenter.present(navigationController, animated: true)
            return popupWebView
        }

        func webViewDidClose(_ webView: WKWebView) {
            guard let popupController = topViewController() as? PopupWebViewController,
                  popupController.webView === webView else {
                return
            }
            popupController.navigationController?.dismiss(animated: true)
        }

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
            while true {
                if let presented = top?.presentedViewController {
                    top = presented
                } else if let navigationController = top as? UINavigationController,
                          let visibleController = navigationController.visibleViewController {
                    top = visibleController
                } else if let tabBarController = top as? UITabBarController,
                          let selectedController = tabBarController.selectedViewController {
                    top = selectedController
                } else {
                    break
                }
            }
            return top
        }
    }
}

private final class PopupWebViewController: UIViewController, WKNavigationDelegate {
    let webView: WKWebView
    private let activityIndicator = UIActivityIndicatorView(style: .medium)

    init(webView: WKWebView) {
        self.webView = webView
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "銷售表單"
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            title: "關閉",
            style: .done,
            target: self,
            action: #selector(close)
        )

        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        activityIndicator.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        view.addSubview(activityIndicator)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            activityIndicator.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            activityIndicator.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        activityIndicator.startAnimating()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        activityIndicator.stopAnimating()
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        activityIndicator.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        activityIndicator.stopAnimating()
    }

    @objc private func close() {
        navigationController?.dismiss(animated: true)
    }
}
