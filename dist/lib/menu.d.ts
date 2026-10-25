/**
 * Bale menu and inline-keyboard rendering helpers
 * Zones: bale ui, controls, status menu
 * Owns app-menu/status state, inline UI text, and callback composition while model/thinking/queue menu details live in dedicated domains
 */
import { type BaleMenuMessageRuntimeDeps, type BaleModelMenuState, type BaleReplyMarkup } from "./menu-model.ts";
import { type MenuModel, type ScopedBaleModel, type BaleModelSwitchContinuationSource, type ThinkingLevel } from "./model.ts";
import { type BaleSectionRegistry } from "./sections.ts";
import type { BaleApiCallOptions, BaleInputRichMessage } from "./bale-api.ts";
export { applyBaleModelPageSelection, applyBaleModelScopeSelection, buildModelMenuReplyMarkup, buildModelPageMenuReplyMarkup, buildBaleModelCallbackPlan, buildBaleModelMenuRenderPayload, buildBaleModelMenuState, buildBaleModelMenuStateRuntime, buildBaleModelPageMenuRenderPayload, createBaleModelMenuRuntime, createBaleModelMenuStateBuilder, formatScopedModelButtonText, getModelMenuItems, getStoredBaleModelMenuState, getBaleModelMenuPage, getBaleModelSelection, handleBaleModelMenuCallbackAction, MODEL_MENU_TITLE, MODEL_PAGE_MENU_TITLE, openBaleModelMenu, pruneStoredBaleModelMenus, resolveCachedBaleModelMenuInputs, sendBaleModelMenuMessage, storeBaleModelMenuState, BALE_MODEL_PAGE_SIZE, updateBaleModelMenuMessage, } from "./menu-model.ts";
export type { BuildBaleModelCallbackPlanParams, BuildBaleModelMenuStateParams, CachedBaleModelMenuInputs, MenuSettingsManager, StoredBaleModelMenuState, BaleMenuMessageRuntimeDeps, BaleMenuMutationResult, BaleMenuRenderPayload, BaleMenuSelectionResult, BaleModelCallbackPlan, BaleModelMenuCallbackDeps, BaleModelMenuInputCacheDeps, BaleModelMenuOpenDeps, BaleModelMenuPage, BaleModelMenuRuntime, BaleModelMenuRuntimeContext, BaleModelMenuRuntimeOptions, BaleModelMenuState, BaleModelMenuStateBuilderContext, BaleModelMenuStateBuilderDeps, BaleModelMenuStoreOptions, BaleModelScope, BaleReplyMarkup, } from "./menu-model.ts";
export { buildStatusReplyMarkup, buildBaleStatusMenuRenderPayload, handleBaleStatusMenuCallbackAction, openBaleStatusMenu, sendBaleStatusMessage, updateBaleStatusMessage, } from "./menu-status.ts";
export type { BaleStatusMenuCallbackDeps, BaleStatusMenuOpenDeps, } from "./menu-status.ts";
export { buildBaleThinkingMenuRenderPayload, buildThinkingMenuReplyMarkup, buildThinkingMenuText, handleBaleThinkingMenuCallbackAction, openBaleThinkingMenu, updateBaleThinkingMenuMessage, } from "./menu-thinking.ts";
export type { BaleThinkingMenuCallbackDeps, BaleThinkingMenuOpenDeps, } from "./menu-thinking.ts";
export interface BaleMenuCallbackEntryDeps {
    handleStatusAction: () => Promise<boolean>;
    handleThinkingAction: () => Promise<boolean>;
    handleModelAction: () => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export interface MenuCallbackQuery {
    id: string;
    data?: string;
    message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: {
            id?: number;
        };
    };
}
export interface StoredBaleMenuCallbackDeps<TModel extends MenuModel = MenuModel> {
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => BaleModelMenuState<TModel> | undefined;
    handleStatusAction: (state: BaleModelMenuState<TModel>) => Promise<boolean>;
    handleThinkingAction: (state: BaleModelMenuState<TModel>) => Promise<boolean>;
    handleModelAction: (state: BaleModelMenuState<TModel>) => Promise<boolean>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export interface BaleMenuCallbackRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> {
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => BaleModelMenuState<TModel> | undefined;
    getActiveModel: (ctx: TContext) => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    setThinkingLevel: (level: ThinkingLevel) => void;
    updateStatus: (ctx: TContext) => void;
    updateModelMenuMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateThinkingMenuMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateStatusMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateSettingsMenuMessage?: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isIdle: (ctx: TContext) => boolean;
    hasAbortHandler: () => boolean;
    hasActiveToolExecutions: () => boolean;
    persistScopedModelPatterns?: (patterns: string[], ctx: TContext) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    setCurrentModel: (model: TModel, ctx: TContext) => void;
    stagePendingModelSwitch: (selection: ScopedBaleModel<TModel>, ctx: TContext, continuationTurn: BaleModelSwitchContinuationSource) => void;
    restartInterruptedBaleTurn: (selection: ScopedBaleModel<TModel>, ctx: TContext, continuationTurn: BaleModelSwitchContinuationSource) => Promise<boolean> | boolean;
    sectionRegistry?: BaleSectionRegistry;
    editInteractiveMessage?: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleReplyMarkup) => Promise<void>;
    sendInteractiveMessage?: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleReplyMarkup, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    sendSectionRichMessage?: (chatId: number, message: BaleInputRichMessage, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
    }) => Promise<number | undefined>;
    enqueueSectionPrompt?: (prompt: string, ctx: TContext, target?: {
        chatId: number;
        threadId?: number;
    }, source?: unknown) => Promise<void>;
    deleteMessage?: (chatId: number, messageId: number) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}
