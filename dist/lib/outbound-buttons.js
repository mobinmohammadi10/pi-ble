/**
 * Bale outbound button helpers
 * Zones: bale outbound, assistant markup, callback routing
 * Owns assistant-authored bale_button extraction, button action storage, callback handling, and prompt-turn construction
 */
import { randomUUID } from "node:crypto";
import { getBaleActionString as getBaleButtonString, parseBaleActionPayloadRows, parseBaleButtonPayloadRows, replaceBaleButtonFences, replaceTopLevelHtmlComments, } from "./outbound-markup.js";
import { truncateBaleQueueSummary, } from "./queue.js";
const BALE_BUTTON_CALLBACK_PREFIX = "tgbtn";
const BALE_BUTTON_ACTION_TTL_MS = 24 * 60 * 60 * 1000;
function nowMs() {
    return Date.now();
}
function normalizeMarkdownAfterButtonExtraction(markdown) {
    return markdown.replace(/\n{3,}/g, "\n\n").trim();
}
function parseBaleButtonAction(payload) {
    const value = getBaleButtonString(payload, "value");
    const explicitLabel = getBaleButtonString(payload, "label");
    const explicitPrompt = getBaleButtonString(payload, "prompt");
    const label = explicitLabel ?? value ?? explicitPrompt;
    if (payload.disabled !== undefined && typeof payload.disabled !== "boolean") {
        return undefined;
    }
    if (payload.disabled === true) {
        return { text: label ?? "", prompt: "", disabled: true };
    }
    const prompt = explicitPrompt ?? value ?? explicitLabel;
    if (!label || !prompt)
        return undefined;
    const selectedStyle = payload.selected_style;
    return {
        text: label,
        prompt,
        ...(selectedStyle === "success" ||
            selectedStyle === "danger" ||
            selectedStyle === "primary"
            ? { selectedStyle }
            : {}),
    };
}
export function createBaleButtonActionStore(options = {}) {
    const ttlMs = options.ttlMs ?? BALE_BUTTON_ACTION_TTL_MS;
    const actions = new Map();
    const cleanup = (currentTime) => {
        for (const [key, action] of actions) {
            if (currentTime - action.createdAt > ttlMs)
                actions.delete(key);
        }
    };
    return {
        register: (action) => {
            const currentTime = nowMs();
            cleanup(currentTime);
            const key = `${BALE_BUTTON_CALLBACK_PREFIX}:${randomUUID().slice(0, 8)}`;
            actions.set(key, { ...action, createdAt: currentTime });
            return key;
        },
        resolve: (callbackData) => {
            if (!callbackData?.startsWith(`${BALE_BUTTON_CALLBACK_PREFIX}:`)) {
                return undefined;
            }
            const currentTime = nowMs();
            cleanup(currentTime);
            const action = actions.get(callbackData);
            if (!action)
                return undefined;
            actions.delete(callbackData);
            return {
                text: action.text,
                prompt: action.prompt,
                ...(action.disabled ? { disabled: true } : {}),
                ...(action.binding ? { binding: action.binding } : {}),
                ...(action.selectedStyle
                    ? { selectedStyle: action.selectedStyle }
                    : {}),
            };
        },
    };
}
const DEFAULT_BALE_BUTTON_REPLY_MARKDOWN = "☑️ **Choose an option:**";
function escapeBaleRichButtonText(text) {
    return text.replace(/[&<>"'`\\*_\[\]{}$~\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
}
function renderBaleRichButtonRow(row) {
    return `<tg-button-row>${row
        .map((button) => {
        const attributes = button.disabled
            ? 'type="disabled"'
            : `type="callback_data" data="${escapeBaleRichButtonText(button.callback_data)}"`;
        return `<tg-button ${attributes}>${escapeBaleRichButtonText(button.text)}</tg-button>`;
    })
        .join("")}</tg-button-row>`;
}
export function planBaleButtonReply(markdown, deps) {
    const keyboard = [];
    const buildRows = (payloadRows, rich) => {
        const actions = payloadRows.map((row) => row.map(parseBaleButtonAction));
        if (actions.some((row) => row.some((action) => !action)))
            return undefined;
        if (rich &&
            actions.some((row) => {
                const projected = row.map((action) => action.disabled
                    ? { text: action.text || "\u00a0", disabled: {} }
                    : { text: action.text, callback_data: "x".repeat(64) });
                return (row.length > 8 ||
                    renderBaleRichButtonRow(projected).length > 32768);
            }))
            return undefined;
        return actions.map((row) => row.map((action) => action.disabled
            ? { text: action.text || "\u00a0", disabled: {} }
            : {
                text: action.text,
                callback_data: deps.registerAction({
                    ...action,
                    ...(deps.binding ? { binding: deps.binding } : {}),
                }),
            }));
    };
    const withRichButtons = replaceBaleButtonFences(markdown, (payload, closed) => {
        if (!closed)
            return "";
        const payloadRows = parseBaleButtonPayloadRows(payload);
        if (!payloadRows)
            return "";
        const rich = deps.rendering !== "html";
        const rows = buildRows(payloadRows, rich);
        if (!rows)
            return "";
        if (!rich) {
            keyboard.push(...rows);
            return "";
        }
        return `\n${rows.map(renderBaleRichButtonRow).join("\n\n")}\n`;
    });
    const stripped = replaceTopLevelHtmlComments(withRichButtons, (comment) => {
        const command = "bale_button";
        const normalizedContent = comment.content
            .replace(/^\s+/, "")
            .replace(/^!/, "");
        if (!normalizedContent.startsWith(command))
            return comment.raw;
        const payloadRows = parseBaleActionPayloadRows(comment, command);
        if (!payloadRows)
            return "";
        const rows = buildRows(payloadRows, false);
        if (rows)
            keyboard.push(...rows);
        return "";
    });
    const visibleMarkdown = normalizeMarkdownAfterButtonExtraction(stripped);
    return {
        markdown: keyboard.length > 0 && !visibleMarkdown
            ? DEFAULT_BALE_BUTTON_REPLY_MARKDOWN
            : visibleMarkdown,
        ...(keyboard.length > 0
            ? { replyMarkup: { inline_keyboard: keyboard } }
            : {}),
    };
}
export function createBaleButtonReplyPlanner(store) {
    return (markdown) => planBaleButtonReply(markdown, { registerAction: store.register });
}
export function createBaleButtonPromptTurn(options) {
    const prompt = `${options.balePrefix ?? "[bale]"} ${options.action.prompt}`;
    return {
        kind: "prompt",
        chatId: options.chatId,
        ...(options.target ? { target: options.target } : {}),
        replyToMessageId: options.replyToMessageId,
        sourceMessageIds: [options.replyToMessageId],
        queueOrder: options.queueOrder,
        queueLane: "priority",
        laneOrder: options.queueOrder,
        queuedAttachments: [],
        content: [{ type: "text", text: prompt }],
        historyText: options.action.prompt,
        statusSummary: truncateBaleQueueSummary(options.action.text || options.action.prompt),
    };
}
export function markBaleButtonSelected(replyMarkup, callbackData, selectedStyle = "primary") {
    let matched = false;
    const inlineKeyboard = replyMarkup.inline_keyboard.map((row) => row.map((button) => {
        if (button.disabled || button.callback_data !== callbackData)
            return { ...button };
        matched = true;
        return { ...button, style: selectedStyle };
    }));
    return matched ? { inline_keyboard: inlineKeyboard } : undefined;
}
export async function handleBaleButtonCallbackQuery(query, ctx, deps) {
    const action = deps.resolveAction(query.data);
    if (!action) {
        if (query.data?.startsWith(`${BALE_BUTTON_CALLBACK_PREFIX}:`)) {
            await deps.answerCallbackQuery(query.id, "Button action expired");
            return true;
        }
        return false;
    }
    if (action.disabled) {
        await deps.answerCallbackQuery(query.id, "Button action unavailable");
        return true;
    }
    const chatId = query.message?.chat?.id;
    const messageId = query.message?.message_id;
    if (typeof chatId !== "number" || typeof messageId !== "number") {
        await deps.answerCallbackQuery(query.id, "Button action expired");
        return true;
    }
    if (deps.invokeBoundAction) {
        try {
            const viewMode = await deps.invokeBoundAction(query, action, ctx);
            if (viewMode) {
                if (viewMode === "new" && query.data && query.message?.reply_markup) {
                    const selectedMarkup = markBaleButtonSelected(query.message.reply_markup, query.data, action.selectedStyle);
                    if (selectedMarkup && deps.editMessageReplyMarkup) {
                        try {
                            await deps.editMessageReplyMarkup(chatId, messageId, selectedMarkup);
                        }
                        catch {
                            // The action already succeeded; old-surface styling is best-effort.
                        }
                    }
                }
                await deps.answerCallbackQuery(query.id, "Done");
                return true;
            }
        }
        catch (error) {
            await deps.answerCallbackQuery(query.id, "Generative App action failed");
            throw error;
        }
    }
    const enqueued = deps.enqueueButtonPrompt(query, action, ctx);
    if (enqueued === false) {
        await deps.answerCallbackQuery(query.id, "Already queued");
        return true;
    }
    const selectedMarkup = query.data && query.message?.reply_markup
        ? markBaleButtonSelected(query.message.reply_markup, query.data, action.selectedStyle)
        : undefined;
    if (selectedMarkup && deps.editMessageReplyMarkup) {
        await deps.editMessageReplyMarkup(chatId, messageId, selectedMarkup);
    }
    await deps.answerCallbackQuery(query.id, "Queued");
    return true;
}
