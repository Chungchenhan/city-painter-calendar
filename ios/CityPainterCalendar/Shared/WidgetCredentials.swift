import Foundation
import Security

struct WidgetCredential: Codable {
    let credential: String
    let expiresAt: Double
    let uid: String
}

enum WidgetCredentials {
    private static let service = "com.citypainter.calendar.widget-auth"

    private static func query(_ account: String) -> [String: Any]? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "WidgetKeychainAccessGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { return nil }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecAttrAccessGroup as String: group]
    }

    private static func read(_ account: String) -> Data? {
        guard var query = query(account) else { return nil }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    private static func save(_ data: Data, account: String) -> Bool {
        guard var query = query(account) else { return false }
        let attributes = [kSecValueData as String: data]
        let result = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if result == errSecSuccess { return true }
        guard result == errSecItemNotFound else { return false }
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    static func load() -> WidgetCredential? {
        guard let data = read("credential"),
              let result = try? JSONDecoder().decode(WidgetCredential.self, from: data),
              result.expiresAt > Date().timeIntervalSince1970 * 1000 else { return nil }
        return result
    }

    static func store(_ credential: WidgetCredential) -> Bool {
        guard let data = try? JSONEncoder().encode(credential) else { return false }
        return save(data, account: "credential")
    }

    static func clear(matching credential: String? = nil) {
        if let credential, load()?.credential != credential { return }
        guard let query = query("credential") else { return }
        SecItemDelete(query as CFDictionary)
    }

    static func pendingRevocations() -> [String] {
        guard let data = read("pending-revocations") else { return [] }
        return (try? JSONDecoder().decode([String].self, from: data)) ?? []
    }

    static func queueRevocation(_ credential: String) {
        var pending = pendingRevocations()
        if !pending.contains(credential) { pending.append(credential) }
        if let data = try? JSONEncoder().encode(pending) { _ = save(data, account: "pending-revocations") }
    }

    static func completeRevocation(_ credential: String) {
        let pending = pendingRevocations().filter { $0 != credential }
        if let data = try? JSONEncoder().encode(pending) { _ = save(data, account: "pending-revocations") }
    }

    static func deviceId() -> String? {
        if let data = read("device-id"), let value = String(data: data, encoding: .utf8) { return value }
        let value = UUID().uuidString
        return save(Data(value.utf8), account: "device-id") ? value : nil
    }
}
