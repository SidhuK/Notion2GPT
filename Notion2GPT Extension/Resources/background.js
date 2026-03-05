import { convertConversationToBlocks, chunkBlocks } from './html-to-notion.js';

const APP_ID = "com.karatsidhu.Notion2GPT.Extension";

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

browser.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "start-oauth") {
        return (async () => {
            const response = await sendNative({ type: "generate-oauth-url" });
            await browser.tabs.create({ url: response.url });
            return { status: "polling" };
        })();
    }

    if (request.action === "poll-oauth") {
        return sendNative({ type: "poll-oauth-code" });
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
            const tab = await getActiveTab();
            const scraped = await browser.tabs.sendMessage(tab.id, { action: "scrape-conversation" });
            return scraped;
        })();
    }
});
