const RICH_TEXT_MAX = 2000;

// --- Rich text helpers ---

function splitText(text, maxLen = RICH_TEXT_MAX) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
        chunks.push(text.slice(i, i + maxLen));
        i += maxLen;
    }
    return chunks;
}

function makeTextObject(content, annotations = {}, link = null) {
    if (content.length === 0) return [];

    return splitText(content).map(chunk => {
        const obj = {
            type: "text",
            text: { content: chunk }
        };
        if (link) {
            obj.text.link = { url: link };
        }
        const ann = {};
        if (annotations.bold) ann.bold = true;
        if (annotations.italic) ann.italic = true;
        if (annotations.code) ann.code = true;
        if (annotations.strikethrough) ann.strikethrough = true;
        if (Object.keys(ann).length > 0) {
            obj.annotations = ann;
        }
        return obj;
    });
}

function mergeAnnotations(parent, child) {
    return { ...parent, ...child };
}

function parseInlineRichText(node, annotations = {}) {
    const results = [];

    for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
            const text = child.textContent;
            if (text.length === 0) continue;
            results.push(...makeTextObject(text, annotations));
            continue;
        }

        if (child.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = child.tagName.toLowerCase();
        let newAnnotations = annotations;
        let link = null;

        if (tag === "strong" || tag === "b") {
            newAnnotations = mergeAnnotations(annotations, { bold: true });
        } else if (tag === "em" || tag === "i") {
            newAnnotations = mergeAnnotations(annotations, { italic: true });
        } else if (tag === "code") {
            newAnnotations = mergeAnnotations(annotations, { code: true });
        } else if (tag === "s" || tag === "del") {
            newAnnotations = mergeAnnotations(annotations, { strikethrough: true });
        } else if (tag === "a") {
            link = child.getAttribute("href");
        }

        if (link) {
            const innerTexts = parseInlineRichText(child, newAnnotations);
            for (const t of innerTexts) {
                t.text.link = { url: link };
            }
            results.push(...innerTexts);
        } else {
            results.push(...parseInlineRichText(child, newAnnotations));
        }
    }

    return results;
}

// --- Block builders ---

function headingBlock(level, richText) {
    const key = `heading_${level}`;
    return { type: key, [key]: { rich_text: richText } };
}

function paragraphBlock(richText) {
    return { type: "paragraph", paragraph: { rich_text: richText } };
}

function codeBlock(content, language = "plain text") {
    const richText = splitText(content).map(chunk => ({
        type: "text",
        text: { content: chunk }
    }));
    return { type: "code", code: { rich_text: richText, language } };
}

function listItemBlock(type, richText) {
    return { type, [type]: { rich_text: richText } };
}

function quoteBlock(richText) {
    return { type: "quote", quote: { rich_text: richText } };
}

function dividerBlock() {
    return { type: "divider", divider: {} };
}

function tableBlock(rows) {
    if (rows.length === 0) return [];
    const width = Math.max(...rows.map(r => r.length));
    const tableRows = rows.map(cells => {
        const padded = cells.slice();
        while (padded.length < width) padded.push([]);
        return {
            type: "table_row",
            table_row: { cells: padded }
        };
    });
    return [{
        type: "table",
        table: {
            table_width: width,
            has_column_header: true,
            children: tableRows
        }
    }];
}

// --- Detect code language ---

function detectLanguage(codeElement) {
    if (!codeElement) return "plain text";
    const classes = codeElement.getAttribute("class") || "";
    const match = classes.match(/(?:^|\s)(?:language-|hljs\s+language-)(\S+)/);
    if (match) return match[1];
    return "plain text";
}

// --- Parse table element ---

function parseTable(tableEl) {
    const rows = [];
    for (const tr of tableEl.querySelectorAll("tr")) {
        const cells = [];
        for (const cell of tr.querySelectorAll("th, td")) {
            cells.push(parseInlineRichText(cell));
        }
        rows.push(cells);
    }
    return tableBlock(rows);
}

// --- Parse list items ---

