/**
 * Bale reply delivery helpers
 * Zones: bale outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, guest placeholder rotation, reply transport wiring, and plain text replies
 */
import { assertBaleInlineKeyboardCallbackData } from "./keyboard.js";
import { renderBaleMessage, } from "./rendering.js";
import { getBaleTargetThreadParams, } from "./target.js";
import { assertBaleApiCallAuthority, isBaleApiCommitUnknownError, BaleApiAuthorityError, } from "./bale-api.js";
export { renderBaleMessage, };
export function renderBaleMarkdownToHtmlDraft(markdown) {
    return renderBaleMessage(markdown, { mode: "markdown" })
        .map((chunk) => chunk.text)
        .join("\n");
}
export const BALE_RICH_MESSAGE_MAX_CHARS = 32768;
export const BALE_RICH_MESSAGE_MAX_BLOCKS = 500;
const lastRepliedToMessageIdByTarget = new Map();
const replyDedupPreservedOnNextReset = new Map();
let replyDedupGeneration = 0;
function getReplyDedupTargetKey(chatId, target) {
    const threadId = target?.threadId;
    return typeof threadId === "number"
        ? `${chatId}:thread:${threadId}`
        : `${chatId}:private`;
}
export function resetTransportReplyDedup() {
    replyDedupGeneration += 1;
    lastRepliedToMessageIdByTarget.clear();
    for (const [key, messageId] of replyDedupPreservedOnNextReset) {
        lastRepliedToMessageIdByTarget.set(key, messageId);
    }
    replyDedupPreservedOnNextReset.clear();
}
/** Keeps a successfully published transition notice as the first reply of the
 * next agent turn. The following agent-start reset consumes this one-shot
 * preservation, so later messages in that turn do not repeat the reply header. */
export function preserveTransportReplyDedupOnNextReset(chatId, messageId, target) {
    const key = getReplyDedupTargetKey(chatId, target);
    if (lastRepliedToMessageIdByTarget.get(key) !== messageId)
        return;
    replyDedupPreservedOnNextReset.set(key, messageId);
}
export function buildBaleReplyParameters(chatId, messageId, target) {
    if (messageId === undefined || messageId <= 0)
        return undefined;
    const key = getReplyDedupTargetKey(chatId, target);
    if (lastRepliedToMessageIdByTarget.get(key) === messageId) {
        return undefined;
    }
    lastRepliedToMessageIdByTarget.set(key, messageId);
    return {
        message_id: messageId,
        allow_sending_without_reply: true,
    };
}
// Answer publications are caller-serialized. A rejected send releases its anchor;
// an uncertain ACK retains it because Bale may already have delivered it.
export async function withBaleReplyParameters(chatId, messageId, target, send) {
    const key = getReplyDedupTargetKey(chatId, target);
    const generation = replyDedupGeneration;
    const previous = lastRepliedToMessageIdByTarget.get(key);
    const parameters = buildBaleReplyParameters(chatId, messageId, target);
    try {
        return await send(parameters);
    }
    catch (error) {
        if (parameters &&
            !isBaleApiCommitUnknownError(error) &&
            !(error instanceof BaleApiAuthorityError && error.requestIssued) &&
            generation === replyDedupGeneration &&
            lastRepliedToMessageIdByTarget.get(key) === messageId) {
            if (previous === undefined)
                lastRepliedToMessageIdByTarget.delete(key);
            else
                lastRepliedToMessageIdByTarget.set(key, previous);
        }
        throw error;
    }
}
function getAgentMessageField(message, field) {
    if (typeof message !== "object" || message === null || !(field in message)) {
        return undefined;
    }
    return Reflect.get(message, field);
}
export function isAssistantAgentMessage(message) {
    return getAgentMessageField(message, "role") === "assistant";
}
function extractAgentTextContent(content) {
    const blocks = Array.isArray(content) ? content : [];
    return blocks
        .filter((block) => typeof block === "object" && block !== null && "type" in block)
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("")
        .trim();
}
export function getAgentMessageText(message) {
    return extractAgentTextContent(getAgentMessageField(message, "content"));
}
export function extractLatestAssistantMessageText(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || !isAssistantAgentMessage(message))
            continue;
        const rawStopReason = getAgentMessageField(message, "stopReason");
        const rawErrorMessage = getAgentMessageField(message, "errorMessage");
        const stopReason = typeof rawStopReason === "string" ? rawStopReason : undefined;
        const errorMessage = typeof rawErrorMessage === "string" ? rawErrorMessage : undefined;
        const text = getAgentMessageText(message);
        return { text: text || undefined, stopReason, errorMessage };
    }
    return {};
}
/**
 * Extract the run's answer without trusting an empty final assistant message.
 * A low-level run may end with a completed assistant message whose content was
 * suppressed (a companion extension preserving an earlier draft, for example
 * State Flow's fallback final:true patch turn). In that case the run's answer
 * is the latest earlier completed assistant message that carries text;
 * tool-use prefaces, errors, and aborts stay excluded.
 */
