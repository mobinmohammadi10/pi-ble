/**
 * Bale model menu UI helpers
 * Zones: bale ui, model controls, menu composition
 * Owns model-menu state, scoped model pages, model callback planning, and model-menu message rendering
 */
import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import { type MenuModel, type ScopedBaleModel, type BaleModelSwitchContinuationSource, type ThinkingLevel } from "./model.ts";
import type { BaleTarget } from "./target.ts";
import { type BaleApiCallOptions } from "./bale-api.ts";
export type BaleModelScope = "all" | "scoped";
export interface BaleModelMenuState<TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    messageId: number;
    page: number;
    scope: BaleModelScope;
    scopedModels: ScopedBaleModel<TModel>[];
    allModels: ScopedBaleModel<TModel>[];
    note?: string;
    selectedModelIndex?: number;
    selectedModelKey?: string;
    scopedModelPatterns?: string[];
    canMutateScope?: boolean;
    mode: "status" | "model" | "model-pages" | "model-detail" | "thinking" | "queue" | "settings";
}
export interface StoredBaleModelMenuState<TModel extends MenuModel = MenuModel> {
    state: BaleModelMenuState<TModel>;
    updatedAt: number;
}
export interface BaleModelMenuStoreOptions {
    maxAgeMs: number;
    maxStoredMenus: number;
    now?: number;
}
export interface CachedBaleModelMenuInputs<TModel extends MenuModel = MenuModel> {
    expiresAt: number;
    availableModels: TModel[];
    configuredScopedModelPatterns: string[];
    cliScopedModelPatterns?: string[];
}
export interface BaleModelMenuInputCacheDeps<TModel extends MenuModel = MenuModel> {
    cacheTtlMs: number;
    now?: number;
    reloadSettings: () => Promise<void>;
    refreshAvailableModels: () => TModel[];
    getConfiguredScopedModelPatterns: () => string[] | undefined;
    getCliScopedModelPatterns: () => string[] | undefined;
}
export interface BaleModelMenuRuntimeContext<TModel extends MenuModel = MenuModel> {
    modelRegistry: {
        refresh: () => void;
        getAvailable: () => TModel[];
    };
}
export interface BaleModelMenuRuntimeOptions<TContext extends BaleModelMenuRuntimeContext<TModel>, TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    activeModel: TModel | undefined;
    cachedInputs: CachedBaleModelMenuInputs<TModel> | undefined;
    cacheTtlMs: number;
    ctx: TContext;
    reloadSettings: () => Promise<void>;
    getConfiguredScopedModelPatterns: () => string[] | undefined;
    getCliScopedModelPatterns?: () => string[] | undefined;
}
export interface MenuSettingsManager {
    reload?: () => Promise<void>;
    flush?: () => Promise<void>;
    getEnabledModels: () => string[] | undefined;
    setEnabledModels?: (patterns: string[] | undefined) => void;
}
export type BaleModelMenuStateBuilderContext<TModel extends MenuModel = MenuModel> = BaleModelMenuRuntimeContext<TModel> & {
    cwd: string;
};
export interface BaleModelMenuStateBuilderDeps<TModel extends MenuModel = MenuModel, TContext extends BaleModelMenuStateBuilderContext<TModel> = BaleModelMenuStateBuilderContext<TModel>> {
    runtime: BaleModelMenuRuntime<TModel>;
    createSettingsManager: (cwd: string) => MenuSettingsManager | PromiseLike<MenuSettingsManager>;
    getActiveModel: (ctx: TContext) => TModel | undefined;
}
export type BaleReplyMarkup = BaleInlineKeyboardMarkup;
export interface BaleMenuMessageRuntimeDeps {
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleReplyMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleReplyMarkup, options?: {
        target?: BaleTarget;
    } & Pick<BaleApiCallOptions, "assertAuthority">) => Promise<number | undefined>;
}
/** Per-open delivery lifetime; never retain this guard in stored callback state. */
export declare function createBaleMenuDelivery<TModel extends MenuModel>(target: BaleTarget, options: Pick<BaleApiCallOptions, "assertAuthority"> | undefined, deps: Pick<BaleMenuMessageRuntimeDeps, "sendInteractiveMessage"> & {
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}): {
    assertCurrent: () => void;
    assertAuthority: (() => void) | undefined;
    sendInteractiveMessage: (chatId: number, text: string, mode: "html" | "markdown" | "plain", replyMarkup: BaleInlineKeyboardMarkup, options?: ({
        target?: BaleTarget;
    } & Pick<BaleApiCallOptions, "assertAuthority">) | undefined) => Promise<number | undefined>;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
};
export type BaleModelMenuCallbackDeps<TModel extends MenuModel = MenuModel> = {
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    updateModelMenuMessage: () => Promise<void>;
    updateStatusMessage: () => Promise<void>;
    persistScopedModelPatterns?: (patterns: string[]) => Promise<void>;
    setModel: (model: TModel) => Promise<boolean>;
    setCurrentModel: (model: TModel) => void;
    setThinkingLevel: (level: ThinkingLevel) => void;
    stagePendingModelSwitch: (selection: ScopedBaleModel<TModel>, continuationTurn: BaleModelSwitchContinuationSource) => void;
    restartInterruptedBaleTurn: (selection: ScopedBaleModel<TModel>, continuationTurn: BaleModelSwitchContinuationSource) => Promise<boolean> | boolean;
};
export interface BaleModelMenuOpenDeps<TModel extends MenuModel = MenuModel> {
    isIdle: () => boolean;
    canOfferInFlightModelSwitch: () => boolean;
    sendBusyMessage: () => Promise<void>;
    sendNoModelsMessage: () => Promise<void>;
    getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
    getActiveModel: () => TModel | undefined;
    sendModelMenu: (state: BaleModelMenuState<TModel>, activeModel: TModel | undefined) => Promise<number | undefined>;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}
