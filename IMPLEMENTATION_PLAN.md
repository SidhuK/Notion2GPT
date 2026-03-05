# Notion2GPT — Implementation Plan

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Safari Browser                          │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │  content.js   │  │  popup.html  │  │   background.js    │  │
│  │ (DOM Scraper) │  │  popup.js    │  │ (Orchestrator —    │  │
│  │              │  │              │  │  NO secrets here)  │  │
│  └──────┬───────┘  └──────┬───────┘  └───┬────────────────┘  │
│         │                 │              │                    │
└─────────┼─────────────────┼──────────────┼────────────────────┘
          │                 │              │
          └────────────────►│◄─────────────┘
                    messages via
                  browser.runtime
                            │
                            │ browser.runtime.sendNativeMessage()
                            │ (extension-initiated only)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     macOS Host App (Trusted)                  │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  SafariWebExtensionHandler.swift                        │ │
│  │  ─ Handles ALL Notion API calls (token exchange,        │ │
│  │    refresh, create DB, create page, append blocks)      │ │
│  │  ─ Stores CLIENT_SECRET in compiled Swift               │ │
│  │  ─ Reads/writes tokens via macOS Keychain               │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  AppDelegate.swift                                      │ │
│  │  ─ Registers notion2gpt:// URL scheme                   │ │
│  │  ─ Receives OAuth callback, stores code in Keychain     │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  KeychainHelper.swift (new)                             │ │
│  │  ─ Thread-safe Keychain read/write via actor isolation  │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  NotionAPIClient.swift (new)                            │ │
│  │  ─ All Notion HTTP requests with token management       │ │
│  │  ─ Rate limit handling (429 backoff)                    │ │
│  └─────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
                            │
                    URLSession (Swift)
                    with Bearer token
                            │
                            ▼
                ┌───────────────────────┐
                │     Notion API        │
                │  /v1/oauth/token      │
                │  /v1/databases        │
                │  /v1/pages            │
                │  /v1/blocks/:id/children
                │  /v1/search           │
                │                       │
                │  Notion-Version:      │
                │    2025-09-03         │
                └───────────────────────┘
```

### Security Boundary

All secret material (OAuth client secret, access tokens, refresh tokens) lives **exclusively in compiled Swift code and macOS Keychain**. Extension JS (`background.js`, `popup.js`, `content.js`) never sees secrets — it sends structured commands to the native handler via `browser.runtime.sendNativeMessage()` and receives sanitized results.

---

## Phase 1: Manifest & Permissions

**File:** `Notion2GPT Extension/Resources/manifest.json`

- Change `content_scripts.matches` from `*://example.com/*` → `["*://chatgpt.com/*", "*://chat.com/*"]`
- Add `permissions`: `["storage", "activeTab", "tabs"]`
- Remove `host_permissions` for `api.notion.com` — JS no longer makes Notion API calls directly

---

## Phase 2: Content Script — DOM Scraper

**File:** `Notion2GPT Extension/Resources/content.js`

Scrapes the active ChatGPT conversation from the DOM.

### Selector Strategy (resilience against DOM changes)

Use a **tiered fallback approach** — try selectors in priority order:

```javascript
// Tier 1: Data attributes (most stable, semantic)
const SELECTORS_T1 = {
  messages:   '[data-message-author-role]',
  userMsg:    '[data-message-author-role="user"]',
  assistMsg:  '[data-message-author-role="assistant"]',
};

// Tier 2: ARIA / structural (less likely to change)
const SELECTORS_T2 = {
  messages:   'article[data-testid^="conversation-turn"]',
  turnGroup:  '[data-testid="conversation-turn-"]',
};

// Tier 3: Class-based heuristics (last resort)
const SELECTORS_T3 = {
  messages:   'div.group\\/conversation-turn',
};
```

### Data Extraction

| Data Point     | How to Extract                                                  |
| -------------- | --------------------------------------------------------------- |
| **Chat title** | `document.title` (ChatGPT sets it to the conversation title)    |
| **Chat URL**   | `window.location.href`                                          |
| **Model**      | Model badge element in DOM, with fallback to page metadata      |
| **Messages**   | Tiered selectors above; iterate top-to-bottom                   |

### Schema Validation

Before returning scraped data, validate the result against a minimal schema:

