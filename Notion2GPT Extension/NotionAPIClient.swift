//
//  NotionAPIClient.swift
//  Notion2GPT Extension
//
//  Created by Karat Sidhu on 05/03/26.
//

import Foundation

// MARK: - Error Types

enum NotionAPIError: Error, LocalizedError {
    case unauthorized
    case rateLimited
    case notFound
    case invalidResponse(String)
    case networkError(Error)
    case keychainError(Error)
    case maxRetriesExceeded

    var errorDescription: String? {
        switch self {
        case .unauthorized:
            return "Unauthorized — please reconnect your Notion account."
        case .rateLimited:
            return "Notion API rate limit exceeded."
        case .notFound:
            return "The requested Notion resource was not found."
        case .invalidResponse(let detail):
            return "Invalid response from Notion API: \(detail)"
        case .networkError(let error):
            return "Network error: \(error.localizedDescription)"
        case .keychainError(let error):
            return "Keychain error: \(error.localizedDescription)"
        case .maxRetriesExceeded:
            return "Maximum retry attempts exceeded."
        }
    }
}

// MARK: - Response Types

struct WorkspaceInfo: Sendable {
    let workspaceId: String
    let workspaceName: String
    let workspaceIcon: String?
    let botId: String
}

// MARK: - NotionAPIClient

