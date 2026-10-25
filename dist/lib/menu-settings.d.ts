/**
 * Bale settings menu UI helpers
 * Zones: bale ui, settings controls, menu composition
 * Owns hidden settings-menu rendering, settings callbacks, and persisted toggle wiring
 */
import type { BaleActivityVerbosity, BaleAssistantRenderingMode, BaleThreadDisplayMode, BaleTimeMode } from "./config.ts";
import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import { type BaleMenuMessageRuntimeDeps, type BaleModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import { type BaleSectionRegistry } from "./sections.ts";
import type { BaleApiCallOptions } from "./bale-api.ts";
import type { BaleVoiceReplyMode } from "./voice.ts";
export type BaleSettingsMenuReplyMarkup = BaleInlineKeyboardMarkup;
export interface BaleSettingsStateDeps {
    getThreadDisplayMode?: () => BaleThreadDisplayMode | undefined;
    isThreadDisplayCustom?: () => boolean;
    areDraftPreviewsEnabled: () => boolean;
    getAssistantRenderingMode: () => BaleAssistantRenderingMode;
    getActivityVerbosity: () => BaleActivityVerbosity;
    getTimeInjectionMode: () => BaleTimeMode;
    getVoiceReplyMode: () => BaleVoiceReplyMode;
    isVoiceReplyModeConfigured: () => boolean;
    isAutomaticThreadCleanupEnabled: () => boolean;
}
export interface BaleSettingsMutationDeps extends BaleSettingsStateDeps {
    setThreadDisplayMode?: (mode: BaleThreadDisplayMode) => Promise<void>;
    setDraftPreviewsEnabled: (enabled: boolean) => Promise<void>;
    setAssistantRenderingMode: (mode: BaleAssistantRenderingMode) => Promise<void>;
    setActivityVerbosity: (verbosity: BaleActivityVerbosity) => Promise<void>;
    setVoiceReplyMode: (mode: BaleVoiceReplyMode | undefined) => Promise<void>;
    setTimeInjectionMode: (mode: BaleTimeMode) => Promise<void>;
    setAutomaticThreadCleanupEnabled: (enabled: boolean) => Promise<void>;
    reviewInactiveThreads?: () => Promise<{
        count: number;
        operationId?: string;
    }>;
    cleanInactiveThreads?: (operationId: string) => Promise<{
        deleted: number;
        outcomeUnknown: number;
        blocked?: number;
        recovery?: "commit-ready" | "deletion-outcome-unknown" | "authority-blocked";
    }>;
}
export interface BaleSettingsMenuOpenDeps<TModel extends MenuModel = MenuModel> extends BaleSettingsStateDeps {
    getModelMenuState: () => Promise<BaleModelMenuState<TModel>>;
    sendSettingsMenu: (state: BaleModelMenuState<TModel>, text: string, replyMarkup: BaleSettingsMenuReplyMarkup) => Promise<number | undefined>;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
}
export interface BaleSettingsMenuCallbackDeps extends BaleSettingsMutationDeps {
    updateSettingsMessage: (text: string, replyMarkup: BaleSettingsMenuReplyMarkup) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    sectionRegistry?: BaleSectionRegistry;
}
export interface BaleSettingsMenuRuntime<TContext> {
    openSettingsMenu: (chatId: number, replyToMessageId: number | undefined, ctx: TContext, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    handleCallbackQuery: (query: {
        id: string;
        data?: string;
        message?: {
            message_id?: number;
            message_thread_id?: number;
            chat?: {
                id?: number;
            };
        };
    }, ctx: TContext) => Promise<boolean>;
    updateSettingsMenuMessage: (state: BaleModelMenuState, ctx: TContext) => Promise<void>;
}
export interface BaleSettingsMenuMessageUpdateDeps extends BaleSettingsStateDeps {
    updateSettingsMessage: (text: string, replyMarkup: BaleSettingsMenuReplyMarkup) => Promise<void>;
}
export interface BaleSettingsMenuRuntimeDeps<TContext, TModel extends MenuModel = MenuModel> extends BaleSettingsMutationDeps {
    reloadConfig?: () => Promise<void>;
    getModelMenuState: (chatId: number, ctx: TContext, threadId?: number) => Promise<BaleModelMenuState<TModel>>;
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => BaleModelMenuState<TModel> | undefined;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleSettingsMenuReplyMarkup) => Promise<void>;
    sendInteractiveMessage: BaleMenuMessageRuntimeDeps["sendInteractiveMessage"];
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
}
export declare function buildBaleSettingsMenuText(): string;
export declare function buildThreadDisplaySettingsText(mode: BaleThreadDisplayMode, custom?: boolean): string;
export declare function buildAutomaticThreadCleanupSettingsText(enabled: boolean): string;
export declare function buildInactiveThreadReviewReplyMarkup(operationId?: string, canCleanInactiveThreads?: boolean): BaleSettingsMenuReplyMarkup;
export declare function buildDraftPreviewsSettingsText(enabled: boolean): string;
export declare function buildAssistantRenderingSettingsText(mode: BaleAssistantRenderingMode): string;
export declare function buildActivityVerbositySettingsText(verbosity: BaleActivityVerbosity): string;
export declare function buildVoiceReplyModeSettingsText(mode: BaleVoiceReplyMode, configured?: boolean): string;
export declare function buildTimeInjectionModeSettingsText(mode: BaleTimeMode): string;
export declare function buildBaleSettingsMenuReplyMarkup(draftPreviewsEnabled: boolean, assistantRenderingModeOrVoiceReplyMode: BaleAssistantRenderingMode | BaleVoiceReplyMode, voiceReplyModeOrTimeInjectionMode: BaleVoiceReplyMode | BaleTimeMode, timeInjectionModeOrSectionRegistry?: BaleTimeMode | BaleSectionRegistry, sectionRegistryOrVoiceReplyModeConfigured?: BaleSectionRegistry | boolean, voiceReplyModeConfigured?: boolean, automaticThreadCleanupEnabled?: boolean, activityVerbosity?: BaleActivityVerbosity, threadDisplayMode?: BaleThreadDisplayMode, threadDisplayCustom?: boolean): BaleSettingsMenuReplyMarkup;
export declare function buildThreadDisplaySettingsReplyMarkup(mode: BaleThreadDisplayMode, custom?: boolean): BaleSettingsMenuReplyMarkup;
export declare function buildAutomaticThreadCleanupSettingsReplyMarkup(enabled: boolean, canReviewInactiveThreads?: boolean): BaleSettingsMenuReplyMarkup;
export declare function buildDraftPreviewsSettingsReplyMarkup(enabled: boolean): BaleSettingsMenuReplyMarkup;
export declare function buildAssistantRenderingSettingsReplyMarkup(mode: BaleAssistantRenderingMode): BaleSettingsMenuReplyMarkup;
export declare function buildActivityVerbositySettingsReplyMarkup(verbosity: BaleActivityVerbosity): BaleSettingsMenuReplyMarkup;
export declare function buildTimeInjectionModeSettingsReplyMarkup(mode: BaleTimeMode): BaleSettingsMenuReplyMarkup;
export declare function buildVoiceReplyModeSettingsReplyMarkup(mode: BaleVoiceReplyMode, configured?: boolean): BaleSettingsMenuReplyMarkup;
export declare function handleBaleSettingsMenuCallbackAction(callbackQueryId: string, data: string | undefined, deps: BaleSettingsMenuCallbackDeps): Promise<boolean>;
export declare function createBaleSettingsMenuRuntime<TContext, TModel extends MenuModel = MenuModel>(deps: BaleSettingsMenuRuntimeDeps<TContext, TModel>, sectionRegistry?: BaleSectionRegistry): BaleSettingsMenuRuntime<TContext>;