```javascript
function validateScrapedData(data) {
  if (!data.title || typeof data.title !== 'string') return false;
  if (!data.url || !data.url.startsWith('http')) return false;
  if (!Array.isArray(data.messages) || data.messages.length === 0) return false;
  for (const msg of data.messages) {
    if (!['user', 'assistant'].includes(msg.role)) return false;
    if (!Array.isArray(msg.blocks) || msg.blocks.length === 0) return false;
  }
  return true;
}
```

### Edge Cases to Handle

- **Streaming in progress**: Detect partial/streaming messages (e.g. presence of a cursor element or `data-is-streaming="true"`) and either wait or warn the user
- **Artifacts / tool output**: Identify non-standard blocks (canvas, DALL-E images, code interpreter output) and capture them as descriptive text or skip gracefully
- **Empty conversations**: Detect and show "Nothing to save" in popup

The content script exposes a function via `browser.runtime.onMessage` that:

1. Walks all message elements top-to-bottom using tiered selectors
2. For each message, parses the inner HTML into a structured array: `{ role, blocks[] }` where blocks are `paragraph | heading | code | list | table`
3. Validates the result with `validateScrapedData()`
4. Returns `{ title, url, model, messages[], scrapedAt }` to the background script

---

## Phase 3: OAuth Flow (Secure)

**Files:**
- `AppDelegate.swift` — URL scheme handler
- `SafariWebExtensionHandler.swift` — Token exchange (holds CLIENT_SECRET)
- `KeychainHelper.swift` (new) — Secure token storage
- `background.js` — Orchestration only (no secrets)
- `Info.plist` (host app) — URL scheme registration

### Security Model

| Secret                | Where it lives                        | Who can access it      |
| --------------------- | ------------------------------------- | ---------------------- |
| `CLIENT_ID`           | Compiled Swift constant               | Native code only       |
| `CLIENT_SECRET`       | Compiled Swift constant               | Native code only       |
| `access_token`        | macOS Keychain                        | Native code only       |
| `refresh_token`       | macOS Keychain                        | Native code only       |
| `oauth_state` (CSRF)  | macOS Keychain (temporary)            | Native code only       |
| Selected `database_id`| `browser.storage.local`               | Extension JS (safe)    |

### Flow

```
1.  User clicks "Connect to Notion" in popup.js
2.  popup.js sends message to background.js: { action: "start-oauth" }
3.  background.js calls sendNativeMessage({ type: "generate-oauth-url" })
4.  SafariWebExtensionHandler:
      a. Generates a cryptographic random `state` string (32 bytes, hex-encoded)
      b. Stores `state` in Keychain (key: "oauth_pending_state")
      c. Returns the full authorization URL to background.js:
         https://api.notion.com/v1/oauth/authorize?
           client_id=<CLIENT_ID>&
           redirect_uri=notion2gpt://oauth-callback&
           response_type=code&
           owner=user&
           state=<generated_state>
5.  background.js opens the URL in a new tab
6.  User authorizes in Notion → redirected to notion2gpt://oauth-callback?code=xxx&state=yyy
7.  AppDelegate.swift catches the URL scheme:
      a. Extracts `code` and `state` from query parameters
      b. Stores both in Keychain (keys: "oauth_pending_code", "oauth_callback_state")
8.  background.js polls native handler: sendNativeMessage({ type: "poll-oauth-code" })
    (polls every 1s, max 120s timeout, then gives up)
9.  SafariWebExtensionHandler receives "poll-oauth-code":
      a. Reads "oauth_pending_code" and "oauth_callback_state" from Keychain
      b. If not yet available → responds { status: "pending" }
      c. If available → validates state matches "oauth_pending_state"
         - Mismatch → responds { status: "error", reason: "state_mismatch" }, clears Keychain
      d. On valid state → exchanges code for tokens:
           POST https://api.notion.com/v1/oauth/token
           Authorization: Basic base64(CLIENT_ID:CLIENT_SECRET)
           Content-Type: application/json
           Body: { "grant_type": "authorization_code", "code": <code>, "redirect_uri": "..." }
      e. Stores access_token, refresh_token, bot_id, workspace_id in Keychain
      f. Clears temporary oauth_pending_* entries from Keychain
      g. Responds { status: "connected", workspaceName, workspaceIcon }
10. background.js stops polling, notifies popup of success
```

