// Notion2GPT — ChatGPT DOM Scraper Content Script

// ---------------------------------------------------------------------------
// Tiered selectors — ordered by resilience against DOM changes
// ---------------------------------------------------------------------------

const MESSAGE_SELECTORS = {
  // Tier 1: data-message-author-role attributes (most stable when present)
  tier1: {
    messages: '[data-message-author-role]',
    role: (el) => el.getAttribute('data-message-author-role'),
    content: (el) => el,
  },
  // Tier 2: article elements with conversation-turn test IDs
  // These use the pattern article[data-testid="conversation-turn-N"]
  // Role is determined by looking inside for role markers, not from the testid string
  tier2: {
    messages: 'article[data-testid^="conversation-turn-"]',
    role: (el) => {
      // Look inside the article for role indicators
      const userEl = el.querySelector('[data-message-author-role="user"]');
      if (userEl) return 'user';
      const assistEl = el.querySelector('[data-message-author-role="assistant"]');
      if (assistEl) return 'assistant';
      // Heuristic fallback: assistant turns contain markdown/prose wrappers
      if (el.querySelector('.markdown, .prose, .markdown-body')) return 'assistant';
      // User turns often have a simpler structure
      if (el.querySelector('[data-message-id]')) return 'user';
      return null;
    },
    content: (el) => {
      return el.querySelector('.markdown, .prose, .markdown-body, [data-message-id]') || el;
    },
  },
  // Tier 3: Broader conversation turn containers (class-based, less stable)
  tier3: {
    messages: '[class*="conversation-turn"], [class*="group/conversation-turn"]',
    role: (el) => {
      if (el.querySelector('[data-message-author-role="user"]')) return 'user';
      if (el.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
      if (el.querySelector('.markdown, .prose, .markdown-body')) return 'assistant';
      if (el.querySelector('[data-message-id]')) return 'user';
      return null;
    },
    content: (el) => {
      return el.querySelector('.markdown, .prose, .markdown-body, [data-message-id]') || el;
    },
  },
  // Tier 4: Generic article fallback — any article with a data-testid
  tier4: {
    messages: 'main article[data-testid]',
    role: (el) => {
      if (el.querySelector('[data-message-author-role="user"]')) return 'user';
      if (el.querySelector('[data-message-author-role="assistant"]')) return 'assistant';
      if (el.querySelector('.markdown, .prose, .markdown-body')) return 'assistant';
      return null;
    },
    content: (el) => {
      return el.querySelector('.markdown, .prose, .markdown-body') || el;
    },
  },
};

// ---------------------------------------------------------------------------
// Streaming detection
// ---------------------------------------------------------------------------

function isStreaming() {
  // data-is-streaming attribute
  const streamingAttr = document.querySelector('[data-is-streaming="true"]');
  if (streamingAttr) return true;

  // Animated cursor / typing indicator elements
  const cursor = document.querySelector(
    '.result-streaming, .streaming-cursor, [class*="typing-indicator"]'
  );
  if (cursor) return true;

  // Stop-generating button visible means response is in progress
  const stopBtn = document.querySelector(
    'button[aria-label="Stop generating"], button[data-testid="stop-button"]'
  );
  if (stopBtn && stopBtn.offsetParent !== null) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Model detection
// ---------------------------------------------------------------------------

function detectModel() {
  // Look for common model badge/selector patterns
  const selectors = [
    '[data-testid="model-switcher"] span',
    '[class*="model"] span',
    'button[class*="model"]',
    '[aria-label*="Model"]',
    'span[class*="text-token-text-secondary"]',
  ];

  const modelPatterns = /\b(gpt-4o?|gpt-4\.5|gpt-3\.5|o[134]-(?:mini|preview|pro)?|o[134]|chatgpt-4o|deepresearch)\b/i;

  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      const text = (el.textContent || '').trim();
      const match = text.match(modelPatterns);
      if (match) return match[0];
    }
  }

  // Broader sweep: check all visible short text nodes near the top
  const candidates = document.querySelectorAll(
    'header span, nav span, [class*="thread"] span, main > div > div span'
  );
  for (const el of candidates) {
    const text = (el.textContent || '').trim();
    if (text.length > 30) continue;
    const match = text.match(modelPatterns);
    if (match) return match[0];
  }

  return 'Unknown';
}

// ---------------------------------------------------------------------------
// Message extraction with tiered fallback
// ---------------------------------------------------------------------------

function extractMessages() {
  const tiers = [
    MESSAGE_SELECTORS.tier1, MESSAGE_SELECTORS.tier2,
    MESSAGE_SELECTORS.tier3, MESSAGE_SELECTORS.tier4,
  ];

  for (const tier of tiers) {
    const elements = document.querySelectorAll(tier.messages);
    if (elements.length === 0) continue;

    const messages = [];

    for (const el of elements) {
      const role = tier.role(el);
      if (role !== 'user' && role !== 'assistant') continue;

      const contentEl = tier.content(el);
      const html = (contentEl.innerHTML || '').trim();
      if (!html) continue;

      messages.push({ role, html });
    }

    if (messages.length > 0) return messages;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Wait for DOM readiness (ChatGPT is an SPA — content may not be rendered yet)
// ---------------------------------------------------------------------------

function waitForMessages(timeoutMs = 2000, intervalMs = 200) {
  return new Promise((resolve) => {
    // Try immediately first
    const immediate = extractMessages();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }

    const start = Date.now();
    const timer = setInterval(() => {
      const messages = extractMessages();
      if (messages.length > 0 || Date.now() - start >= timeoutMs) {
        clearInterval(timer);
        resolve(messages);
      }
    }, intervalMs);
  });
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validate(data) {
  if (typeof data.title !== 'string' || data.title.length === 0) {
    return 'Title is missing or empty.';
  }
  if (typeof data.url !== 'string' || !data.url.startsWith('http')) {
    return 'URL is missing or invalid.';
  }
  if (!Array.isArray(data.messages) || data.messages.length === 0) {
    return 'No messages found in this conversation.';
  }
  for (let i = 0; i < data.messages.length; i++) {
    const msg = data.messages[i];
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      return `Message ${i} has invalid role "${msg.role}".`;
    }
    if (typeof msg.html !== 'string' || msg.html.length === 0) {
      return `Message ${i} has empty content.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main scraper
// ---------------------------------------------------------------------------

async function scrapeConversation() {
  // Check for streaming before doing anything
  if (isStreaming()) {
    return {
      error: 'streaming',
      message: 'A response is still being generated. Please wait for it to complete.',
    };
  }

  const messages = await waitForMessages();

  if (messages.length === 0) {
    return {
      error: 'empty',
      message: 'ChatGPT page detected but no conversation messages found. The page may still be loading, or you may be on the home screen.',
    };
  }

  const data = {
    title: document.title || '',
    url: window.location.href,
    model: detectModel(),
    messages,
    scrapedAt: new Date().toISOString(),
  };

  const validationError = validate(data);
  if (validationError) {
    return { error: 'validation', message: validationError };
  }

  return data;
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

browser.runtime.onMessage.addListener((request, _sender, _sendResponse) => {
  if (request.action === 'scrape-conversation') {
    return scrapeConversation();
  }

  if (request.action === 'ping') {
    return Promise.resolve({ status: 'ready' });
  }
});
