//
//  SafariWebExtensionHandler.swift
//  Notion2GPT Extension
//
//  Created by Karat Sidhu on 05/03/26.
//

import SafariServices
import Security
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    private let clientId = Secrets.notionClientId
    private let redirectUri = "https://sidhuk.github.io/Notion2GPT/callback.html"

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let message = request?.userInfo?[SFExtensionMessageKey] as? [String: Any]

        guard let type = message?["type"] as? String else {
            respond(with: ["error": "Missing message type"], context: context)
            return
        }

        os_log(.default, "Received native message type: %{public}@", type)

        Task { @MainActor in
            let response: [String: Any]

            do {
                switch type {
                case "generate-oauth-url":
                    response = try await handleGenerateOAuthURL()
                case "poll-oauth-code":
                    response = try await handlePollOAuthCode()
                case "check-auth":
                    response = await handleCheckAuth()
                case "search-databases":
                    response = try await handleSearchDatabases()
                case "create-database":
                    response = try await handleCreateDatabase(message: message)
                case "save-conversation":
                    response = try await handleSaveConversation(message: message)
                case "disconnect":
                    response = try await handleDisconnect()
                default:
                    response = ["error": "Unknown message type: \(type)"]
                }
            } catch {
                os_log(.error, "Error handling message type %{public}@: %{public}@", type, error.localizedDescription)
                response = ["error": error.localizedDescription]
            }

            self.respond(with: response, context: context)
        }
    }

    // MARK: - Message Handlers

    private func handleGenerateOAuthURL() async throws -> [String: Any] {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw NSError(domain: "SafariWebExtensionHandler", code: Int(status), userInfo: [
                NSLocalizedDescriptionKey: "Failed to generate random state"
            ])
        }
        let state = bytes.map { String(format: "%02x", $0) }.joined()

        try await KeychainHelper.shared.saveString(key: KeychainKey.oauthPendingState, value: state)

        var components = URLComponents(string: "https://api.notion.com/v1/oauth/authorize")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "owner", value: "user"),
            URLQueryItem(name: "state", value: state),
        ]

        return ["url": components.url!.absoluteString]
    }

    private func handlePollOAuthCode() async throws -> [String: Any] {
        let keychain = KeychainHelper.shared

        guard let code = await keychain.readString(key: KeychainKey.oauthPendingCode) else {
            return ["status": "pending"]
        }

        let callbackState = await keychain.readString(key: KeychainKey.oauthCallbackState)
        let pendingState = await keychain.readString(key: KeychainKey.oauthPendingState)

        guard callbackState == pendingState else {
            try await clearOAuthKeys()
            return ["status": "error", "reason": "state_mismatch"]
        }

        do {
            let info = try await NotionAPIClient.shared.exchangeCodeForToken(code: code)
            try await clearOAuthKeys()
            var result: [String: Any] = [
                "status": "connected",
                "workspaceName": info.workspaceName,
            ]
            if let icon = info.workspaceIcon {
                result["workspaceIcon"] = icon
            }
            return result
        } catch {
            return ["status": "error", "reason": error.localizedDescription]
        }
    }

    private func handleCheckAuth() async -> [String: Any] {
        let keychain = KeychainHelper.shared
        guard let _ = await keychain.readString(key: KeychainKey.accessToken) else {
            return ["authenticated": false]
        }

        var result: [String: Any] = ["authenticated": true]
        if let name = await keychain.readString(key: KeychainKey.workspaceName) {
            result["workspaceName"] = name
        }
        if let icon = await keychain.readString(key: KeychainKey.workspaceIcon) {
            result["workspaceIcon"] = icon
        }
        return result
    }

    private func handleSearchDatabases() async throws -> [String: Any] {
        let rawDatabases = try await NotionAPIClient.shared.searchDatabases()

        let databases: [[String: Any]] = rawDatabases.compactMap { db in
            guard let id = db["id"] as? String else { return nil }

            var title = ""
            if let titleArray = db["title"] as? [[String: Any]] {
                title = titleArray.compactMap { $0["plain_text"] as? String }.joined()
            }

            return ["id": id, "title": title]
        }

        return ["databases": databases]
    }

    private func handleCreateDatabase(message: [String: Any]?) async throws -> [String: Any] {
        guard let parentPageId = message?["parentPageId"] as? String else {
            return ["error": "Missing parentPageId"]
        }

        let databaseId = try await NotionAPIClient.shared.createDatabase(parentPageId: parentPageId)
        return ["databaseId": databaseId]
    }

    private func handleSaveConversation(message: [String: Any]?) async throws -> [String: Any] {
        guard let databaseId = message?["databaseId"] as? String,
              let title = message?["title"] as? String,
              let url = message?["url"] as? String,
              let model = message?["model"] as? String,
              let blocks = message?["blocks"] as? [[String: Any]] else {
            return ["error": "Missing required fields (databaseId, title, url, model, blocks)"]
        }

        let dateFormatter = ISO8601DateFormatter()
        dateFormatter.formatOptions = [.withFullDate]
        let date = dateFormatter.string(from: Date())

        let (pageId, pageUrl) = try await NotionAPIClient.shared.createPage(
            databaseId: databaseId,
            title: title,
            url: url,
            model: model,
            date: date
        )

        if !blocks.isEmpty {
            try await NotionAPIClient.shared.appendBlocks(pageId: pageId, blocks: blocks)
        }

        return ["pageId": pageId, "pageUrl": pageUrl]
    }

    private func handleDisconnect() async throws -> [String: Any] {
        try await KeychainHelper.shared.clearAll()
        return ["success": true]
    }

    // MARK: - Helpers

    private func clearOAuthKeys() async throws {
        let keychain = KeychainHelper.shared
        try await keychain.delete(key: KeychainKey.oauthPendingCode)
        try await keychain.delete(key: KeychainKey.oauthPendingState)
        try await keychain.delete(key: KeychainKey.oauthCallbackState)
    }

    private func respond(with message: [String: Any], context: NSExtensionContext) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: message]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
