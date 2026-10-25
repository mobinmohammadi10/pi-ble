/**
 * Bale Extension Sections registry and callback routing
 * Zones: bale ui, extension platform, callback routing
 * Owns section registration, global registry binding, token mapping, main-menu/settings row injection, and section callback dispatch
 */
import { type BaleInlineKeyboardMarkup } from "./keyboard.ts";
import type { BaleInputRichMessage } from "./bale-api.ts";
/** @internal */
export type BaleSectionId = string;
/** @internal */
export type BaleSectionToken = string;
/** @internal */
export type BaleSectionCallbackResult = "handled" | "pass";
export interface BaleSectionView {
    text: string;
    /**
     * Source format for extension-provided section content.
     * Defaults to "html" for explicit Bale UI markup; use "markdown"
     * when a section naturally owns Markdown content, or "plain" for text.
     */
    parseMode?: "markdown" | "html" | "plain";
    replyMarkup?: BaleInlineKeyboardMarkup;
}
export interface BaleSectionSettingsRegistration {
    label: string;
    order?: number;
    getLabel?: () => string;
    open: (ctx: BaleSectionContext) => BaleSectionView | Promise<BaleSectionView>;
    handleCallback?: (ctx: BaleSectionCallbackContext) => BaleSectionCallbackResult | Promise<BaleSectionCallbackResult>;
}
export interface BaleSectionRegistration {
    id: BaleSectionId;
    label: string;
    order?: number;
    getLabel?: () => string;
    render: (ctx: BaleSectionContext) => BaleSectionView | Promise<BaleSectionView>;
    handleCallback?: (ctx: BaleSectionCallbackContext) => BaleSectionCallbackResult | Promise<BaleSectionCallbackResult>;
    settings?: BaleSectionSettingsRegistration;
}
export interface BaleSectionContext {
    sectionId: string;
    chatId: number;
    messageId?: number;
    answerCallback(text?: string): Promise<void>;
    edit(view: BaleSectionView): Promise<void>;
    open(view: BaleSectionView): Promise<void>;
    openRich(message: BaleInputRichMessage): Promise<void>;
    enqueuePrompt(prompt: string): Promise<void>;
    callbackData(action: string, payload?: string): string;
    /** Delete the message that triggered this callback (dialog cleanup) */
    deleteMessage(): Promise<void>;
}
export interface BaleSectionCallbackContext extends BaleSectionContext {
    action: string;
    payload: string;
}
/** @internal */
export interface RegisteredBaleSection {
    id: BaleSectionId;
    token: BaleSectionToken;
    label: string;
    order: number;
    registration: BaleSectionRegistration;
}
/** @internal */
export interface BaleSectionDiagnostic {
    id: BaleSectionId;
    token: BaleSectionToken;
    label: string;
    status: "active" | "error";
    lastError?: string;
}
/** @internal */
export interface BaleSectionRegistry {
    register(section: BaleSectionRegistration): () => void;
    getSections(): RegisteredBaleSection[];
    getByToken(token: BaleSectionToken): RegisteredBaleSection | undefined;
    getDiagnostics(): BaleSectionDiagnostic[];
    recordError(token: BaleSectionToken, message: string, source?: string): void;
    clearError(token: BaleSectionToken, source?: string): void;
    clear(): void;
}
/** @internal */
export interface BaleSectionMainMenuRow {
    text: string;
    callback_data: string;
}
/** @internal */
export interface BaleSectionSettingsRow {
    label: string;
    callback_data: string;
}
/** @internal */
export interface BaleSectionTarget {
    chatId: number;
    threadId?: number;
}
/** @internal */
export interface BaleSectionRuntimeDeps {
    answerCallbackQuery: (id: string, text?: string) => Promise<void>;
    target?: BaleSectionTarget;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleInlineKeyboardMarkup) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: "markdown" | "html" | "plain", replyMarkup: BaleInlineKeyboardMarkup, options?: {
        target?: BaleSectionTarget;
    }) => Promise<number | undefined>;
    sendRichMessage: (chatId: number, message: BaleInputRichMessage, options?: {
        target?: BaleSectionTarget;
    }) => Promise<number | undefined>;
    enqueuePrompt: (prompt: string) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
}
/** @internal */
export declare function createAndBindBaleSectionRegistry(): BaleSectionRegistry;
/**
 * Register a Bale Extension Section from any pi extension.
 * Returns a disposer. Throws if no section registry is active.
 */
export declare function registerBaleSection(section: BaleSectionRegistration): () => void;
/**
 * Get current section diagnostics. Returns empty array when registry is absent.
 * @internal
 */
export declare function getBaleSectionDiagnostics(): BaleSectionDiagnostic[];
/** @internal */
export declare function createBaleExtensionSectionRegistry(): BaleSectionRegistry;
/** @internal */
export declare function getBaleExtensionSettingsRows(registry: BaleSectionRegistry): BaleSectionSettingsRow[];
/** @internal */
export declare function getBaleSectionMainMenuRows(registry: BaleSectionRegistry): BaleSectionMainMenuRow[];
/** @internal */
export declare function parseBaleSectionCallback(data: string): {
    token: string;
    action: string;
    payload: string;
} | undefined;
export declare function handleBaleSectionOpen(registry: BaleSectionRegistry, token: BaleSectionToken, chatId: number, messageId: number, callbackQueryId: string, deps: BaleSectionRuntimeDeps): Promise<boolean>;
export declare function handleBaleSectionCallback(registry: BaleSectionRegistry, token: BaleSectionToken, action: string, payload: string, chatId: number, messageId: number, callbackQueryId: string, deps: BaleSectionRuntimeDeps): Promise<boolean>;
export declare function handleBaleSectionSettingsOpen(registry: BaleSectionRegistry, token: BaleSectionToken, chatId: number, messageId: number, callbackQueryId: string, deps: BaleSectionRuntimeDeps): Promise<boolean>;
