//
//  KeychainHelper.swift
//  Notion2GPT Extension
//
//  Created by Karat Sidhu on 05/03/26.
//
//  NOTE: This file must be added to both the host app (Notion2GPT) and
//  extension (Notion2GPT Extension) targets so both can share Keychain items
//  via the App Group keychain access group.
//

import Foundation
import Security

// MARK: - Keychain Keys

nonisolated enum KeychainKey {
    static let accessToken = "notion_access_token"
    static let refreshToken = "notion_refresh_token"
    static let botId = "notion_bot_id"
    static let workspaceId = "notion_workspace_id"
    static let workspaceName = "notion_workspace_name"
    static let workspaceIcon = "notion_workspace_icon"
    static let oauthPendingCode = "oauth_pending_code"
    static let oauthPendingState = "oauth_pending_state"
    static let oauthCallbackState = "oauth_callback_state"

    static let allKeys: [String] = [
        accessToken, refreshToken, botId,
        workspaceId, workspaceName, workspaceIcon,
        oauthPendingCode, oauthPendingState, oauthCallbackState,
    ]
}

// MARK: - Keychain Errors

nonisolated enum KeychainError: Error, LocalizedError {
    case itemNotFound
    case duplicateItem
    case unexpectedError(OSStatus)

    var errorDescription: String? {
        switch self {
        case .itemNotFound:
            return "Keychain item not found."
        case .duplicateItem:
            return "Keychain item already exists."
        case .unexpectedError(let status):
            return "Keychain error: \(status)"
        }
    }
}

// MARK: - KeychainHelper

actor KeychainHelper {

    static let shared = KeychainHelper()

    private let service = "com.karatsidhu.Notion2GPT"
    private let accessGroup = "group.com.karatsidhu.Notion2GPT"

    private init() {}

    // MARK: - Core Operations

    func save(key: String, data: Data) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
        ]

        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]

        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)

        switch status {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var newItem = query
            newItem[kSecValueData as String] = data
            newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

            let addStatus = SecItemAdd(newItem as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedError(addStatus)
            }
        default:
            throw KeychainError.unexpectedError(status)
        }
    }

    func read(key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    func delete(key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecAttrAccessGroup as String: accessGroup,
        ]

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedError(status)
        }
    }

    // MARK: - String Convenience

    func saveString(key: String, value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.unexpectedError(errSecParam)
        }
        try save(key: key, data: data)
    }

    func readString(key: String) -> String? {
        guard let data = read(key: key) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    // MARK: - Bulk Operations

    func clearAll() throws {
        for key in KeychainKey.allKeys {
            try delete(key: key)
        }
        SharedDefaults.clearOAuth()
    }
}

// MARK: - Shared UserDefaults for OAuth Handoff

/// Uses App Group shared UserDefaults for cross-process OAuth handoff
/// between the host app (AppDelegate) and the Safari extension.
/// This is more reliable than Keychain for cross-process communication.
nonisolated enum SharedDefaults {
    private static let suiteName = "group.com.karatsidhu.Notion2GPT"

    private enum Key {
        static let oauthPendingCode = "oauth_pending_code"
        static let oauthCallbackState = "oauth_callback_state"
        static let oauthPendingState = "oauth_pending_state"
    }

    private static var suite: UserDefaults? {
        UserDefaults(suiteName: suiteName)
    }

    static var pendingCode: String? {
        get { suite?.string(forKey: Key.oauthPendingCode) }
        set { suite?.set(newValue, forKey: Key.oauthPendingCode) }
    }

    static var callbackState: String? {
        get { suite?.string(forKey: Key.oauthCallbackState) }
        set { suite?.set(newValue, forKey: Key.oauthCallbackState) }
    }

    static var pendingState: String? {
        get { suite?.string(forKey: Key.oauthPendingState) }
        set { suite?.set(newValue, forKey: Key.oauthPendingState) }
    }

    static func clearOAuth() {
        suite?.removeObject(forKey: Key.oauthPendingCode)
        suite?.removeObject(forKey: Key.oauthCallbackState)
        suite?.removeObject(forKey: Key.oauthPendingState)
    }
}