export interface BaleMenuActionRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> extends BaleMenuMessageRuntimeDeps {
    getModelMenuState: (chatId: number, ctx: TContext, threadId?: number) => Promise<BaleModelMenuState<TModel>>;
    getActiveModel: (ctx: TContext) => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    getQueueItemCount?: () => number;
    getPendingCancellationCount?: () => number;
    buildStatusHtml: (ctx: TContext) => string;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
    isIdle: (ctx: TContext) => boolean;
    canOfferInFlightModelSwitch: (ctx: TContext) => boolean;
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        target?: {
            chatId: number;
            threadId?: number;
        };
        parseMode?: "HTML";
        assertAuthority?: BaleApiCallOptions["assertAuthority"];
    }) => Promise<unknown>;
    sectionRegistry?: BaleSectionRegistry;
    isVoiceReplyActive?: () => boolean;
}
export interface BaleMenuActionRuntime<TContext, TModel extends MenuModel = MenuModel> {
    updateModelMenuMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateThinkingMenuMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    updateStatusMessage: (state: BaleModelMenuState<TModel>, ctx: TContext) => Promise<void>;
    sendStatusMessage: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openModelMenu: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    openThinkingMenu: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
}
export declare function handleBaleMenuCallbackEntry(callbackQueryId: string, data: string | undefined, state: BaleModelMenuState | undefined, deps: BaleMenuCallbackEntryDeps): Promise<void>;
export declare function handleStoredBaleMenuCallback<TModel extends MenuModel = MenuModel>(query: MenuCallbackQuery, deps: StoredBaleMenuCallbackDeps<TModel>): Promise<void>;
export type BaleMenuCallbackRuntimeAdapterDeps<TContext, TModel extends MenuModel = MenuModel> = Omit<BaleMenuCallbackRuntimeDeps<TContext, TModel>, "hasActiveToolExecutions"> & {
    getActiveToolExecutions: () => number;
};
export declare function createBaleMenuCallbackHandler<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(deps: BaleMenuCallbackRuntimeDeps<TContext, TModel>): (query: TQuery, ctx: TContext) => Promise<void>;
export declare function createBaleMenuCallbackHandlerForContext<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(deps: BaleMenuCallbackRuntimeAdapterDeps<TContext, TModel>): (query: TQuery, ctx: TContext) => Promise<void>;
export declare function handleBaleMenuCallbackRuntime<TQuery extends MenuCallbackQuery, TContext, TModel extends MenuModel = MenuModel>(query: TQuery, ctx: TContext, deps: BaleMenuCallbackRuntimeDeps<TContext, TModel>): Promise<void>;
export declare function createBaleMenuActionRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: BaleMenuActionRuntimeDeps<TContext, TModel>): BaleMenuActionRuntime<TContext, TModel>;