function parseListItems(listEl, type) {
    const blocks = [];
    for (const li of listEl.children) {
        if (li.tagName.toLowerCase() !== "li") continue;

        const richText = [];
        const childBlocks = [];

        for (const child of li.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                const text = child.textContent;
                if (text.trim().length > 0) {
                    richText.push(...makeTextObject(text));
                }
            } else if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toLowerCase();
                if (tag === "ul" || tag === "ol") {
                    const nestedType = tag === "ul" ? "bulleted_list_item" : "numbered_list_item";
                    childBlocks.push(...parseListItems(child, nestedType));
                } else {
                    richText.push(...parseInlineRichText(child));
                }
            }
        }

        const block = listItemBlock(type, richText.length > 0 ? richText : [makeTextObject(" ")[0]]);
        if (childBlocks.length > 0) {
            block[type].children = childBlocks;
        }
        blocks.push(block);
    }
    return blocks;
}

// --- Flatten deeply nested blocks to max 2 levels ---

function flattenBlocks(blocks, currentDepth = 0) {
    const result = [];
    for (const block of blocks) {
        const type = block.type;
        const data = block[type];
        const children = data?.children;

        if (currentDepth >= 2 && children) {
            const { children: _, ...rest } = data;
            result.push({ type, [type]: rest });
            result.push(...flattenBlocks(children, currentDepth));
        } else if (children) {
            const flatChildren = flattenBlocks(children, currentDepth + 1);
            result.push({ type, [type]: { ...data, children: flatChildren } });
        } else {
            result.push(block);
        }
    }
    return result;
}

// --- Main element-to-blocks parser ---

function elementToBlocks(element) {
    const blocks = [];

    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent.trim();
            if (text.length > 0) {
                blocks.push(paragraphBlock(makeTextObject(text)));
            }
            continue;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName.toLowerCase();

        if (tag === "h1") {
            blocks.push(headingBlock(1, parseInlineRichText(node)));
        } else if (tag === "h2") {
            blocks.push(headingBlock(2, parseInlineRichText(node)));
        } else if (tag === "h3") {
            blocks.push(headingBlock(3, parseInlineRichText(node)));
        } else if (tag === "pre") {
            const codeEl = node.querySelector("code");
            const content = (codeEl || node).textContent;
            const language = detectLanguage(codeEl);
            blocks.push(codeBlock(content, language));
        } else if (tag === "p") {
            const richText = parseInlineRichText(node);
            if (richText.length > 0) {
                blocks.push(paragraphBlock(richText));
            }
        } else if (tag === "ul") {
            blocks.push(...parseListItems(node, "bulleted_list_item"));
        } else if (tag === "ol") {
            blocks.push(...parseListItems(node, "numbered_list_item"));
        } else if (tag === "blockquote") {
            blocks.push(quoteBlock(parseInlineRichText(node)));
        } else if (tag === "table") {
            blocks.push(...parseTable(node));
        } else if (tag === "hr") {
            blocks.push(dividerBlock());
        } else if (tag === "div" || tag === "section" || tag === "article" || tag === "span") {
            blocks.push(...elementToBlocks(node));
        } else {
            const richText = parseInlineRichText(node);
            if (richText.length > 0) {
                blocks.push(paragraphBlock(richText));
            }
        }
    }

    return blocks;
}

// --- Public API ---

function htmlToBlocks(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, "text/html");
    const blocks = elementToBlocks(doc.body);
    return flattenBlocks(blocks);
}

function convertConversationToBlocks(messages) {
    const blocks = [];

    for (let i = 0; i < messages.length; i++) {
        const { role, html } = messages[i];
        const label = role === "user" ? "🧑 You" : "🤖 Assistant";

        blocks.push(headingBlock(3, makeTextObject(label)));
        blocks.push(...htmlToBlocks(html));

        if (i < messages.length - 1) {
            blocks.push(dividerBlock());
        }
    }

    return flattenBlocks(blocks);
}

function chunkBlocks(blocks, size = 100) {
    const chunks = [];
    for (let i = 0; i < blocks.length; i += size) {
        chunks.push(blocks.slice(i, i + size));
    }
    return chunks;
}

export { convertConversationToBlocks, chunkBlocks, htmlToBlocks };
