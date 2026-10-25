/**
 * Bale status menu UI helpers
 * Zones: bale ui, status controls, menu composition
 * Owns status-menu payloads, status callback handling, and status-menu message rendering
 */
import { type BaleMenuMessageRuntimeDeps, type BaleMenuRenderPayload, type BaleModelMenuState, type BaleReplyMarkup } from "./menu-model.ts";
import { type MenuModel, type ThinkingLevel } from "./model.ts";
import { type BaleSectionRegistry } from "./sections.ts";
export interface BaleStatusMenuCallbackDeps {
    updateModelMenuMessage: () => Promise<void>;
    updateThinkingMenuMessage: () => Promise<void>;
    updateSettingsMenuMessage?: () => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    isVoiceReplyActive?: () => boolean;
}
export interface BaleStatusMenuOpenDeps<TModel extends MenuModel = MenuModel> {
    isIdle: () => boolean;
    sendBusyMessage: () => Promise<void>;
    getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
    buildStatusHtml: () => string;
    getActiveModel: () => TModel | undefined;
    getThinkingLevel: () => ThinkingLevel;
    getQueueItemCount?: () => number;
    sendStatusMenu: (state: BaleModelMenuState<TModel>, statusHtml: string, activeModel: TModel | undefined, thinkingLevel: ThinkingLevel, queueItemCount: number) => Promise<number | undefined>;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}
export declare function openBaleStatusMenu<TModel extends MenuModel = MenuModel>(deps: BaleStatusMenuOpenDeps<TModel>): Promise<void>;
export declare function handleBaleStatusMenuCallbackAction(callbackQueryId: string, data: string | undefined, activeModel: MenuModel | undefined, deps: BaleStatusMenuCallbackDeps): Promise<boolean>;
export declare function buildStatusReplyMarkup(activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, queueItemCount?: number, sectionRegistry?: BaleSectionRegistry, isVoiceReplyActive?: boolean, pendingCancellationCount?: number): BaleReplyMarkup;
export declare function buildBaleStatusMenuRenderPayload(statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, queueItemCount?: number, sectionRegistry?: BaleSectionRegistry, isVoiceReplyActive?: boolean, pendingCancellationCount?: number): BaleMenuRenderPayload;
export declare function updateBaleStatusMessage(state: BaleModelMenuState, statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, deps: BaleMenuMessageRuntimeDeps, queueItemCount?: number, sectionRegistry?: BaleSectionRegistry, isVoiceReplyActive?: boolean, pendingCancellationCount?: number): Promise<void>;
export declare function sendBaleStatusMessage(state: BaleModelMenuState, statusText: string, activeModel: MenuModel | undefined, currentThinkingLevel: ThinkingLevel, deps: BaleMenuMessageRuntimeDeps, queueItemCount?: number, sectionRegistry?: BaleSectionRegistry, isVoiceReplyActive?: boolean, pendingCancellationCount?: number): Promise<number | undefined>;