### Host App Info.plist

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>Notion OAuth Callback</string>
    <key>CFBundleURLSchemes</key>
    <array><string>notion2gpt</string></array>
  </dict>
</array>
```

---

## Phase 4: Keychain Helper (new Swift file)

**New file:** `Notion2GPT Extension/KeychainHelper.swift`

Shared between the host app and extension via an **App Group**.

```swift
import Security

actor KeychainHelper {
    static let shared = KeychainHelper()
    private let serviceName = "com.karatsidhu.Notion2GPT"

    func save(key: String, data: Data) throws { ... }
    func read(key: String) -> Data? { ... }
    func delete(key: String) throws { ... }

    // Convenience for String values
    func saveString(key: String, value: String) throws { ... }
    func readString(key: String) -> String? { ... }
}
```

Key design decisions:
- Uses Swift `actor` for thread-safe, isolated access
- Uses `kSecAttrAccessGroup` with a shared App Group so both the host app (writes OAuth code) and the extension (reads/writes tokens) share the same Keychain items
- `kSecAttrAccessible` set to `kSecAttrAccessibleAfterFirstUnlock` for background access

### App Group Setup

Both the host app and extension targets must share an App Group (e.g. `group.com.karatsidhu.Notion2GPT`) configured in Xcode under Signing & Capabilities.

---

## Phase 5: Notion API Client (new Swift file)

**New file:** `Notion2GPT Extension/NotionAPIClient.swift`

All Notion HTTP requests happen in Swift via `URLSession`. This keeps tokens inside the native boundary.

### API Version

All requests use header: `Notion-Version: 2025-09-03` (current latest).

### Token Refresh

```swift
actor NotionAPIClient {
    private let clientId = "YOUR_CLIENT_ID"       // compiled constant
    private let clientSecret = "YOUR_CLIENT_SECRET" // compiled constant
    private let apiVersion = "2025-09-03"

    /// Makes an authenticated Notion API request.
    /// Automatically refreshes the token on 401 (once) and retries.
    func request(_ method: String, path: String, body: [String: Any]?) async throws -> [String: Any] {
        var token = try getAccessToken()
        var response = try await makeRequest(method, path: path, body: body, token: token)

        if response.statusCode == 401 {
            token = try await refreshAccessToken()
            response = try await makeRequest(method, path: path, body: body, token: token)
        }

        if response.statusCode == 429 {
            let retryAfter = response.headerValue("Retry-After") ?? 1.0
            try await Task.sleep(for: .seconds(retryAfter))
            return try await request(method, path: path, body: body) // retry
        }

        return response.json
    }

    /// Refreshes the access token using the stored refresh_token.
    private func refreshAccessToken() async throws -> String {
        let refreshToken = try getRefreshToken()
        let encoded = Data("\(clientId):\(clientSecret)".utf8).base64EncodedString()

        // POST /v1/oauth/token
        // Authorization: Basic <encoded>
        // Body: { "grant_type": "refresh_token", "refresh_token": "<token>" }

        // Store new access_token and refresh_token in Keychain
        // Return new access_token
    }
}
```

### Rate Limiting & Backoff

Notion rate limits return HTTP 429 with a `Retry-After` header. The client:

1. Reads `Retry-After` value (seconds)
2. Waits that duration using `Task.sleep`
3. Retries the request (max 3 retries per call, then throws)

### Request Size Limits

- **Append block children**: Max 100 blocks per request. For conversations exceeding this, chunk into sequential batches.
- **Rich text content**: Max 2000 chars per text object. The HTML-to-blocks converter handles chunking.
- **Overall payload**: Keep under 1MB per request. For very long conversations, split page creation across multiple append calls.

### Supported Operations

```swift
// Search for databases the integration can access
func searchDatabases() async throws -> [[String: Any]]

// Create the "ChatGPT Conversations" database under a parent page
func createDatabase(parentPageId: String) async throws -> String // returns database_id

// Create a page (one per conversation) in the target database
func createPage(databaseId: String, title: String, url: String, model: String, date: String) async throws -> String // returns page_id

