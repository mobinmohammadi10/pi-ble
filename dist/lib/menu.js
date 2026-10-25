/**
 * Bale menu and inline-keyboard rendering helpers
 * Zones: bale ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */
import { createBaleMenuDelivery, handleBaleModelMenuCallbackAction, openBaleModelMenu, sendBaleModelMenuMessage, updateBaleModelMenuMessage, } from "./menu-model.js";
import { handleBaleStatusMenuCallbackAction, openBaleStatusMenu, sendBaleStatusMessage, updateBaleStatusMessage, } from "./menu-status.js";
import { handleBaleThinkingMenuCallbackAction, openBaleThinkingMenu, updateBaleThinkingMenuMessage, } from "./menu-thinking.js";
import { handleBaleSectionCallback, handleBaleSectionOpen, handleBaleSectionSettingsOpen, parseBaleSectionCallback, } from "./sections.js";
export { applyBaleModelPageSelection, applyBaleModelScopeSelection, buildModelMenuReplyMarkup, buildModelPageMenuReplyMarkup, buildBaleModelCallbackPlan, buildBaleModelMenuRenderPayload, buildBaleModelMenuState, buildBaleModelMenuStateRuntime, buildBaleModelPageMenuRenderPayload, createBaleModelMenuRuntime, createBaleModelMenuStateBuilder, formatScopedModelButtonText, getModelMenuItems, getStoredBaleModelMenuState, getBaleModelMenuPage, getBaleModelSelection, handleBaleModelMenuCallbackAction, MODEL_MENU_TITLE, MODEL_PAGE_MENU_TITLE, openBaleModelMenu, pruneStoredBaleModelMenus, resolveCachedBaleModelMenuInputs, sendBaleModelMenuMessage, storeBaleModelMenuState, BALE_MODEL_PAGE_SIZE, updateBaleModelMenuMessage, } from "./menu-model.js";
export { buildStatusReplyMarkup, buildBaleStatusMenuRenderPayload, handleBaleStatusMenuCallbackAction, openBaleStatusMenu, sendBaleStatusMessage, updateBaleStatusMessage, } from "./menu-status.js";
export { buildBaleThinkingMenuRenderPayload, buildThinkingMenuReplyMarkup, buildThinkingMenuText, handleBaleThinkingMenuCallbackAction, openBaleThinkingMenu, updateBaleThinkingMenuMessage, } from "./menu-thinking.js";
export async function handleBaleMenuCallbackEntry(callbackQueryId, data, state, deps) {
    if (!data) {
        await deps.answerCallbackQuery(callbackQueryId);
        return;
    }
    if (!state) {
        await deps.answerCallbackQuery(callbackQueryId, "Interactive message expired");
        return;
    }
    const handled = (await deps.handleStatusAction()) ||
        (await deps.handleThinkingAction()) ||
        (await deps.handleModelAction());
    if (!handled) {
        await deps.answerCallbackQuery(callbackQueryId);
    }
}
export async function handleStoredBaleMenuCallback(query, deps) {
    const state = deps.getStoredModelMenuState(query.message?.message_id, query.message?.chat?.id);
    await handleBaleMenuCallbackEntry(query.id, query.data, state, {
        handleStatusAction: async () => {
            if (!state)
                return false;
            return deps.handleStatusAction(state);
        },
        handleThinkingAction: async () => {
            if (!state)
                return false;
            return deps.handleThinkingAction(state);
        },
        handleModelAction: async () => {
            if (!state)
                return false;
            return deps.handleModelAction(state);
        },
        answerCallbackQuery: deps.answerCallbackQuery,
    });
}
export function createBaleMenuCallbackHandler(deps) {
    return (query, ctx) => handleBaleMenuCallbackRuntime(query, ctx, deps);
}
export function createBaleMenuCallbackHandlerForContext(deps) {
    const { getActiveToolExecutions, ...ports } = deps;
    return createBaleMenuCallbackHandler({
        ...ports,
        hasActiveToolExecutions: () => getActiveToolExecutions() > 0,
    });
}
export async function handleBaleMenuCallbackRuntime(query, ctx, deps) {
    if (query.data === "menu:back") {
        const state = deps.getStoredModelMenuState(query.message?.message_id, query.message?.chat?.id);
        if (!state) {
            await deps.answerCallbackQuery(query.id, "Interactive message expired");
            return;
        }
        await deps.updateStatusMessage(state, ctx);
        await deps.answerCallbackQuery(query.id);
        return;
    }
    // Section callbacks: dispatch before built-in menu handling
    if (deps.sectionRegistry && query.data?.startsWith("section:")) {
        const parsed = parseBaleSectionCallback(query.data);
        if (parsed) {
            const message = query.message;
            const chatId = message?.chat?.id;
            const messageId = message?.message_id;
            const target = typeof chatId === "number"
                ? typeof message?.message_thread_id === "number"
                    ? { chatId, threadId: message.message_thread_id }
                    : { chatId }
                : undefined;
            if (typeof chatId === "number" && typeof messageId === "number") {
                const { token, action, payload } = parsed;
                const sectionDeps = {
                    answerCallbackQuery: deps.answerCallbackQuery,
                    target,
                    editInteractiveMessage: deps.editInteractiveMessage ?? (async () => { }),
                    sendInteractiveMessage: deps.sendInteractiveMessage ?? (async () => undefined),
                    sendRichMessage: deps.sendSectionRichMessage ??
                        (async () => {
                            throw new Error("Rich Message delivery is unavailable");
                        }),
                    enqueuePrompt: deps.enqueueSectionPrompt
                        ? (prompt) => deps.enqueueSectionPrompt(prompt, ctx, target, query)
                        : async () => { },
                    deleteMessage: deps.deleteMessage ?? (async () => { }),
                };
                if (action === "open") {
                    const state = deps.getStoredModelMenuState(messageId, chatId);
                    if (!state) {
                        await deps.answerCallbackQuery(query.id, "Interactive message expired");
                        return;
                    }
                    const handled = await handleBaleSectionOpen(deps.sectionRegistry, token, chatId, messageId, query.id, sectionDeps);
                    if (handled)
                        return;
                }
                else if (action === "settings") {
                    const handled = await handleBaleSectionSettingsOpen(deps.sectionRegistry, token, chatId, messageId, query.id, sectionDeps);
                    if (handled)
                        return;
                }
                else {
                    const handled = await handleBaleSectionCallback(deps.sectionRegistry, token, action, payload, chatId, messageId, query.id, sectionDeps);
                    if (handled)
                        return;
                }
            }
        }
    }
    await handleStoredBaleMenuCallback(query, {
        getStoredModelMenuState: deps.getStoredModelMenuState,
        handleStatusAction: async (state) => handleBaleStatusMenuCallbackAction(query.id, query.data, deps.getActiveModel(ctx), {
            updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
            updateThinkingMenuMessage: () => deps.updateThinkingMenuMessage(state, ctx),
            updateSettingsMenuMessage: () => deps.updateSettingsMenuMessage?.(state, ctx) ?? Promise.resolve(),
            answerCallbackQuery: deps.answerCallbackQuery,
            isVoiceReplyActive: deps.isVoiceReplyActive,
        }),
        handleThinkingAction: async (state) => handleBaleThinkingMenuCallbackAction(query.id, query.data, deps.getActiveModel(ctx), {
            setThinkingLevel: (level) => {
                deps.setThinkingLevel(level);
                deps.updateStatus(ctx);
            },
            getCurrentThinkingLevel: deps.getThinkingLevel,
            updateThinkingMenuMessage: () => deps.updateThinkingMenuMessage(state, ctx),
            answerCallbackQuery: deps.answerCallbackQuery,
            isVoiceReplyActive: deps.isVoiceReplyActive,
        }),
        handleModelAction: async (state) => {
            try {
                return await handleBaleModelMenuCallbackAction(query.id, {
                    data: query.data,
                    state,
                    activeModel: deps.getActiveModel(ctx),
                    currentThinkingLevel: deps.getThinkingLevel(),
                    isIdle: deps.isIdle(ctx),
                    canRestartBusyRun: deps.hasAbortHandler(),
                    hasActiveToolExecutions: deps.hasActiveToolExecutions(),
                }, {
                    updateModelMenuMessage: () => deps.updateModelMenuMessage(state, ctx),
                    updateStatusMessage: () => deps.updateStatusMessage(state, ctx),
                    answerCallbackQuery: deps.answerCallbackQuery,
                    persistScopedModelPatterns: deps.persistScopedModelPatterns
                        ? (patterns) => deps.persistScopedModelPatterns(patterns, ctx)
                        : undefined,
                    setModel: deps.setModel,
                    setCurrentModel: (model) => deps.setCurrentModel(model, ctx),
                    setThinkingLevel: (level) => {
                        deps.setThinkingLevel(level);
                        deps.updateStatus(ctx);
                    },
                    stagePendingModelSwitch: (selection, continuationTurn) => {
                        deps.stagePendingModelSwitch(selection, ctx, continuationTurn);
                    },
                    restartInterruptedBaleTurn: (selection, continuationTurn) => deps.restartInterruptedBaleTurn(selection, ctx, continuationTurn),
                });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                await deps.answerCallbackQuery(query.id, message);
                return true;
            }
        },
        answerCallbackQuery: deps.answerCallbackQuery,
    });
}
export function createBaleMenuActionRuntime(deps) {
    return {
        updateModelMenuMessage: (state, ctx) => updateBaleModelMenuMessage(state, deps.getActiveModel(ctx), deps),
        updateThinkingMenuMessage: (state, ctx) => updateBaleThinkingMenuMessage(state, deps.getActiveModel(ctx), deps.getThinkingLevel(), deps),
        updateStatusMessage: (state, ctx) => updateBaleStatusMessage(state, deps.buildStatusHtml(ctx), deps.getActiveModel(ctx), deps.getThinkingLevel(), deps, deps.getQueueItemCount?.() ?? 0, deps.sectionRegistry, deps.isVoiceReplyActive?.(), deps.getPendingCancellationCount?.() ?? 0),
        sendStatusMessage: (chatId, replyToMessageId, ctx, threadId, options) => {
            const delivery = createBaleMenuDelivery({ chatId, threadId }, options, deps);
            return openBaleStatusMenu({
                isIdle: () => deps.isIdle(ctx),
                sendBusyMessage: async () => {
                    await deps.sendTextReply(chatId, replyToMessageId, "<b>⏳ Cannot open status while Pi is busy. Send /abort, /next, or /stop.</b>", {
                        target: { chatId, threadId },
                        parseMode: "HTML",
                        ...(delivery.assertAuthority
                            ? { assertAuthority: delivery.assertAuthority }
                            : {}),
                    });
                },
                getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
                buildStatusHtml: () => deps.buildStatusHtml(ctx),
                getActiveModel: () => deps.getActiveModel(ctx),
                getThinkingLevel: deps.getThinkingLevel,
                getQueueItemCount: deps.getQueueItemCount,
                sendStatusMenu: (state, statusHtml, activeModel, thinkingLevel, queueItemCount) => sendBaleStatusMessage(state, statusHtml, activeModel, thinkingLevel, {
                    ...deps,
                    sendInteractiveMessage: delivery.sendInteractiveMessage,
                }, queueItemCount, deps.sectionRegistry, deps.isVoiceReplyActive?.(), deps.getPendingCancellationCount?.() ?? 0),
                storeModelMenuState: delivery.storeModelMenuState,
            });
        },
        openModelMenu: (chatId, replyToMessageId, ctx, threadId, options) => {
            const delivery = createBaleMenuDelivery({ chatId, threadId }, options, deps);
            const assertAuthority = delivery.assertAuthority;
            return openBaleModelMenu({
                isIdle: () => deps.isIdle(ctx),
                canOfferInFlightModelSwitch: () => deps.canOfferInFlightModelSwitch(ctx),
                sendBusyMessage: async () => {
                    await deps.sendTextReply(chatId, replyToMessageId, "<b>⏳ Cannot switch model while Pi is busy. Send /abort, /next, or /stop.</b>", {
                        target: { chatId, threadId },
                        parseMode: "HTML",
                        ...(assertAuthority ? { assertAuthority } : {}),
                    });
                },
                sendNoModelsMessage: async () => {
                    await deps.sendTextReply(chatId, replyToMessageId, "<b>🚫 No available models with configured auth.</b>", {
                        target: { chatId, threadId },
                        parseMode: "HTML",
                        ...(assertAuthority ? { assertAuthority } : {}),
                    });
                },
                getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
                getActiveModel: () => deps.getActiveModel(ctx),
                sendModelMenu: (state, activeModel) => sendBaleModelMenuMessage(state, activeModel, {
                    ...deps,
                    sendInteractiveMessage: delivery.sendInteractiveMessage,
                }),
                storeModelMenuState: delivery.storeModelMenuState,
            });
        },
        openThinkingMenu: (chatId, _replyToMessageId, ctx, threadId, options) => {
            const delivery = createBaleMenuDelivery({ chatId, threadId }, options, deps);
            return openBaleThinkingMenu({
                getModelMenuState: () => deps.getModelMenuState(chatId, ctx, threadId),
                getActiveModel: () => deps.getActiveModel(ctx),
                getThinkingLevel: deps.getThinkingLevel,
                storeModelMenuState: delivery.storeModelMenuState,
                editInteractiveMessage: deps.editInteractiveMessage,
                sendInteractiveMessage: delivery.sendInteractiveMessage,
                isVoiceReplyActive: deps.isVoiceReplyActive,
            });
        },
    };
}
