/**
 * Bale turn-building helpers
 * Zones: bale inbound, pi agent prompt content, queue
 * Owns prompt-turn summary and content construction so queued Bale turns are assembled consistently
 */
import { type DownloadedBaleMessageFile, type DownloadBaleMessageFilesDeps, type BaleMediaMessage } from "./media.ts";
import { truncateBaleQueueSummary, type PendingBaleTurn, type BalePreparedPromptTurn, type BaleQueueItem, type BaleQueueStore } from "./queue.ts";
import { type BaleVoiceReplyMode } from "./voice.ts";
export declare const BALE_PREFIX = "[bale]";
/** A routed source keeps its unique message/file/group identity, but cannot quote an anchor in its former tab. */
export declare function withoutBaleTurnReplyAnchor<TMessage extends object>(message: TMessage): TMessage;
/** A confirmed same-target copy may replace the former-tab suppression on a warm input projection. */
export declare function withBaleTurnReplyAnchor<TMessage extends {
    message_id: number;
}>(message: TMessage): TMessage;
export declare const BALE_GUEST_TURN_NOTE = "[guest] delivery: answer quickly with one concise, self-contained reply";
export interface BaleTurnTarget {
    chatId: number;
    threadId?: number;
}
export interface BaleTurnMessage {
    message_id: number;
    message_thread_id?: number;
    pi_bale_agent_source_thread?: string;
    pi_bale_source_update_id?: number;
    chat: {
        id: number;
        type?: string;
    };
}
export type DownloadedBaleTurnFile = DownloadedBaleMessageFile;
export declare function createBaleTurnPrefix(attributes?: Record<string, string | undefined>): string;
export { truncateBaleQueueSummary };
export declare function formatBaleTurnStatusSummary(rawText: string, files: DownloadedBaleTurnFile[], handlerOutputs?: string[]): string;
export declare function buildBaleTurnPrompt(options: {
    balePrefix: string;
    rawText: string;
    files: DownloadedBaleTurnFile[];
    promptFiles?: DownloadedBaleTurnFile[];
    displayFiles?: DownloadedBaleTurnFile[];
    handlerOutputs?: string[];
    sourceContext?: string;
    historyTurns?: Pick<PendingBaleTurn, "historyText">[];
    timeLine?: string | null;
    voiceContext?: Record<string, string>;
    guestTurn?: boolean;
}): string;
export declare function updateBalePromptTurnText(options: {
    turn: PendingBaleTurn;
    balePrefix: string;
    rawText: string;
    statusText?: string;
}): PendingBaleTurn;
export declare function updateQueuedBalePromptTurnText<TContext = unknown>(options: {
    items: BaleQueueItem<TContext>[];
    sourceMessageId: number | undefined;
    balePrefix: string;
    rawText: string;
    statusText?: string;
}): {
    items: BaleQueueItem<TContext>[];
    changed: boolean;
};
export interface BaleQueuedPromptEditRuntimeDeps<TContext = unknown> extends BaleQueueStore<TContext> {
    updateStatus: (ctx: TContext) => void;
}
export declare function createBaleQueuedPromptEditRuntime<TMessage extends BaleMediaMessage, TContext = unknown>(deps: BaleQueuedPromptEditRuntimeDeps<TContext>): {
    updateFromEditedMessage: (message: TMessage, ctx: TContext) => boolean;
};
export interface BuildBalePromptTurnOptions {
    balePrefix: string;
    messages: BaleTurnMessage[];
    historyTurns?: PendingBaleTurn[];
    queueOrder: number;
    rawText: string;
    statusText?: string;
    files: DownloadedBaleTurnFile[];
    promptFiles?: DownloadedBaleTurnFile[];
    displayFiles?: DownloadedBaleTurnFile[];
    handlerOutputs?: string[];
    sourceContext?: string;
    timeLine?: string | null;
    readBinaryFile: (path: string) => Promise<Uint8Array>;
    inferImageMimeType: (path: string) => string | undefined;
    voiceReplyMode?: BaleVoiceReplyMode;
    voicePromptContribution?: string;
    admissionScope?: string;
    admissionJournalBinding?: string;
}
export type BuildBalePromptTurnRuntimeOptions = Omit<BuildBalePromptTurnOptions, "readBinaryFile">;
export interface BalePromptTurnRuntimeBuilderDeps<TContext = unknown> extends DownloadBaleMessageFilesDeps {
    allocateQueueOrder: () => number;
    processAttachments?: (files: DownloadedBaleTurnFile[], rawText: string, ctx: TContext) => Promise<{
        rawText: string;
        promptFiles?: DownloadedBaleTurnFile[];
        handlerOutputs?: string[];
    }>;
    resolveTimeLine?: (chatId: number) => string | null;
    getVoiceReplyMode?: () => BaleVoiceReplyMode;
    /** Returns the visible thread label for a message target, used to add thread context to the prompt prefix. */
    getBaleThreadLabel?: (message: {
        chat: {
            id: number;
        };
        message_thread_id?: number;
    }) => string | undefined;
    getAllowedUserId?: () => number | undefined;
    getAdmissionScope?: () => string | undefined;
    getAdmissionJournalBinding?: () => string | undefined;
    assertExecutionCurrent?: (message: BaleTurnMessage) => void;
}
export declare function createBalePromptTurnRuntimePreparer<TMessage extends BaleTurnMessage & BaleMediaMessage, TContext = unknown>(deps: BalePromptTurnRuntimeBuilderDeps<TContext>): (messages: TMessage[], ctx?: TContext) => Promise<BalePreparedPromptTurn>;
export declare function buildBalePromptTurn(options: BuildBalePromptTurnOptions): Promise<PendingBaleTurn>;
export declare function buildBalePromptTurnRuntime(options: BuildBalePromptTurnRuntimeOptions): Promise<PendingBaleTurn>;
