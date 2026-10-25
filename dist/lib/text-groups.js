/**
 * Bale text-group coalescing helpers
 * Zones: bale inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Bale text messages that look like automatic long-message splits
 */
import { setTimeout as waitForTimeout } from "node:timers/promises";
import { createBalePendingGroups, extractBaleMessageText, } from "./media.js";
const BALE_TEXT_GROUP_DEBOUNCE_MS = 1000;
const BALE_TEXT_GROUP_MIN_SPLIT_LENGTH = 3600;
const BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP = 12;
function extractBaleTextGroupText(message) {
    return extractBaleMessageText(message);
}
function isBaleForwardedMessage(message) {
    return (message.forward_origin !== undefined ||
        message.forward_from !== undefined ||
        typeof message.forward_sender_name === "string");
}
function isBaleTextGroupCommand(text) {
    return text.trimStart().startsWith("/");
}
function isBaleTextGroupClearingCommand(text) {
    const command = text.trimStart().split(/\s+/, 1)[0]?.split("@", 1)[0];
    return command === "/stop";
}
function getBaleTextGroupMessageIdentity(message) {
    const threadKey = typeof message.message_thread_id === "number"
        ? `thread:${message.message_thread_id}`
        : "private";
    return `${message.chat.id}:${threadKey}:${message.message_id}`;
}
function getBaleTextGroupKey(message) {
    if (message.media_group_id)
        return undefined;
    if (!message.from || message.from.is_bot)
        return undefined;
    if (!extractBaleTextGroupText(message) &&
        !isBaleForwardedMessage(message)) {
        return undefined;
    }
    const threadKey = typeof message.message_thread_id === "number"
        ? `thread:${message.message_thread_id}`
        : "private";
    return `${message.chat.id}:${threadKey}:${message.from.id}`;
}
function canStartBaleTextGroup(message, minSplitLength) {
    const text = extractBaleTextGroupText(message);
    return text.length >= minSplitLength && !isBaleTextGroupCommand(text);
}
function canAppendBaleTextGroupMessage(group, message) {
    const text = extractBaleTextGroupText(message);
    const previous = group.messages.at(-1);
    return (!!previous &&
        message.message_id > previous.message_id &&
        message.message_id <=
            previous.message_id + BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP &&
        (text.length > 0 || isBaleForwardedMessage(message)) &&
        !isBaleTextGroupCommand(text));
}
export function createBaleTextGroupController(options = {}) {
    const plannedForwardCommentStarts = new Set();
    const plannedForwardCommentEnds = new Set();
    const debounceMs = options.debounceMs ?? BALE_TEXT_GROUP_DEBOUNCE_MS;
    const minSplitLength = options.minSplitLength ?? BALE_TEXT_GROUP_MIN_SPLIT_LENGTH;
    const forwardCommentWaitMs = options.forwardCommentWaitMs === undefined
        ? debounceMs
        : options.forwardCommentWaitMs;
    const setTimer = options.setTimer ??
        ((callback, ms) => {
            const controller = new AbortController();
            void waitForTimeout(ms, undefined, {
                signal: controller.signal,
            }).then(callback, () => undefined);
            return controller;
        });
    const clearTimer = options.clearTimer ??
        (options.setTimer
            ? clearTimeout
            : (timer) => {
                timer.abort();
            });
    const groups = createBalePendingGroups({ debounceMs, requireContext: true, setTimer, clearTimer });
    /** Admission policy for one message; the shared group machine owns timers, batches and dispatch. */
    const queueTextGroupMessage = (options) => {
        const existing = groups.get(options.key);
        const dispatchMessages = (messages, ctx) => options.dispatchMessages(messages, ctx);
        const queued = {
            key: options.key,
            message: options.message,
            context: options.context,
            ...(options.forwardPairCandidate === undefined
                ? {}
                : { meta: options.forwardPairCandidate }),
            dispatchMessages,
        };
        if (existing?.messages.some((message) => message.message_id === options.message.message_id)) {
            groups.queue({ ...queued, delayMs: debounceMs, rearm: "ifIdle" });
            return true;
        }
        if (!existing &&
            !options.forceStart &&
            !canStartBaleTextGroup(options.message, minSplitLength))
            return false;
        if (existing &&
            !canAppendBaleTextGroupMessage(existing, options.message))
            return false;
        groups.queue({
            ...queued,
            delayMs: options.dispatchImmediately
                ? 0
                : (options.delayMs ?? debounceMs),
            rearm: "always",
        });
        return true;
    };
    return {
        prepareUpdateBatch(updates) {
            for (let index = 0; index + 1 < updates.length; index += 1) {
                const comment = updates[index]?.message;
                const forwarded = updates[index + 1]?.message;
                if (!comment || !forwarded)
                    continue;
                const commentText = extractBaleTextGroupText(comment);
                const commentKey = getBaleTextGroupKey(comment);
                const forwardedKey = getBaleTextGroupKey(forwarded);
                if (!commentKey ||
                    commentKey !== forwardedKey ||
                    !commentText ||
                    isBaleTextGroupCommand(commentText) ||
                    isBaleForwardedMessage(comment) ||
                    !isBaleForwardedMessage(forwarded) ||
                    forwarded.message_id <= comment.message_id ||
                    forwarded.message_id >
                        comment.message_id + BALE_TEXT_GROUP_MAX_MESSAGE_ID_GAP) {
                    continue;
                }
                plannedForwardCommentStarts.add(getBaleTextGroupMessageIdentity(comment));
                plannedForwardCommentEnds.add(getBaleTextGroupMessageIdentity(forwarded));
            }
        },
        getPreparedForwardingPosition(message) {
            const identity = getBaleTextGroupMessageIdentity(message);
            if (plannedForwardCommentStarts.has(identity))
                return "comment";
            if (plannedForwardCommentEnds.has(identity))
                return "forward";
            return undefined;
        },
        prepareForwardedMessage(message, position) {
            const identity = getBaleTextGroupMessageIdentity(message);
            if (position === "comment")
                plannedForwardCommentStarts.add(identity);
            else
                plannedForwardCommentEnds.add(identity);
        },
        queueMessage: ({ message, context, dispatchMessages }) => {
            const identity = getBaleTextGroupMessageIdentity(message);
            const key = getBaleTextGroupKey(message);
            const plannedStart = plannedForwardCommentStarts.delete(identity);
            const forwarded = isBaleForwardedMessage(message);
            const existing = key ? groups.get(key) : undefined;
            const text = extractBaleTextGroupText(message);
            if (existing && isBaleTextGroupClearingCommand(text))
                groups.clearKey(key);
            const candidatePosition = forwarded
                ? "forward"
                : "comment";
            const existingCandidate = existing?.meta;
            const pairCompleted = existingCandidate !== undefined &&
                existingCandidate !== candidatePosition;
            const separateFromCandidate = existingCandidate === candidatePosition &&
                !isBaleTextGroupCommand(text);
            if (separateFromCandidate && existing)
                groups.closeBatch(key);
            const forceStart = plannedStart ||
                (forwardCommentWaitMs !== false &&
                    !!key &&
                    (forwarded ||
                        (typeof message.text === "string" &&
                            !isBaleTextGroupCommand(extractBaleTextGroupText(message)))));
            const dispatchImmediately = pairCompleted ||
                separateFromCandidate ||
                plannedForwardCommentEnds.delete(identity) ||
                (forwarded && !!key && groups.get(key) !== undefined);
            if (!key)
                return false;
            return queueTextGroupMessage({
                key,
                message,
                context,
                dispatchMessages,
                forceStart,
                dispatchImmediately,
                forwardPairCandidate: forceStart && !canStartBaleTextGroup(message, minSplitLength)
                    ? candidatePosition
                    : undefined,
                delayMs: forceStart && !canStartBaleTextGroup(message, minSplitLength)
                    ? forwardCommentWaitMs === false
                        ? undefined
                        : forwardCommentWaitMs
                    : undefined,
            });
        },
        flushMessage: groups.flushMessage,
        suspend: groups.suspend,
        resume: groups.resume,
        clear: () => {
            groups.clear();
            plannedForwardCommentStarts.clear();
            plannedForwardCommentEnds.clear();
        },
    };
}
export function createBaleTextGroupDispatchRuntime(deps) {
    return {
        handleMessage: async (message, ctx) => {
            const queuedTextGroup = deps.textGroups.queueMessage({
                message,
                context: ctx,
                dispatchMessages: (messages, queuedCtx) => deps.dispatchMessages(messages, queuedCtx),
            });
            if (queuedTextGroup) {
                deps.onDeferredMessage?.(message);
                return;
            }
            await deps.dispatchSingleMessage(message, ctx);
        },
    };
}
export function createBaleGroupedInputClearer(deps) {
    return () => {
        deps.clearMediaGroups();
        deps.clearTextGroups();
    };
}
