/**
 * Bale outbound button helpers
 * Zones: bale outbound, assistant markup, callback routing
 * Owns assistant-authored bale_button extraction, button action storage, callback handling, and prompt-turn construction
 */
import type { BaleInlineKeyboardButtonStyle, BaleInlineKeyboardMarkup } from "./keyboard.ts";
import { type PendingBaleTurn, type BaleQueueTarget } from "./queue.ts";
export interface BaleOutboundButtonBinding {
    generation: string;
    app: string;
    revision: number;
}
export interface BaleOutboundButtonAction {
    text: string;
    prompt: string;
    binding?: BaleOutboundButtonBinding;
    selectedStyle?: BaleInlineKeyboardButtonStyle;
    disabled?: true;
}
export interface BaleOutboundButtonStoredAction extends BaleOutboundButtonAction {
    createdAt: number;
}
export type BaleOutboundButtonMarkup = BaleInlineKeyboardMarkup;
export interface BaleButtonReplyPlan {
    markdown: string;
    replyMarkup?: BaleOutboundButtonMarkup;
}
export interface BaleButtonActionStore {
    register: (action: BaleOutboundButtonAction) => string;
    resolve: (callbackData: string | undefined) => BaleOutboundButtonAction | undefined;
}
export interface BaleButtonCallbackQuery {
    id: string;
    data?: string;
    message?: {
        message_id?: number;
        message_thread_id?: number;
        chat?: {
            id?: number;
        };
        reply_markup?: BaleOutboundButtonMarkup;
    };
}
export interface BaleButtonCallbackHandlerDeps<TContext = unknown> {
    resolveAction: (callbackData: string | undefined) => BaleOutboundButtonAction | undefined;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    enqueueButtonPrompt: (query: BaleButtonCallbackQuery, action: BaleOutboundButtonAction, ctx: TContext) => boolean | void;
    invokeBoundAction?: (query: BaleButtonCallbackQuery, action: BaleOutboundButtonAction, ctx: TContext) => Promise<false | "new" | "edit">;
    editMessageReplyMarkup?: (chatId: number, messageId: number, replyMarkup: BaleOutboundButtonMarkup) => Promise<void>;
}
export declare function createBaleButtonActionStore(options?: {
    ttlMs?: number;
}): BaleButtonActionStore;
export declare function planBaleButtonReply(markdown: string, deps: {
    registerAction: (action: BaleOutboundButtonAction) => string;
    binding?: BaleOutboundButtonBinding;
    rendering?: "rich" | "html";
}): BaleButtonReplyPlan;
export declare function createBaleButtonReplyPlanner(store: Pick<BaleButtonActionStore, "register">): (markdown: string) => BaleButtonReplyPlan;
export declare function createBaleButtonPromptTurn(options: {
    chatId: number;
    replyToMessageId: number;
    queueOrder: number;
    action: BaleOutboundButtonAction;
    target?: BaleQueueTarget;
    balePrefix?: string;
}): PendingBaleTurn;
export declare function markBaleButtonSelected(replyMarkup: BaleOutboundButtonMarkup, callbackData: string, selectedStyle?: BaleInlineKeyboardButtonStyle): BaleOutboundButtonMarkup | undefined;
export declare function handleBaleButtonCallbackQuery<TContext = unknown>(query: BaleButtonCallbackQuery, ctx: TContext, deps: BaleButtonCallbackHandlerDeps<TContext>): Promise<boolean>;