export function extractRunAssistantMessage(messages) {
    const latest = extractLatestAssistantMessageText(messages);
    if (latest.text || latest.stopReason !== "stop")
        return latest;
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (!message || !isAssistantAgentMessage(message))
            continue;
        const rawStopReason = getAgentMessageField(message, "stopReason");
        if (rawStopReason === "toolUse" ||
            rawStopReason === "error" ||
            rawStopReason === "aborted") {
            continue;
        }
        const text = getAgentMessageText(message);
        if (!text)
            continue;
        const rawErrorMessage = getAgentMessageField(message, "errorMessage");
        return {
            text,
            stopReason: typeof rawStopReason === "string" ? rawStopReason : undefined,
            errorMessage: typeof rawErrorMessage === "string" ? rawErrorMessage : undefined,
            recoveredFromEarlier: true,
        };
    }
    return latest;
}
export function buildBaleReplyTransport(deps) {
    return {
        sendRenderedChunks: async (chatId, chunks, options) => {
            return sendBaleRenderedChunks(chatId, chunks, deps, options);
        },
        editRenderedMessage: async (chatId, messageId, chunks, options) => {
            return editBaleRenderedMessage(chatId, messageId, chunks, deps, options);
        },
    };
}
export async function sendBaleRenderedChunks(chatId, chunks, deps, options) {
    return sendBaleChunkSequence(chatId, chunks, options?.replyToMessageId, options, deps.recordOwnership, (chunk, fields, callOptions) => deps.sendMessage({
        chat_id: chatId,
        text: chunk.text,
        parse_mode: chunk.parseMode,
        ...fields,
    }, callOptions));
}
/**
 * Ordered chunk delivery: only the first chunk replies, only the last carries markup, and authority is rechecked
 * before issuance and after every response/ownership publication.
 */