// Append rich content blocks to a page (batched in groups of 100)
func appendBlocks(pageId: String, blocks: [[String: Any]]) async throws
```

---

## Phase 6: Native Message Handler

**File:** `Notion2GPT Extension/SafariWebExtensionHandler.swift`

The handler dispatches on a `type` field in the incoming message:

| Message Type            | Extension sends                        | Handler responds                                  |
| ----------------------- | -------------------------------------- | ------------------------------------------------- |
| `generate-oauth-url`    | `{}`                                   | `{ url: "https://api.notion.com/..." }`           |
| `poll-oauth-code`       | `{}`                                   | `{ status: "pending" }` or `{ status: "connected", ... }` |
| `check-auth`            | `{}`                                   | `{ authenticated: true/false, workspace: "..." }` |
| `search-databases`      | `{}`                                   | `{ databases: [...] }`                            |
| `create-database`       | `{ parentPageId: "..." }`              | `{ databaseId: "..." }`                           |
| `save-conversation`     | `{ databaseId, title, url, model, messages, blocks }` | `{ pageId: "...", pageUrl: "..." }`  |
| `disconnect`            | `{}`                                   | `{ success: true }` (clears Keychain)             |

**Important**: `SafariWebExtensionHandler` is instantiated per-message (stateless). All state lives in Keychain (via `KeychainHelper`).

---

## Phase 7: HTML → Notion Blocks Converter

**New file:** `Notion2GPT Extension/Resources/html-to-notion.js`

This runs in the extension JS layer — it converts scraped HTML into Notion block JSON structures. No secrets involved.

### Block Mapping

| HTML Element        | Notion Block             |
| ------------------- | ------------------------ |
| `<h1>`              | `heading_1`              |
| `<h2>`              | `heading_2`              |
| `<h3>`              | `heading_3`              |
| `<p>`               | `paragraph`              |
| `<pre><code>`       | `code` (with language)   |
| `<ul>`              | `bulleted_list_item`     |
| `<ol>`              | `numbered_list_item`     |
| `<blockquote>`      | `quote`                  |
| `<table>`           | `table` + `table_row`    |
| Inline `<code>`     | rich text `code: true`   |
| `<strong>`          | rich text `bold: true`   |
| `<em>`              | rich text `italic: true` |

### Enforced Limits

| Limit                                  | Value | Handling                                      |
| -------------------------------------- | ----- | --------------------------------------------- |
| Rich text content per text object      | 2000  | Auto-split into multiple text objects          |
| Blocks per append request              | 100   | Chunk block array, sequential API calls        |
| Nesting depth per append request       | 2     | Flatten deeply nested structures               |
| Max payload size                       | ~1MB  | Monitor serialized JSON size, split if needed  |

---

## Phase 8: Popup UI

**Files:** `popup.html`, `popup.js`, `popup.css`

### States

```
                    ┌─────────────────┐
                    │  Not Connected  │
                    │ "Connect to     │
                    │  Notion" button │
                    └────────┬────────┘
                             │ Click
                             ▼
                    ┌─────────────────┐
                    │   Authorizing   │──── Cancel / Timeout ───► Not Connected
                    │  (polling for   │     (120s max)
                    │   callback)     │
                    └────────┬────────┘
                             │ OAuth success
                             ▼
              ┌──────────────────────────────┐
              │          Connected           │
              │  Chat title preview          │
              │  "Save to Notion" button     │◄──────────┐
              │  ⚙ Settings gear             │           │
              └──────┬───────────┬───────────┘           │
                     │           │                       │
              Click Save    Click ⚙                 Reset 2s
                     │           │                       │
                     ▼           ▼                       │
              ┌────────────┐  ┌──────────┐               │
              │  Saving... │  │ Settings │               │
              │  spinner   │  │ DB picker│               │
              │  progress  │  │ Create DB│               │
              └──────┬─────┘  │ Disconn. │               │
                     │        └──────────┘               │
                     ▼                                   │
              ┌────────────┐                             │
              │  ✅ Saved   │─────────────────────────────┘
              │ "Open in   │
              │  Notion"   │
              └────────────┘
