import { convertConversationToBlocks, chunkBlocks } from './html-to-notion.js';

const APP_ID = "com.karatsidhu.Notion2GPT.Extension";
const CALLBACK_URL_PREFIX = "https://sidhuk.github.io/Notion2GPT/callback.html";

let oauthTabId = null;
let pendingOAuthState = null;

async function sendNative(message) {
    try {
        const response = await browser.runtime.sendNativeMessage(APP_ID, message);
        return response;
    } catch (error) {
        console.error("Native messaging error:", error);
        throw error;
    }
}

async function getActiveTab() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
}

async function ensureContentScript(tabId) {
    // First, try pinging — content script may already be injected via manifest
    try {
        const resp = await browser.tabs.sendMessage(tabId, { action: "ping" });
        if (resp?.status === "ready") return true;
    } catch {
        // Content script not loaded — try manual injection
    }
    // Try injecting via scripting API (MV3)
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
        return true;
    } catch {
        // Injection failed — probably not a permitted page
        return false;
    }
}

// Listen for the OAuth callback using webNavigation (more reliable in Safari than tabs.onUpdated)
browser.webNavigation.onCompleted.addListener(async (details) => {
    if (details.tabId !== oauthTabId) return;
    if (!details.url || !details.url.startsWith(CALLBACK_URL_PREFIX)) return;

    const url = new URL(details.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Close the callback tab
    try { await browser.tabs.remove(details.tabId); } catch {}
    oauthTabId = null;

    if (error) {
        pendingOAuthState = null;
        globalThis._oauthResult = { status: "error", reason: error };
        return;
    }

    if (!code || !state) {
        pendingOAuthState = null;
        globalThis._oauthResult = { status: "error", reason: "Missing code or state in callback" };
        return;
    }

    if (state !== pendingOAuthState) {
        pendingOAuthState = null;
        globalThis._oauthResult = { status: "error", reason: "state_mismatch" };
        return;
    }

    pendingOAuthState = null;

    // Exchange the code for tokens via native handler
    try {
        const result = await sendNative({ type: "exchange-code", code, state });
        globalThis._oauthResult = result;
    } catch (err) {
        globalThis._oauthResult = { status: "error", reason: err.message || "Token exchange failed" };
    }
});

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start-oauth") {
        return (async () => {
            globalThis._oauthResult = null;
            const response = await sendNative({ type: "generate-oauth-url" });
            pendingOAuthState = response.state;
            const tab = await browser.tabs.create({ url: response.url });
            oauthTabId = tab.id;
            return { status: "polling" };
        })();
    }

    if (request.action === "poll-oauth") {
        const result = globalThis._oauthResult;
        if (result) {
            return Promise.resolve(result);
        }
        return Promise.resolve({ status: "pending" });
    }

    if (request.action === "check-auth") {
        return sendNative({ type: "check-auth" });
    }

    if (request.action === "search-databases") {
        return sendNative({ type: "search-databases" });
    }

    if (request.action === "create-database") {
        return sendNative({ type: "create-database", parentPageId: request.parentPageId });
    }

    if (request.action === "save-conversation") {
        return (async () => {
            const tab = await getActiveTab();
            if (!tab?.id || !await ensureContentScript(tab.id)) {
                return { error: "Not on a ChatGPT page." };
            }
            const scraped = await browser.tabs.sendMessage(tab.id, { action: "scrape-conversation" });

            if (scraped.error) {
                return { error: scraped.error };
            }

            const blocks = convertConversationToBlocks(scraped.messages);

            return sendNative({
                type: "save-conversation",
                databaseId: request.databaseId,
                title: scraped.title,
                url: scraped.url,
                model: scraped.model,
                blocks: blocks
            });
        })();
    }

    if (request.action === "disconnect") {
        return (async () => {
            await sendNative({ type: "disconnect" });
            await browser.storage.local.clear();
            return { success: true };
        })();
    }

    if (request.action === "scrape-current-tab") {
        return (async () => {
            try {
                const tab = await getActiveTab();
                if (!tab?.id) {
                    return { error: "no_tab", message: "No active tab found." };
                }
                // Check if the tab is on a ChatGPT domain
                const tabUrl = tab.url || "";
                const isChatGPT = /^https?:\/\/(chatgpt\.com|chat\.com|chat\.openai\.com)\//i.test(tabUrl);
                if (!isChatGPT) {
                    return { error: "not_chatgpt", message: "Navigate to a ChatGPT conversation to save it." };
                }
                // Try sending directly — content script should be auto-injected by manifest
                try {
                    const scraped = await browser.tabs.sendMessage(tab.id, { action: "scrape-conversation" });
                    return scraped;
                } catch (sendErr) {
                    // Content script not injected — try manual injection
                    try {
                        await ensureContentScript(tab.id);
                        const scraped = await browser.tabs.sendMessage(tab.id, { action: "scrape-conversation" });
                        return scraped;
                    } catch (injectErr) {
                        return { error: "inject_failed", message: "Could not reach content script: " + (injectErr.message || sendErr.message) };
                    }
                }
            } catch (err) {
                return { error: "scrape_error", message: err.message || "Unknown error" };
            }
        })();
    }
});