async function sendBaleChunkSequence(chatId, chunks, replyToMessageId, options, recordOwnership, send) {
    const target = options?.target && { ...options.target }, assertAuthority = options?.assertAuthority, replyMarkup = options?.replyMarkup;
    assertBaleInlineKeyboardCallbackData(replyMarkup);
    let lastMessageId;
    for (const [index, chunk] of chunks.entries()) {
        assertBaleApiCallAuthority(assertAuthority, false);
        const sent = await withBaleReplyParameters(chatId, index === 0 ? replyToMessageId : undefined, target, async (replyParameters) => {
            const sent = await send(chunk, {
                reply_markup: index === chunks.length - 1 ? replyMarkup : undefined,
                ...(replyParameters ? { reply_parameters: replyParameters } : {}),
                ...(target ? getBaleTargetThreadParams(target) : {}),
            }, assertAuthority ? { assertAuthority } : undefined);
            assertBaleApiCallAuthority(assertAuthority, true);
            return sent;
        });
        assertBaleApiCallAuthority(assertAuthority, true);
        lastMessageId = sent.message_id;
        recordOwnership?.({ chatId, messageId: sent.message_id, target });
        assertBaleApiCallAuthority(assertAuthority, true);
    }
    return lastMessageId;
}
export async function editBaleRenderedMessage(chatId, messageId, chunks, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const assertAuthority = options.assertAuthority;
    assertBaleApiCallAuthority(assertAuthority, false);
    assertBaleInlineKeyboardCallbackData(options?.replyMarkup);
    if (chunks.length === 0)
        return messageId;
    const [firstChunk, ...remainingChunks] = chunks;
    if (!assertAuthority)
        deps.recordOwnership?.({ chatId, messageId, target: options.target });
    await deps.editMessage({
        chat_id: chatId,
        message_id: messageId,
        text: firstChunk.text,
        parse_mode: firstChunk.parseMode,
        reply_markup: remainingChunks.length === 0 ? options?.replyMarkup : undefined,
        ...(options?.target ? getBaleTargetThreadParams(options.target) : {}),
    }, assertAuthority ? { assertAuthority } : undefined);
    assertBaleApiCallAuthority(assertAuthority, true);
    if (assertAuthority)
        deps.recordOwnership?.({ chatId, messageId, target: options.target });
    assertBaleApiCallAuthority(assertAuthority, true);
    if (remainingChunks.length > 0) {
        return sendBaleRenderedChunks(chatId, remainingChunks, deps, {
            replyMarkup: options?.replyMarkup,
            target: options?.target,
            assertAuthority,
        });
    }
    return messageId;
}
export async function sendBalePlainReply(text, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const chunks = deps.renderBaleMessage(text, {
        mode: options?.parseMode === "HTML" ? "html" : "plain",
    });
    return deps.sendRenderedChunks(chunks, {
        target: options?.target,
        replyToMessageId: options?.replyToMessageId,
        assertAuthority: options.assertAuthority,
    });
}
function normalizeIndentedBaleNativeMarkdownList(line) {
    return line.replace(/^( +|\t+)([-*+] |\d+\. )/, (_match, indent, marker) => {
        const visibleIndent = indent
            .replace(/ /g, "\u00A0")
            .replace(/\t/g, "\u00A0\u00A0");
        return `${visibleIndent}${marker}`;
    });
}
function normalizeBaleNativeMarkdownLine(line) {
    let result = normalizeIndentedBaleNativeMarkdownList(line.replace(/^( {0,3}>)[ \t]/, "$1"));
    const codeSpans = [];
    result = result.replace(/`+[^`]*`+/g, (code) => {
        const token = `\u0000${codeSpans.length}\u0000`;
        codeSpans.push(code);
        return token;
    });
    result = result.replace(/(^|[^\\$])\$([A-Z][A-Z0-9]{1,})(?!\$)(?=\b|[.,;:)/-])/g, (_match, prefix, ticker) => `${prefix}\\$${ticker}`);
    return result.replace(/\u0000(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)] ?? "");
}
export function parseBaleMarkdownFenceOpening(line) {
    const markerText = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    return markerText
        ? { marker: markerText[0], length: markerText.length }
        : undefined;
}
export function isBaleMarkdownFenceClosing(line, fence) {
    return new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`).test(line);
}
/** Fence state after one line: outside a fence a marker opens one; inside, a matching marker closes it. */
function advanceBaleMarkdownFence(fence, line) {
    if (!fence)
        return parseBaleMarkdownFenceOpening(line);
    return isBaleMarkdownFenceClosing(line, fence) ? undefined : fence;
}
function hasClosingDisplayMathDelimiter(lines, startIndex) {
    let fence;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!fence && line.trim() === "$$")
            return true;
        fence = advanceBaleMarkdownFence(fence, line);
    }
    return false;
}
export function normalizeBaleNativeMarkdown(markdown) {
    const lines = markdown.replace(/\r\n/g, "\n").split("\n");
    let fence;
    let displayMath = false;
    return lines
        .map((line, index) => {
        const inFence = fence !== undefined;
        if (!inFence && line.trim() === "$$") {
            if (displayMath) {
                displayMath = false;
                return "```";
            }
            if (hasClosingDisplayMathDelimiter(lines, index)) {
                displayMath = true;
                return "```math";
            }
        }
        if (displayMath)
            return line;
        const nextFence = advanceBaleMarkdownFence(fence, line);
        if (nextFence !== fence) {
            fence = nextFence;
            return line;
        }
        if (!inFence)
            return normalizeBaleNativeMarkdownLine(line);
        return line;
    })
        .join("\n");
}
export function splitBaleNativeMarkdown(markdown) {
    const normalizedMarkdown = normalizeBaleNativeMarkdown(markdown);
    if (normalizedMarkdown.length <= BALE_RICH_MESSAGE_MAX_CHARS &&
        countBaleNativeMarkdownBlocks(normalizedMarkdown) <=
            BALE_RICH_MESSAGE_MAX_BLOCKS) {
        return [normalizedMarkdown];
    }
    const chunks = [];
    let current = "";
    let currentBlockCount = 0;
    for (const rawBlock of splitBaleNativeMarkdownBlocks(normalizedMarkdown)) {
        for (const block of splitBaleNativeMarkdownCountedBlocks(rawBlock)) {
            const blockCount = countBaleNativeMarkdownBlocks(block);
            const candidate = current ? `${current}\n\n${block}` : block;
            const exceedsChars = candidate.length > BALE_RICH_MESSAGE_MAX_CHARS;
            const exceedsBlocks = currentBlockCount + blockCount > BALE_RICH_MESSAGE_MAX_BLOCKS;
            if (!exceedsChars && !exceedsBlocks) {
                current = candidate;
                currentBlockCount += blockCount;
                continue;
            }
            if (current)
                chunks.push(current.trimEnd());
            if (block.length <= BALE_RICH_MESSAGE_MAX_CHARS &&
                blockCount <= BALE_RICH_MESSAGE_MAX_BLOCKS) {
                current = block;
                currentBlockCount = blockCount;
                continue;
            }
            chunks.push(...splitBaleNativeMarkdownLongBlock(block));
            current = "";
            currentBlockCount = 0;
        }
    }
    if (current)
        chunks.push(current.trimEnd());
    return chunks;
}
function splitBaleNativeMarkdownBlocks(markdown) {
    const blocks = [];
    const current = [];
    let fence;
    const flush = () => {
        if (current.length === 0)
            return;
        blocks.push(current.join("\n"));
        current.length = 0;
    };
    for (const line of markdown.split("\n")) {
        if (!fence && line.trim().length === 0) {
            flush();
            continue;
        }
        current.push(line);
        fence = advanceBaleMarkdownFence(fence, line);
    }
    flush();
    return blocks;
}
function splitBaleNativeMarkdownCountedBlocks(block) {
    if (countBaleNativeMarkdownBlocks(block) <= BALE_RICH_MESSAGE_MAX_BLOCKS) {
        return [block];
    }
    const chunks = [];
    let current = [];
    let fence;
    for (const line of block.split("\n")) {
        if (!fence && current.length >= BALE_RICH_MESSAGE_MAX_BLOCKS) {
            chunks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
        fence = advanceBaleMarkdownFence(fence, line);
    }
    if (current.length > 0)
        chunks.push(current.join("\n"));
    return chunks;
}
function countBaleNativeMarkdownBlocks(block) {
    if (/^ {0,3}(`{3,}|~{3,})/.test(block))
        return 1;
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.some((line) => /^\s*([-*+] |\d+\. |>|\||<tg-button-row>)/.test(line))) {
        return Math.max(1, lines.length);
    }
    return 1;
}
function splitBaleNativeMarkdownLongBlock(block) {
    return (splitBaleNativeMarkdownLongFenceBlock(block) ??
        splitBaleNativeMarkdownLongWrappedInlineBlock(block) ??
        splitBaleNativeMarkdownLongPlainBlock(block));
}
function splitBaleNativeMarkdownLongPlainBlock(block) {
    const chunks = [];
    let remaining = block;
    while (remaining.length > BALE_RICH_MESSAGE_MAX_CHARS) {
        const window = remaining.slice(0, BALE_RICH_MESSAGE_MAX_CHARS + 1);
        const splitIndex = findBaleNativeMarkdownSplitIndex(window);
        chunks.push(remaining.slice(0, splitIndex).trimEnd());
        remaining = remaining.slice(splitIndex).trimStart();
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
function splitBaleNativeMarkdownLongFenceBlock(block) {
    const lines = block.split("\n");
    const opening = lines[0] ?? "";
    const closing = lines[lines.length - 1] ?? "";
    const openingFence = parseBaleMarkdownFenceOpening(opening);
    if (!openingFence || !closing || lines.length < 2)
        return undefined;
    if (!isBaleMarkdownFenceClosing(closing, openingFence)) {
        return undefined;
    }
    const maxContentLength = BALE_RICH_MESSAGE_MAX_CHARS - opening.length - closing.length - 2;
    if (maxContentLength <= 0)
        return undefined;
    const content = lines.slice(1, -1).join("\n");
    return splitBaleNativeMarkdownWrappedContent(content, maxContentLength, (chunk) => `${opening}\n${chunk}${chunk.endsWith("\n") ? "" : "\n"}${closing}`);
}
function splitBaleNativeMarkdownLongWrappedInlineBlock(block) {
    const delimiter = ["**", "__", "~~", "`", "*", "_"].find((candidate) => block.startsWith(candidate) &&
        block.endsWith(candidate) &&
        block.length > candidate.length * 2);
    if (!delimiter)
        return undefined;
    const maxContentLength = BALE_RICH_MESSAGE_MAX_CHARS - delimiter.length * 2;
    if (maxContentLength <= 0)
        return undefined;
    return splitBaleNativeMarkdownWrappedContent(block.slice(delimiter.length, -delimiter.length), maxContentLength, (chunk) => `${delimiter}${chunk}${delimiter}`);
}
function splitBaleNativeMarkdownWrappedContent(content, maxContentLength, wrap) {
    const chunks = [];
    let remaining = content;
    while (remaining.length > maxContentLength) {
        const window = remaining.slice(0, maxContentLength + 1);
        const splitIndex = findBaleNativeMarkdownSplitIndex(window, maxContentLength);
        chunks.push(wrap(remaining.slice(0, splitIndex)));
        remaining = remaining.slice(splitIndex);
    }
    if (remaining.length > 0)
        chunks.push(wrap(remaining));
    return chunks;
}
function findBaleNativeMarkdownSplitIndex(text, hardLimit = BALE_RICH_MESSAGE_MAX_CHARS) {
    const paragraphIndex = text.lastIndexOf("\n\n", hardLimit);
    if (paragraphIndex > 0)
        return paragraphIndex + 2;
    const lineIndex = text.lastIndexOf("\n", hardLimit);
    if (lineIndex > 0)
        return lineIndex + 1;
    const spaceIndex = text.lastIndexOf(" ", hardLimit);
    if (spaceIndex > 0)
        return spaceIndex + 1;
    return hardLimit;
}
export async function sendBaleNativeMarkdownReply(chatId, replyToMessageId, markdown, deps, options) {
    return sendBaleChunkSequence(chatId, splitBaleNativeMarkdown(markdown), replyToMessageId, options, deps.recordOwnership, (chunk, fields, callOptions) => deps.sendRichMessage({ chat_id: chatId, rich_message: { markdown: chunk }, ...fields }, callOptions));
}
async function sendBaleNativeRichMessage(chatId, richMessage, deps, options) {
    options = { ...options, target: options?.target && { ...options.target } };
    const assertAuthority = options.assertAuthority;
    assertBaleApiCallAuthority(assertAuthority, false);
    const sent = await deps.sendRichMessage({
        chat_id: chatId,
        rich_message: richMessage,
        ...(options?.target ? getBaleTargetThreadParams(options.target) : {}),
    }, assertAuthority ? { assertAuthority } : undefined);
    assertBaleApiCallAuthority(assertAuthority, true);
    deps.recordOwnership?.({
        chatId,
        messageId: sent.message_id,
        target: options?.target,
    });
    assertBaleApiCallAuthority(assertAuthority, true);
    return sent.message_id;
}
export function createBaleRenderedMessageDeliveryRuntime(deps) {
    const replyTransport = buildBaleReplyTransport({
        recordOwnership: deps.recordOwnership,
        sendMessage: deps.sendMessage,
        editMessage: deps.editMessage,
    });
    return {
        replyTransport,
        ...createBaleRenderedMessageRuntime({
            renderBaleMessage: deps.renderBaleMessage ?? renderBaleMessage,
            replyTransport,
            recordOwnership: deps.recordOwnership,
            getAssistantRenderingMode: deps.getAssistantRenderingMode,
            sendRichMessage: deps.sendRichMessage,
        }),
    };
}
export function createBaleRenderedMessageRuntime(deps) {
    return {
        sendTextReply: async (chatId, replyToMessageId, text, options) => {
            return sendBalePlainReply(text, {
                renderBaleMessage: deps.renderBaleMessage,
                sendRenderedChunks: (chunks, chunkOptions) => deps.replyTransport.sendRenderedChunks(chatId, chunks, {
                    target: chunkOptions?.target,
                    assertAuthority: chunkOptions?.assertAuthority,
                    replyToMessageId: chunkOptions?.replyToMessageId ?? replyToMessageId,
                }),
            }, options);
        },
        sendMarkdownReply: async (chatId, replyToMessageId, markdown, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            const renderingMode = deps.getAssistantRenderingMode?.() ?? "rich";
            if (renderingMode === "html") {
                return deps.replyTransport.sendRenderedChunks(chatId, deps.renderBaleMessage(markdown, { mode: "markdown" }), {
                    replyMarkup: options?.replyMarkup,
                    target: options?.target,
                    replyToMessageId,
                    assertAuthority: options.assertAuthority,
                });
            }
            return sendBaleNativeMarkdownReply(chatId, replyToMessageId, markdown, {
                recordOwnership: deps.recordOwnership,
                sendRichMessage: deps.sendRichMessage,
            }, options);
        },
        editInteractiveMessage: async (chatId, messageId, text, mode, replyMarkup, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            await deps.replyTransport.editRenderedMessage(chatId, messageId, deps.renderBaleMessage(text, { mode }), { ...options, replyMarkup });
        },
        sendInteractiveMessage: async (chatId, text, mode, replyMarkup, options) => {
            options = {
                ...options,
                target: options?.target && { ...options.target },
            };
            return deps.replyTransport.sendRenderedChunks(chatId, deps.renderBaleMessage(text, { mode }), {
                replyMarkup,
                target: options?.target,
                replyToMessageId: options?.replyToMessageId,
                assertAuthority: options.assertAuthority,
            });
        },
        sendSectionRichMessage: (chatId, message, options) => sendBaleNativeRichMessage(chatId, message, {
            recordOwnership: deps.recordOwnership,
            sendRichMessage: deps.sendRichMessage,
        }, options),
    };
}
/**
 * Guest reply sender: answers guest queries with native Rich Markdown content.
 * Guest queries use InlineQueryResult input_message_content rather than chat
 * sendRichMessage, so this stays as a dedicated guest transport adapter.
 */
export function createGuestMarkdownReplySender(deps) {
    return async (guestQueryId, markdown) => {
        const [richMarkdown = markdown] = splitBaleNativeMarkdown(markdown);
        await deps.answerGuestQuery(guestQueryId, undefined, {
            richMessage: { markdown: richMarkdown },
        });
    };
}
/**
 * Guest reply editor: replaces the early Guest Mode placeholder ACK with
 * native Rich Markdown content addressed by `inline_message_id` instead of a
 * chat/message pair.
 */
export function createGuestMarkdownReplyEditor(deps) {
    return async (inlineMessageId, markdown, options) => {
        const [richMarkdown = markdown] = splitBaleNativeMarkdown(markdown);
        await deps.editGuestInlineMessage(inlineMessageId, {
            richMessage: { markdown: richMarkdown },
        }, options);
    };
}
/**
 * Guest Mode placeholder rotation: the early ACK is the first placeholder
 * frame and the runtime steps the remaining frames once per interval, moving
 * the globe every second while the trailing dots grow once every two seconds.
 *
 * Rotation completes whole six-frame cycles and only stops once at least
 * `BALE_GUEST_PLACEHOLDER_MIN_MS` has elapsed, so a pending answer holds
 * the finished cycle's last frame (`🌏 Working on it...`) instead of whatever
 * step a hard time cap happens to cut. The `BALE_GUEST_PLACEHOLDER_MAX_MS`
 * safety bound keeps the edit stream clear of the first flood-control
 * rejections measured in live guest runs (+26.5 s at ~53 edits, +27.8 s at
 * ~28 edits): rotation caps at 23 edits and never starts a frame after 26 s.
 */
export const BALE_GUEST_PLACEHOLDER_FRAME_MS = 1_000;
export const BALE_GUEST_PLACEHOLDER_MIN_MS = 20_000;
export const BALE_GUEST_PLACEHOLDER_MAX_MS = 26_000;
export const BALE_GUEST_PLACEHOLDER_FRAMES = [
    "<b>🌎 Working on it.</b>",
    "<b>🌍 Working on it.</b>",
    "<b>🌏 Working on it..</b>",
    "<b>🌎 Working on it..</b>",
    "<b>🌍 Working on it...</b>",
    "<b>🌏 Working on it...</b>",
];
// Bale does not expose deletion for inline messages. This non-printing,
// non-empty edit visually clears a guest placeholder after its query is skipped.
export const BALE_DISMISSED_GUEST_PLACEHOLDER_TEXT = "\u2063";
export function buildBaleGuestPlaceholderFrame(step) {
    const frames = BALE_GUEST_PLACEHOLDER_FRAMES;
    const index = ((step % frames.length) + frames.length) % frames.length;
    return frames[index];
}
function getBaleGuestPlaceholderRetryDelayMs(error, fallbackMs) {
    const retryAfterSeconds = error?.retryAfterSeconds;
    return typeof retryAfterSeconds === "number" && retryAfterSeconds > 0
        ? Math.max(fallbackMs, retryAfterSeconds * 1_000)
        : fallbackMs;
}
export function createBaleGuestPlaceholderRuntime(deps) {
    const intervalMs = deps.intervalMs ?? BALE_GUEST_PLACEHOLDER_FRAME_MS;
    const minMs = deps.minMs ?? BALE_GUEST_PLACEHOLDER_MIN_MS;
    const maxMs = deps.maxMs ?? BALE_GUEST_PLACEHOLDER_MAX_MS;
    const now = deps.now ?? Date.now;
    const setTimer = deps.setTimer ??
        ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = deps.clearTimer ??
        ((timer) => clearTimeout(timer));
    const sessions = new Map();
    const finishRotation = (session, elapsedMs) => {
        if (session.finished)
            return;
        session.finished = true;
        deps.recordRuntimeEvent?.("guest", "Guest placeholder rotation reached its bound", {
            phase: "guest-placeholder-capped",
            minMs,
            maxMs,
            elapsedMs,
            step: session.step,
        });
    };
    const scheduleFrame = (inlineMessageId, session, delayMs) => {
        if (session.stopped)
            return;
        const elapsedMs = now() - session.startedAtMs;
        const frameCount = BALE_GUEST_PLACEHOLDER_FRAMES.length;
        const cycleComplete = session.step > 0 && session.step % frameCount === frameCount - 1;
        if (cycleComplete && elapsedMs >= minMs) {
            finishRotation(session, elapsedMs);
            return;
        }
        if (elapsedMs + delayMs > maxMs) {
            finishRotation(session, elapsedMs);
            return;
        }
        const timer = setTimer(() => {
            session.timer = undefined;
            runFrame(inlineMessageId, session);
        }, delayMs);
        timer.unref?.();
        session.timer = timer;
    };
    const runFrame = (inlineMessageId, session) => {
        if (session.stopped)
            return;
        session.step += 1;
        let nextDelayMs = intervalMs;
        session.inflight = (async () => {
            try {
                await deps.editGuestInlineMessage(inlineMessageId, {
                    text: buildBaleGuestPlaceholderFrame(session.step),
                    parseMode: "HTML",
                });
            }
            catch (error) {
                nextDelayMs = getBaleGuestPlaceholderRetryDelayMs(error, intervalMs);
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-placeholder-edit",
                    retryAfterMs: nextDelayMs,
                });
            }
            finally {
                session.inflight = undefined;
                scheduleFrame(inlineMessageId, session, nextDelayMs);
            }
        })();
    };
    const stop = async (inlineMessageId) => {
        const session = sessions.get(inlineMessageId);
        if (!session)
            return;
        sessions.delete(inlineMessageId);
        session.stopped = true;
        if (session.timer !== undefined) {
            clearTimer(session.timer);
            session.timer = undefined;
        }
        try {
            await session.inflight;
        }
        catch {
            // Frame failures are reported as runtime events; stopping stays fail-open.
        }
    };
    return {
        start(inlineMessageId) {
            const existing = sessions.get(inlineMessageId);
            if (existing) {
                existing.stopped = true;
                if (existing.timer !== undefined)
                    clearTimer(existing.timer);
            }
            const session = {
                step: 0,
                stopped: false,
                startedAtMs: now(),
                finished: false,
            };
            sessions.set(inlineMessageId, session);
            scheduleFrame(inlineMessageId, session, intervalMs);
        },
        stop,
        stopAll() {
            for (const session of sessions.values()) {
                session.stopped = true;
                if (session.timer !== undefined)
                    clearTimer(session.timer);
            }
            sessions.clear();
        },
        async dismiss(inlineMessageId) {
            await stop(inlineMessageId);
            try {
                await deps.editGuestInlineMessage(inlineMessageId, {
                    text: BALE_DISMISSED_GUEST_PLACEHOLDER_TEXT,
                    parseMode: "HTML",
                });
            }
            catch (error) {
                deps.recordRuntimeEvent?.("guest", error, {
                    phase: "guest-placeholder-dismiss",
                });
            }
        },
    };
}
