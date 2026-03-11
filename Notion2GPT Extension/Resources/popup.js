const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 120_000;

const $ = (id) => document.getElementById(id);

const els = {
    btnConnect: $("btn-connect"),
    btnCancelAuth: $("btn-cancel-auth"),
    btnSave: $("btn-save"),
    btnSettings: $("btn-settings"),
    btnBack: $("btn-back"),
    btnCreateDb: $("btn-create-db"),
    btnDisconnect: $("btn-disconnect"),
    btnRetry: $("btn-retry"),
    linkOpenNotion: $("link-open-notion"),
    chatTitle: $("chat-title"),
    chatModel: $("chat-model"),
    chatMessages: $("chat-messages"),
    errorMessage: $("error-message"),
    selectDatabase: $("select-database"),
};

let pollTimer = null;
let pollStartTime = null;
let lastScrapeData = null;

// --- State management ---

function showState(stateId) {
    document.querySelectorAll(".state").forEach((el) => el.classList.add("hidden"));
    $(stateId)?.classList.remove("hidden");
}

function setError(message) {
    els.errorMessage.textContent = message;
    showState("state-error");
}

// --- Messaging ---

function sendMessage(msg) {
    return browser.runtime.sendMessage(msg);
}

// --- Initialization ---

async function init() {
    showState("state-loading");

    try {
        const auth = await sendMessage({ action: "check-auth" });

        if (!auth || !auth.authenticated) {
            showState("state-not-connected");
            return;
        }

        await loadPreview();
    } catch {
        showState("state-not-connected");
    }
}

// --- Preview / Scrape ---

async function loadPreview() {
    try {
        const data = await sendMessage({ action: "scrape-current-tab" });

        if (!data) {
            showState("state-wrong-page");
            return;
        }

        if (data.error) {
            if (data.error === "not_chatgpt" || data.error === "no_tab" || data.error === "inject_failed") {
                showState("state-wrong-page");
            } else if (data.error === "empty") {
                setError(data.message || "No conversation found. Open a ChatGPT chat first.");
            } else if (data.error === "streaming") {
                setError(data.message || "Response is still generating. Please wait.");
            } else {
                setError(data.message || data.error);
            }
            return;
        }

        lastScrapeData = data;
        els.chatTitle.textContent = data.title || "Untitled Chat";
        els.chatModel.textContent = data.model || "ChatGPT";
        els.chatMessages.textContent =
            `${data.messages?.length ?? 0} messages`;

        showState("state-ready");
    } catch (err) {
        setError("Scrape failed: " + (err.message || "unknown error"));
    }
}

// --- OAuth polling ---

function startPolling() {
    stopPolling();
    pollStartTime = Date.now();

    pollTimer = setInterval(async () => {
        if (Date.now() - pollStartTime > POLL_TIMEOUT_MS) {
            stopPolling();
            setError("Authorization timed out. Please try again.");
            return;
        }

        try {
            const result = await sendMessage({ action: "poll-oauth" });

            if (result?.status === "connected" || result?.authenticated) {
                stopPolling();
                await loadPreview();
            } else if (result?.status === "error" || result?.error) {
                stopPolling();
                setError(result.error || "Authorization failed.");
            }
        } catch {
            stopPolling();
            setError("Lost connection to extension. Please try again.");
        }
    }, POLL_INTERVAL_MS);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
    pollStartTime = null;
}

// --- Save flow ---

async function handleSave() {
    const stored = await browser.storage.local.get("databaseId");

    if (!stored.databaseId) {
        await loadSettings("Select a database first.");
        return;
    }

    showState("state-saving");

    try {
        const result = await sendMessage({
            action: "save-conversation",
            databaseId: stored.databaseId,
        });

        if (result?.error) {
            setError(result.error);
            return;
        }

        if (result?.url) {
            els.linkOpenNotion.href = result.url;
        }

        showState("state-saved");
    } catch (err) {
        setError(err.message || "Failed to save conversation.");
    }
}

// --- Settings ---

async function loadSettings(notice) {
    showState("state-settings");

    els.selectDatabase.innerHTML =
        '<option value="" disabled selected>Loading databases…</option>';

    try {
        const result = await sendMessage({ action: "search-databases" });
        const databases = result?.databases || [];
        const stored = await browser.storage.local.get("databaseId");

        els.selectDatabase.innerHTML = "";

        if (databases.length === 0) {
            els.selectDatabase.innerHTML =
                '<option value="" disabled selected>No databases found</option>';
        } else {
            if (notice) {
                const noticeOpt = document.createElement("option");
                noticeOpt.value = "";
                noticeOpt.disabled = true;
                noticeOpt.selected = true;
                noticeOpt.textContent = notice;
                els.selectDatabase.appendChild(noticeOpt);
            }

            databases.forEach((db) => {
                const opt = document.createElement("option");
                opt.value = db.id;
                opt.textContent = db.title || "Untitled";
                if (db.id === stored.databaseId && !notice) {
                    opt.selected = true;
                }
                els.selectDatabase.appendChild(opt);
            });
        }
    } catch {
        els.selectDatabase.innerHTML =
            '<option value="" disabled selected>Failed to load databases</option>';
    }
}

async function handleCreateDatabase() {
    if (!confirm("Create a new \"ChatGPT Saves\" database in Notion?")) {
        return;
    }

    els.btnCreateDb.disabled = true;
    els.btnCreateDb.textContent = "Creating…";

    try {
        const searchResult = await sendMessage({ action: "search-databases" });
        const parentPageId = searchResult?.pages?.[0]?.id;

        const result = await sendMessage({
            action: "create-database",
            parentPageId: parentPageId || undefined,
        });

        if (result?.error) {
            setError(result.error);
            return;
        }

        if (result?.databaseId) {
            await browser.storage.local.set({ databaseId: result.databaseId });
        }

        await loadSettings();
    } catch (err) {
        setError(err.message || "Failed to create database.");
    } finally {
        els.btnCreateDb.disabled = false;
        els.btnCreateDb.textContent = "Create New Database";
    }
}

async function handleDisconnect() {
    if (!confirm("Disconnect from Notion?")) {
        return;
    }

    try {
        await sendMessage({ action: "disconnect" });
        showState("state-not-connected");
    } catch {
        setError("Failed to disconnect.");
    }
}

// --- Event listeners ---

els.btnConnect.addEventListener("click", async () => {
    showState("state-authorizing");

    try {
        await sendMessage({ action: "start-oauth" });
        startPolling();
    } catch {
        setError("Failed to start authorization.");
    }
});

els.btnCancelAuth.addEventListener("click", () => {
    stopPolling();
    showState("state-not-connected");
});

els.btnSave.addEventListener("click", handleSave);

els.btnSettings.addEventListener("click", () => loadSettings());

els.btnBack.addEventListener("click", () => loadPreview());

els.selectDatabase.addEventListener("change", (e) => {
    if (e.target.value) {
        browser.storage.local.set({ databaseId: e.target.value });
    }
});

els.btnCreateDb.addEventListener("click", handleCreateDatabase);

els.btnDisconnect.addEventListener("click", handleDisconnect);

els.btnRetry.addEventListener("click", init);

// --- Start ---

init();