```

### Settings View

- **DB Picker**: Dropdown populated via `sendNativeMessage({ type: "search-databases" })`. Selected `database_id` stored in `browser.storage.local` (not a secret — just a preference)
- **Create New DB**: Prompts for a parent page (also from search), then calls native handler to create database
- **Disconnect**: Sends `{ type: "disconnect" }` to native handler, which clears all Keychain entries

### Error States

- OAuth timeout (120s) → "Connection timed out. Try again."
- OAuth state mismatch → "Security check failed. Please try connecting again."
- Notion API errors → User-friendly messages mapped from Notion error codes
- Scraping failure → "Couldn't read this conversation. Make sure you're on a ChatGPT chat page."
- Rate limited → "Notion is busy. Saving will resume automatically."

---

## Phase 9: Host App Updates

**`ViewController.swift`** — Onboarding UI:
1. Extension enable status (already exists)
2. "Connect to Notion" instructions
3. Link to Safari preferences

**`AppDelegate.swift`** — OAuth callback handler:

```swift
func application(_ application: NSApplication, open urls: [URL]) {
    guard let url = urls.first,
          url.scheme == "notion2gpt",
          url.host == "oauth-callback" else { return }

    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    let code = components?.queryItems?.first(where: { $0.name == "code" })?.value
    let state = components?.queryItems?.first(where: { $0.name == "state" })?.value

    if let code, let state {
        Task {
            try await KeychainHelper.shared.saveString(key: "oauth_pending_code", value: code)
            try await KeychainHelper.shared.saveString(key: "oauth_callback_state", value: state)
        }
    }
}
```

---

## Implementation Order

| Step | Files                                                     | Description                                         |
| ---- | --------------------------------------------------------- | --------------------------------------------------- |
| 1    | `manifest.json`                                           | Permissions, matches for chatgpt.com & chat.com     |
| 2    | `content.js`                                              | DOM scraper with tiered selectors + validation      |
| 3    | `KeychainHelper.swift` (new)                              | Actor-based, App Group–aware Keychain wrapper        |
| 4    | `Info.plist`, `AppDelegate.swift`                         | URL scheme registration + OAuth callback capture     |
| 5    | `NotionAPIClient.swift` (new)                             | All Notion HTTP calls, token refresh, rate limiting  |
| 6    | `SafariWebExtensionHandler.swift`                         | Message dispatch, OAuth flow, bridges to API client  |
| 7    | `html-to-notion.js` (new)                                 | HTML → Notion blocks converter with limit handling   |
| 8    | `background.js`                                           | Orchestration: poll OAuth, relay scrape→save         |
| 9    | `popup.html`, `popup.css`, `popup.js`                     | Full popup UI with all states + error handling       |
| 10   | Xcode project config                                      | App Group entitlements for both targets              |
| 11   | Testing & polish                                          | End-to-end flow on chatgpt.com + chat.com            |

---

## Key Risks & Mitigations

| Risk                                     | Mitigation                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **OAuth secret exposure**                | CLIENT_SECRET lives only in compiled Swift, never in JS. Token exchange happens in native code.     |
| **CSRF on OAuth callback**               | Cryptographic `state` parameter generated + validated in Swift. Mismatch rejects the flow.          |
| **Token theft from storage**             | Tokens in macOS Keychain (`kSecAttrAccessibleAfterFirstUnlock`), never in `browser.storage.local`.  |
| **Native messaging direction**           | Extension always initiates via `sendNativeMessage()`. OAuth callback uses poll pattern (1s/120s).   |
| **ChatGPT DOM changes**                  | Tiered fallback selectors (data-attr → ARIA → class). Schema validation before conversion.          |
| **Streaming / partial messages**         | Detect `data-is-streaming` attribute, warn user or wait for completion.                             |
| **Notion rate limiting (429)**           | Exponential backoff with `Retry-After` header, max 3 retries per request.                           |
| **Notion 2000-char text limit**          | Auto-chunk in `html-to-notion.js` converter.                                                        |
| **Notion 100-block append limit**        | Batch appends into sequential 100-block chunks.                                                     |
| **Notion payload size (~1MB)**           | Monitor serialized JSON size, split into multiple appends if needed.                                |
| **Notion API versioning**                | Pin to `2025-09-03` (current latest). Document upgrade path for future versions.                    |
| **App Group misconfiguration**           | Step 10 explicitly configures entitlements; both targets must share `group.com.karatsidhu.Notion2GPT`. |
| **Thread safety in native handler**      | `KeychainHelper` and `NotionAPIClient` use Swift `actor` for isolation.                             |
