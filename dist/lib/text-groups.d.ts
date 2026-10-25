/**
 * Bale text-group coalescing helpers
 * Zones: bale inbound, queue admission, split-message recovery
 * Owns conservative delayed grouping for Bale text messages that look like automatic long-message splits
 */
import { type BaleMessageForwardOrigin, type BaleMessageUser, type BaleRichMessage } from "./media.ts";
export interface BaleTextGroupMessage {
    message_id: number;
    media_group_id?: string;
    chat: {
        id: number;
    };
    message_thread_id?: number;
    from?: {
        id?: number;
        is_bot?: boolean;
    };
    text?: string;
    caption?: string;
    rich_message?: BaleRichMessage;
    forward_origin?: BaleMessageForwardOrigin;
    forward_from?: BaleMessageUser;
    forward_sender_name?: string;
}
export type BaleForwardCommentBatchPosition = "comment" | "forward";
export interface BaleTextGroupController<TMessage, TContext = unknown> {
    prepareUpdateBatch: (updates: readonly {
        message?: TMessage;
    }[]) => void;
    getPreparedForwardingPosition: (message: BaleTextGroupMessage) => BaleForwardCommentBatchPosition | undefined;
    prepareForwardedMessage: (message: BaleTextGroupMessage, position: BaleForwardCommentBatchPosition) => void;
    queueMessage: (options: {
        message: TMessage;
        context: TContext;
        dispatchMessages: (messages: TMessage[], ctx: TContext) => unknown | Promise<unknown>;
    }) => boolean;
    flushMessage: (messageId: number) => Promise<boolean>;
    suspend: () => void;
    resume: (context: TContext) => void;
    clear: () => void;
}
export interface BaleTextGroupControllerOptions {
    debounceMs?: number;
    forwardCommentWaitMs?: number | false;
    minSplitLength?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface BaleTextGroupDispatchRuntime<TMessage extends BaleTextGroupMessage, TContext> {
    handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}
export interface BaleGroupedInputClearerDeps {
    clearMediaGroups: () => void;
    clearTextGroups: () => void;
}
export declare function createBaleTextGroupController<TMessage extends BaleTextGroupMessage, TContext = unknown>(options?: BaleTextGroupControllerOptions): BaleTextGroupController<TMessage, TContext>;
export declare function createBaleTextGroupDispatchRuntime<TMessage extends BaleTextGroupMessage, TContext>(deps: {
    textGroups: BaleTextGroupController<TMessage, TContext>;
    dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
    dispatchSingleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
    onDeferredMessage?: (message: TMessage) => void;
}): BaleTextGroupDispatchRuntime<TMessage, TContext>;
export declare function createBaleGroupedInputClearer(deps: BaleGroupedInputClearerDeps): () => void;
