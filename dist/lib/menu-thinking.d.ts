/**
 * Bale thinking menu UI helpers
 * Zones: bale ui, thinking controls, menu composition
 * Owns thinking-menu text, reply markup, callback handling, and thinking-menu message rendering
 */
import { type BaleMenuMessageRuntimeDeps, type BaleMenuRenderPayload, type BaleModelMenuState, type BaleReplyMarkup } from "./menu-model.ts";
import { type MenuModel, type ThinkingLevel } from "./model.ts";
export interface BaleThinkingMenuCallbackDeps {
    setThinkingLevel: (level: ThinkingLevel) => void;
    getCurrentThinkingLevel: () => ThinkingLevel;
    updateThinkingMenuMessage: () => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}
export interface BaleThinkingMenuOpenDeps<TModel extends MenuModel = MenuModel> extends BaleMenuMessageRuntimeDeps {
    getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
    getActiveModel: () => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
    isVoiceReplyActive?: () => boolean;
}
/** Answers and returns true when voice replies or a non-reasoning model disable thinking controls. */
export declare function refuseUnavailableBaleThinkingControls(callbackQueryId: string, activeModel: MenuModel | undefined, deps: {
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}): Promise<boolean>;
export declare function handleBaleThinkingMenuCallbackAction(callbackQueryId: string, data: string | undefined, activeModel: MenuModel | undefined, deps: BaleThinkingMenuCallbackDeps): Promise<boolean>;
export declare function buildThinkingMenuText(): string;
export declare function buildThinkingMenuReplyMarkup(currentThinkingLevel: ThinkingLevel): BaleReplyMarkup;
export declare function buildBaleThinkingMenuRenderPayload(_activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel): BaleMenuRenderPayload;
export declare function openBaleThinkingMenu<TModel extends MenuModel = MenuModel>(deps: BaleThinkingMenuOpenDeps<TModel>): Promise<void>;
export declare function updateBaleThinkingMenuMessage(state: BaleModelMenuState, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, deps: BaleMenuMessageRuntimeDeps & {
    isVoiceReplyActive?: () => boolean;
}): Promise<void>;
