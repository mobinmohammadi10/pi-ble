/**
 * Bale thinking menu UI helpers
 * Zones: bale ui, thinking controls, menu composition
 * Owns thinking-menu text, reply markup, callback handling, and thinking-menu message rendering
 */
import { editBaleMenuMessage, sendBaleMenuMessage, } from "./menu-model.js";
import { isThinkingLevel, THINKING_LEVELS, } from "./model.js";
function parseBaleThinkingMenuCallbackAction(data) {
    if (!data?.startsWith("thinking:set:"))
        return undefined;
    return { kind: "thinking:set", level: data.slice("thinking:set:".length) };
}
/** Answers and returns true when voice replies or a non-reasoning model disable thinking controls. */
export async function refuseUnavailableBaleThinkingControls(callbackQueryId, activeModel, deps) {
    if (deps.isVoiceReplyActive?.()) {
        await deps.answerCallbackQuery(callbackQueryId, "Thinking controls are disabled during voice replies");
        return true;
    }
    if (!activeModel?.reasoning) {
        await deps.answerCallbackQuery(callbackQueryId, "This model has no reasoning controls");
        return true;
    }
    return false;
}
export async function handleBaleThinkingMenuCallbackAction(callbackQueryId, data, activeModel, deps) {
    const action = parseBaleThinkingMenuCallbackAction(data);
    if (!action)
        return false;
    if (!isThinkingLevel(action.level)) {
        await deps.answerCallbackQuery(callbackQueryId, "Invalid thinking level");
        return true;
    }
    if (await refuseUnavailableBaleThinkingControls(callbackQueryId, activeModel, deps))
        return true;
    deps.setThinkingLevel(action.level);
    await deps.updateThinkingMenuMessage();
    await deps.answerCallbackQuery(callbackQueryId, `Thinking: ${deps.getCurrentThinkingLevel()}`);
    return true;
}
export function buildThinkingMenuText() {
    return "<b>🧠 Choose a thinking level:</b>";
}
export function buildThinkingMenuReplyMarkup(currentThinkingLevel) {
    const rows = [[{ text: "⬆️ Main menu", callback_data: "menu:back" }]];
    const levelButtons = THINKING_LEVELS.map((level) => ({
        text: level === currentThinkingLevel ? `🟢 ${level}` : level,
        callback_data: `thinking:set:${level}`,
    }));
    rows.push(levelButtons.slice(0, 1), levelButtons.slice(1, 4), levelButtons.slice(4, 7));
    return { inline_keyboard: rows };
}
export function buildBaleThinkingMenuRenderPayload(_activeModel, currentThinkingLevel) {
    return {
        nextMode: "thinking",
        text: buildThinkingMenuText(),
        mode: "html",
        replyMarkup: buildThinkingMenuReplyMarkup(currentThinkingLevel),
    };
}
export async function openBaleThinkingMenu(deps) {
    if (deps.isVoiceReplyActive?.())
        return;
    const state = await deps.getModelMenuState();
    const messageId = await sendBaleMenuMessage(state, buildBaleThinkingMenuRenderPayload(deps.getActiveModel(), deps.getThinkingLevel()), deps);
    if (messageId === undefined)
        return;
    state.messageId = messageId;
    state.mode = "thinking";
    deps.storeModelMenuState(state);
}
export async function updateBaleThinkingMenuMessage(state, activeModel, currentThinkingLevel, deps) {
    if (deps.isVoiceReplyActive?.())
        return;
    await editBaleMenuMessage(state, buildBaleThinkingMenuRenderPayload(activeModel, currentThinkingLevel), deps);
}
