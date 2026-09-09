import Foundation
import WidgetKit

@MainActor
final class WidgetAuthBridge {
    private var operation: Task<Void, Never>?
    private var revision = 0

    func receive(_ message: [String: String]) {
        revision += 1
        let currentRevision = revision
        let logoutCredential = message["type"] == "logout" ? WidgetCredentials.load() : nil
        if message["type"] == "logout" {
            if let logoutCredential { WidgetCredentials.queueRevocation(logoutCredential.credential) }
            WidgetCredentials.clear()
            WidgetCenter.shared.reloadAllTimelines()
        }
        let previous = operation
        operation = Task {
            await previous?.value
            for credential in WidgetCredentials.pendingRevocations() { await revoke(credential) }
            if message["type"] == "logout" {
                if let logoutCredential { await revoke(logoutCredential.credential) }
                return
            }
            guard currentRevision == revision, message["type"] == "session", let idToken = message["idToken"],
                  let appCheckToken = message["appCheckToken"],
                  !idToken.isEmpty, !appCheckToken.isEmpty,
                  let deviceId = WidgetCredentials.deviceId() else { return }
            let previousCredential = WidgetCredentials.load()
            var request = URLRequest(url: WidgetConfig.widgetAPIURL.appending(queryItems: [URLQueryItem(name: "action", value: "widget-device-register")]))
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")
            request.setValue(appCheckToken, forHTTPHeaderField: "X-Firebase-AppCheck")
            request.httpBody = try? JSONSerialization.data(withJSONObject: ["deviceId": deviceId])
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let response = response as? HTTPURLResponse else { return }
                if response.statusCode == 401 || response.statusCode == 403 {
                    WidgetCredentials.clear()
                    WidgetCenter.shared.reloadAllTimelines()
                    return
                }
                guard response.statusCode == 200,
                      let credential = try? JSONDecoder().decode(WidgetCredential.self, from: data) else { return }
                guard currentRevision == revision else { await revoke(credential.credential); return }
                guard WidgetCredentials.store(credential) else { await revoke(credential.credential); return }
                if let previousCredential, previousCredential.uid != credential.uid { await revoke(previousCredential.credential) }
                WidgetCenter.shared.reloadAllTimelines()
            } catch {
                // 網路錯誤保留尚未過期的憑證，回到前景後再次同步。
            }
        }
    }

    private func revoke(_ credential: String) async {
        WidgetCredentials.queueRevocation(credential)
        var request = URLRequest(url: WidgetConfig.widgetAPIURL.appending(queryItems: [URLQueryItem(name: "action", value: "widget-device-revoke")]))
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.setValue(credential, forHTTPHeaderField: "X-Widget-Token")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        if let (_, response) = try? await URLSession.shared.data(for: request),
           let status = (response as? HTTPURLResponse)?.statusCode,
           [200, 401].contains(status) {
            WidgetCredentials.completeRevocation(credential)
        }
    }
}
