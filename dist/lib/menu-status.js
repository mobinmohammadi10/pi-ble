/**
 * Bale status menu UI helpers
 * Zones: bale ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */
import { formatBaleCommandEmojiPrefix } from "./commands.js";
import { refuseUnavailableBaleThinkingControls } from "./menu-thinking.js";
import { editBaleMenuMessage, formatStatusButtonLabel, sendBaleMenuMessage, } from "./menu-model.js";
import { getCanonicalModelId, } from "./model.js";
import { getBaleSectionMainMenuRows, } from "./sections.js";
function isBaleStatusMenuCallbackAction(data, action) {
    return data === `menu:${action}` || data === `status:${action}`;
}
export async function openBaleStatusMenu(deps) {
    const state = await deps.getModelMenuState();
    const messageId = await deps.sendStatusMenu(state, deps.buildStatusHtml(), deps.getActiveModel(), deps.getThinkingLevel(), deps.getQueueItemCount?.() ?? 0);
    if (messageId === undefined)
        return;
    state.messageId = messageId;
    state.mode = "status";
    deps.storeModelMenuState(state);
}
export async function handleBaleStatusMenuCallbackAction(callbackQueryId, data, activeModel, deps) {
    if (isBaleStatusMenuCallbackAction(data, "model")) {
        await deps.updateModelMenuMessage();
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    if (isBaleStatusMenuCallbackAction(data, "settings")) {
        if (!deps.updateSettingsMenuMessage)
            return false;
        await deps.updateSettingsMenuMessage();
        await deps.answerCallbackQuery(callbackQueryId);
        return true;
    }
    if (!isBaleStatusMenuCallbackAction(data, "thinking"))
        return false;
    if (await refuseUnavailableBaleThinkingControls(callbackQueryId, activeModel, deps))
        return true;
    await deps.updateThinkingMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId);
    return true;
}
export function buildStatusReplyMarkup(activeModel, currentThinkingLevel, queueItemCount = 0, sectionRegistry, isVoiceReplyActive, pendingCancellationCount = 0) {
    const rows = [];
    rows.push([
        {
            text: formatStatusButtonLabel(`${formatBaleCommandEmojiPrefix("model")}Model`, activeModel ? getCanonicalModelId(activeModel) : "unknown"),
            callback_data: "menu:model",
        },
    ]);
    if (activeModel?.reasoning && !isVoiceReplyActive) {
        rows.push([
            {
                text: formatStatusButtonLabel(`${formatBaleCommandEmojiPrefix("thinking")}Thinking`, currentThinkingLevel),
                callback_data: "menu:thinking",
            },
        ]);
    }
    rows.push([
        {
            text: `${queueItemCount === 0 ? "⌛" : "⏳"} Queue: ${queueItemCount}`,
            callback_data: "menu:queue",
        },
    ]);
    if (pendingCancellationCount > 0)
        rows.push([
            {
                text: `❌ Pending cancellations: ${pendingCancellationCount}`,
                callback_data: "reroutecancel:review:open",
            },
        ]);
    if (sectionRegistry) {
        const sectionRows = getBaleSectionMainMenuRows(sectionRegistry);
        for (const row of sectionRows) {
            rows.push([row]);
        }
    }
    rows.push([
        {
            text: "⚙️ Settings",
            callback_data: "menu:settings",
        },
    ]);
    return { inline_keyboard: rows };
}
export function buildBaleStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount = 0, sectionRegistry, isVoiceReplyActive, pendingCancellationCount = 0) {
    return {
        nextMode: "status",
        text: statusText,
        mode: "html",
        replyMarkup: buildStatusReplyMarkup(activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive, pendingCancellationCount),
    };
}
export async function updateBaleStatusMessage(state, statusText, activeModel, currentThinkingLevel, deps, queueItemCount = 0, sectionRegistry, isVoiceReplyActive, pendingCancellationCount = 0) {
    await editBaleMenuMessage(state, buildBaleStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive, pendingCancellationCount), deps);
}
export function sendBaleStatusMessage(state, statusText, activeModel, currentThinkingLevel, deps, queueItemCount = 0, sectionRegistry, isVoiceReplyActive, pendingCancellationCount = 0) {
    return sendBaleMenuMessage(state, buildBaleStatusMenuRenderPayload(statusText, activeModel, currentThinkingLevel, queueItemCount, sectionRegistry, isVoiceReplyActive, pendingCancellationCount), deps);
}
