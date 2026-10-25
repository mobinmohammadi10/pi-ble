/**
 * Bale queue menu UI helpers
 * Zones: bale ui, queue controls, menu composition
 * Owns queue-menu rendering, queue item callbacks, and queue-menu runtime adapters while core queue mechanics stay in queue
 */
import type { BaleInlineKeyboardMarkup } from "./keyboard.ts";
import { type BaleMenuMessageRuntimeDeps, type BaleModelMenuState } from "./menu-model.ts";
import type { MenuModel } from "./model.ts";
import * as Queue from "./queue.ts";
import type { BaleApiCallOptions } from "./bale-api.ts";
type BaleQueueMenuReplyMarkup = BaleInlineKeyboardMarkup;
interface BaleQueueMenuCallbackQuery {
    id: string;
    data?: string;
    message?: {
        chat?: {
            id?: number;
        };
        message_id?: number;
    };
}
interface BaleQueueMenuRuntime<Context> {
    openQueueMenu: (chatId: number, replyToMessageId: number, ctx: Context, threadId?: number, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    handleCallbackQuery: (query: BaleQueueMenuCallbackQuery, ctx: Context) => Promise<boolean>;
}
export declare function createBaleQueueMenuRuntime<Context, TModel extends MenuModel = MenuModel>(deps: {
    hasPendingDispatch?: () => boolean;
    baleQueueStore: Queue.BaleQueueStateStore<Context>;
    queueMutationRuntime: Queue.BaleQueueMutationController<Context>;
    sendInteractiveMessage: BaleMenuMessageRuntimeDeps["sendInteractiveMessage"];
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: "html", replyMarkup: BaleQueueMenuReplyMarkup) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string) => Promise<void>;
    getModelMenuState: (chatId: number, ctx: Context, threadId?: number) => Promise<BaleModelMenuState<TModel>>;
    getStoredModelMenuState: (messageId: number | undefined, chatId?: number) => BaleModelMenuState<TModel> | undefined;
    storeModelMenuState: (state: BaleModelMenuState<TModel>) => void;
    updateStatusMessage: (state: BaleModelMenuState<TModel>, ctx: Context) => Promise<void>;
    updateStatus: (ctx: Context) => void;
    dismissGuestPlaceholder?: (inlineMessageId: string) => Promise<void>;
}): BaleQueueMenuRuntime<Context>;
export {};