export interface BuildBaleModelMenuStateParams<TModel extends MenuModel = MenuModel> {
    chatId: number;
    threadId?: number;
    activeModel: TModel | undefined;
    availableModels: TModel[];
    configuredScopedModelPatterns: string[];
    cliScopedModelPatterns?: string[];
}
export type BaleMenuMutationResult = "invalid" | "unchanged" | "changed";
export type BaleMenuSelectionResult<TModel extends MenuModel = MenuModel> = {
    kind: "invalid";
} | {
    kind: "missing";
} | {
    kind: "selected";
    selection: ScopedBaleModel<TModel>;
};
export interface BaleModelMenuPage<TModel extends MenuModel = MenuModel> {
    page: number;
    pageCount: number;
    start: number;
    items: ScopedBaleModel<TModel>[];
}
export interface BaleMenuRenderPayload {
    nextMode: BaleModelMenuState["mode"];
    text: string;
    mode: "markdown" | "html" | "plain";
    replyMarkup: BaleReplyMarkup;
}
export type BaleModelCallbackPlan<TModel extends MenuModel = MenuModel> = {
    kind: "ignore";
} | {
    kind: "answer";
    text?: string;
} | {
    kind: "update-menu";
    text?: string;
} | {
    kind: "persist-scope";
    patterns: string[];
    text: string;
} | {
    kind: "refresh-status";
    selection: ScopedBaleModel<TModel>;
    callbackText: string;
    shouldApplyThinkingLevel: boolean;
} | {
    kind: "switch-model";
    selection: ScopedBaleModel<TModel>;
    mode: "idle" | "restart-now" | "restart-after-tool";
    callbackText: string;
};
export interface BuildBaleModelCallbackPlanParams<TModel extends MenuModel = MenuModel> {
    data: string | undefined;
    state: BaleModelMenuState<TModel>;
    activeModel: TModel | undefined;
    currentThinkingLevel: ThinkingLevel;
    isIdle: boolean;
    canRestartBusyRun: boolean;
    hasActiveToolExecutions: boolean;
}
export interface BaleModelMenuRuntime<TModel extends MenuModel = MenuModel> {
    storeState: (state: BaleModelMenuState<TModel>) => void;
    getState: (messageId: number | undefined, chatId?: number) => BaleModelMenuState<TModel> | undefined;
    clear: () => void;
    clearCachedInputs: () => void;
    buildState: <TContext extends BaleModelMenuRuntimeContext<TModel>>(options: Omit<BaleModelMenuRuntimeOptions<TContext, TModel>, "cachedInputs" | "cacheTtlMs">) => Promise<BaleModelMenuState<TModel>>;
}
export declare const BALE_MODEL_PAGE_SIZE = 6;
export declare const MODEL_MENU_TITLE = "<b>\uD83E\uDD16 Choose a model:</b>";
export declare const MODEL_PAGE_MENU_TITLE = "<b>Choose a page:</b>";
/** Apply the payload mode to state, then edit the existing menu message in place. */
export declare function editBaleMenuMessage(state: BaleModelMenuState, payload: BaleMenuRenderPayload, deps: BaleMenuMessageRuntimeDeps): Promise<void>;
/** Apply the payload mode to state, then send a fresh menu message to its exact chat/Thread. */
export declare function sendBaleMenuMessage(state: BaleModelMenuState, payload: BaleMenuRenderPayload, deps: BaleMenuMessageRuntimeDeps): Promise<number | undefined>;
export declare function formatScopedModelButtonText<TModel extends MenuModel = MenuModel>(entry: ScopedBaleModel<TModel>, currentModel: TModel | undefined): string;
export declare function formatStatusButtonLabel(label: string, value: string): string;
export declare function getModelMenuItems<TModel extends MenuModel = MenuModel>(state: BaleModelMenuState<TModel>): ScopedBaleModel<TModel>[];
export declare function pruneStoredBaleModelMenus<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredBaleModelMenuState<TModel>>, options: BaleModelMenuStoreOptions): void;
export declare function storeBaleModelMenuState<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredBaleModelMenuState<TModel>>, state: BaleModelMenuState<TModel>, options: BaleModelMenuStoreOptions): void;
export declare function getStoredBaleModelMenuState<TModel extends MenuModel = MenuModel>(menus: Map<string, StoredBaleModelMenuState<TModel>>, messageId: number | undefined, options: BaleModelMenuStoreOptions, chatId?: number): BaleModelMenuState<TModel> | undefined;
export declare function createBaleModelMenuRuntime<TModel extends MenuModel = MenuModel>(options?: Partial<BaleModelMenuStoreOptions>): BaleModelMenuRuntime<TModel>;
export declare function createBaleModelMenuStateBuilder<TModel extends MenuModel = MenuModel, TContext extends BaleModelMenuStateBuilderContext<TModel> = BaleModelMenuStateBuilderContext<TModel>>(deps: BaleModelMenuStateBuilderDeps<TModel, TContext>): (chatId: number, ctx: TContext, threadId?: number) => Promise<BaleModelMenuState<TModel>>;
export declare function resolveCachedBaleModelMenuInputs<TModel extends MenuModel = MenuModel>(cachedInputs: CachedBaleModelMenuInputs<TModel> | undefined, deps: BaleModelMenuInputCacheDeps<TModel>): Promise<CachedBaleModelMenuInputs<TModel>>;
export declare function buildBaleModelMenuState<TModel extends MenuModel = MenuModel>(params: BuildBaleModelMenuStateParams<TModel>): BaleModelMenuState<TModel>;
export declare function buildBaleModelMenuStateRuntime<TContext extends BaleModelMenuRuntimeContext<TModel>, TModel extends MenuModel = MenuModel>(options: BaleModelMenuRuntimeOptions<TContext, TModel>): Promise<{
    state: BaleModelMenuState<TModel>;
    cachedInputs: CachedBaleModelMenuInputs<TModel>;
}>;
export declare function applyBaleModelScopeSelection(state: BaleModelMenuState, value: string | undefined): BaleMenuMutationResult;
export declare function applyBaleModelPageSelection(state: BaleModelMenuState, value: string | undefined): BaleMenuMutationResult;
export declare function getBaleModelSelection<TModel extends MenuModel = MenuModel>(state: BaleModelMenuState<TModel>, value: string | undefined): BaleMenuSelectionResult<TModel>;
export declare function buildBaleModelCallbackPlan<TModel extends MenuModel = MenuModel>(params: BuildBaleModelCallbackPlanParams<TModel>): BaleModelCallbackPlan<TModel>;
export declare function openBaleModelMenu<TModel extends MenuModel = MenuModel>(deps: BaleModelMenuOpenDeps<TModel>): Promise<void>;
export declare function handleBaleModelMenuCallbackAction<TModel extends MenuModel = MenuModel>(callbackQueryId: string, params: BuildBaleModelCallbackPlanParams<TModel>, deps: BaleModelMenuCallbackDeps<TModel>): Promise<boolean>;
export declare function getBaleModelMenuPage(state: BaleModelMenuState, pageSize: number): BaleModelMenuPage;
export declare function buildModelMenuReplyMarkup(state: BaleModelMenuState, currentModel: MenuModel | undefined, pageSize: number): BaleReplyMarkup;
export declare function buildModelPageMenuReplyMarkup(state: BaleModelMenuState, pageSize: number): BaleReplyMarkup;
export declare function buildBaleModelPageMenuRenderPayload(state: BaleModelMenuState): BaleMenuRenderPayload;
export declare function buildBaleModelMenuRenderPayload(state: BaleModelMenuState, activeModel: MenuModel | undefined): BaleMenuRenderPayload;
export declare function updateBaleModelMenuMessage(state: BaleModelMenuState, activeModel: MenuModel | undefined, deps: BaleMenuMessageRuntimeDeps): Promise<void>;
export declare function sendBaleModelMenuMessage(state: BaleModelMenuState, activeModel: MenuModel | undefined, deps: BaleMenuMessageRuntimeDeps): Promise<number | undefined>;