nonisolated actor NotionAPIClient {

    static let shared = NotionAPIClient()

    private let clientId = Secrets.notionClientId
    private let clientSecret = Secrets.notionClientSecret
    private let redirectUri = "https://sidhuk.github.io/Notion2GPT/callback.html"
    private let apiVersion = "2025-09-03"
    private let baseURL = "https://api.notion.com"

    private let keychain = KeychainHelper.shared

    private init() {}

    // MARK: - OAuth Token Exchange

    func exchangeCodeForToken(code: String) async throws -> WorkspaceInfo {
        let url = URL(string: "\(baseURL)/v1/oauth/token")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(basicAuthHeader(), forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirectUri,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await performURLRequest(request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        guard statusCode == 200 else {
            let detail = String(data: data, encoding: .utf8) ?? "status \(statusCode)"
            throw NotionAPIError.invalidResponse(detail)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NotionAPIError.invalidResponse("Failed to parse token response")
        }

        guard let accessToken = json["access_token"] as? String else {
            throw NotionAPIError.invalidResponse("Missing access_token in response")
        }

        let refreshToken = json["refresh_token"] as? String
        let botId = json["bot_id"] as? String ?? ""
        let workspaceId = json["workspace_id"] as? String ?? ""
        let workspaceName = json["workspace_name"] as? String ?? ""
        let workspaceIcon = json["workspace_icon"] as? String

        do {
            try await keychain.saveString(key: KeychainKey.accessToken, value: accessToken)
            if let refreshToken {
                try await keychain.saveString(key: KeychainKey.refreshToken, value: refreshToken)
            }
            try await keychain.saveString(key: KeychainKey.botId, value: botId)
            try await keychain.saveString(key: KeychainKey.workspaceId, value: workspaceId)
            try await keychain.saveString(key: KeychainKey.workspaceName, value: workspaceName)
            if let workspaceIcon {
                try await keychain.saveString(key: KeychainKey.workspaceIcon, value: workspaceIcon)
            }
        } catch {
            throw NotionAPIError.keychainError(error)
        }

        return WorkspaceInfo(
            workspaceId: workspaceId,
            workspaceName: workspaceName,
            workspaceIcon: workspaceIcon,
            botId: botId
        )
    }

    // MARK: - Token Refresh

    func refreshAccessToken() async throws -> String {
        guard let refreshToken = await keychain.readString(key: KeychainKey.refreshToken) else {
            throw NotionAPIError.unauthorized
        }

        let url = URL(string: "\(baseURL)/v1/oauth/token")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(basicAuthHeader(), forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "grant_type": "refresh_token",
            "refresh_token": refreshToken,
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await performURLRequest(request)
        let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0

        guard statusCode == 200 else {
            let detail = String(data: data, encoding: .utf8) ?? "status \(statusCode)"
            throw NotionAPIError.invalidResponse(detail)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let newAccessToken = json["access_token"] as? String else {
            throw NotionAPIError.invalidResponse("Missing access_token in refresh response")
        }

        do {
            try await keychain.saveString(key: KeychainKey.accessToken, value: newAccessToken)
            if let newRefreshToken = json["refresh_token"] as? String {
                try await keychain.saveString(key: KeychainKey.refreshToken, value: newRefreshToken)
            }
        } catch {
            throw NotionAPIError.keychainError(error)
        }

        return newAccessToken
    }

    // MARK: - Authenticated Request

    func request(method: String, path: String, body: [String: Any]? = nil) async throws -> [String: Any] {
        var accessToken = await keychain.readString(key: KeychainKey.accessToken)
        guard var token = accessToken else {
            throw NotionAPIError.unauthorized
        }

        for attempt in 0..<3 {
            let url = URL(string: "\(baseURL)\(path)")!
            var urlRequest = URLRequest(url: url)
            urlRequest.httpMethod = method
            urlRequest.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            urlRequest.setValue(apiVersion, forHTTPHeaderField: "Notion-Version")
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

            if let body {
                urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)
            }

            let data: Data
            let response: URLResponse
            do {
                (data, response) = try await performURLRequest(urlRequest)
            } catch {
                throw NotionAPIError.networkError(error)
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                throw NotionAPIError.invalidResponse("Non-HTTP response")
            }

            switch httpResponse.statusCode {
            case 200...299:
                guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw NotionAPIError.invalidResponse("Response is not a JSON object")
                }
                return json

            case 401:
                if attempt == 0 {
                    token = try await refreshAccessToken()
                    continue
                }
                throw NotionAPIError.unauthorized

            case 404:
                throw NotionAPIError.notFound

            case 429:
                let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                    .flatMap(Double.init) ?? 1.0
                try await Task.sleep(nanoseconds: UInt64(retryAfter * 1_000_000_000))
                continue

            default:
                let detail = String(data: data, encoding: .utf8) ?? "status \(httpResponse.statusCode)"
                throw NotionAPIError.invalidResponse(detail)
            }
        }

        throw NotionAPIError.maxRetriesExceeded
    }

    // MARK: - High-Level API Methods

    func searchDatabases() async throws -> [[String: Any]] {
        let body: [String: Any] = [
            "filter": [
                "property": "object",
                "value": "database",
            ]
        ]
        let result = try await request(method: "POST", path: "/v1/search", body: body)

        guard let results = result["results"] as? [[String: Any]] else {
            throw NotionAPIError.invalidResponse("Missing results array in search response")
        }
        return results
    }

    func createDatabase(parentPageId: String) async throws -> String {
        let body: [String: Any] = [
            "parent": [
                "type": "page_id",
                "page_id": parentPageId,
            ],
            "title": [
                [
                    "type": "text",
                    "text": ["content": "ChatGPT Conversations"],
                ]
            ],
            "properties": [
                "Title": ["title": [:] as [String: Any]],
                "URL": ["url": [:] as [String: Any]],
                "Date": ["date": [:] as [String: Any]],
                "Model": ["select": [:] as [String: Any]],
                "Tags": ["multi_select": [:] as [String: Any]],
            ],
        ]

        let result = try await request(method: "POST", path: "/v1/databases", body: body)

        guard let databaseId = result["id"] as? String else {
            throw NotionAPIError.invalidResponse("Missing id in database creation response")
        }
        return databaseId
    }

    func createPage(
        databaseId: String,
        title: String,
        url: String,
        model: String,
        date: String
    ) async throws -> (pageId: String, pageUrl: String) {
        let body: [String: Any] = [
            "parent": [
                "type": "database_id",
                "database_id": databaseId,
            ],
            "properties": [
                "Title": [
                    "title": [
                        ["type": "text", "text": ["content": title]]
                    ]
                ],
                "URL": [
                    "url": url
                ],
                "Date": [
                    "date": ["start": date]
                ],
                "Model": [
                    "select": ["name": model]
                ],
            ],
        ]

        let result = try await request(method: "POST", path: "/v1/pages", body: body)

        guard let pageId = result["id"] as? String else {
            throw NotionAPIError.invalidResponse("Missing id in page creation response")
        }
        let pageUrl = result["url"] as? String ?? ""

        return (pageId: pageId, pageUrl: pageUrl)
    }

    func appendBlocks(pageId: String, blocks: [[String: Any]]) async throws {
        let batchSize = 100
        let batches = stride(from: 0, to: blocks.count, by: batchSize).map {
            Array(blocks[$0..<min($0 + batchSize, blocks.count)])
        }

        for batch in batches {
            let body: [String: Any] = [
                "children": batch
            ]
            _ = try await request(
                method: "PATCH",
                path: "/v1/blocks/\(pageId)/children",
                body: body
            )
        }
    }

    // MARK: - Private Helpers

    private func basicAuthHeader() -> String {
        let credentials = "\(clientId):\(clientSecret)"
        let encoded = Data(credentials.utf8).base64EncodedString()
        return "Basic \(encoded)"
    }

    private func performURLRequest(_ request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await URLSession.shared.data(for: request)
        } catch {
            throw NotionAPIError.networkError(error)
        }
    }
}
