/**
 * Bale media and text extraction helpers
 * Zones: bale inbound, media groups, filesystem paths
 * Normalizes inbound Bale messages into reusable file, text, id, history, and media-group metadata
 */
import * as Machine from "./machine.ts";
export interface BalePhotoSize {
    file_id: string;
    file_size?: number;
}
export interface BaleDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
}
export type BaleVideo = BaleDocument;
export type BaleAudio = BaleDocument;
export type BaleAnimation = BaleDocument;
export interface BaleVoice {
    file_id: string;
    mime_type?: string;
}
export interface BaleRichMessage {
    blocks?: unknown[];
}
export interface BaleMessageUser {
    id?: number;
    is_bot?: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
}
export interface BaleMessageForwardOrigin {
    type?: string;
    sender_user?: BaleMessageUser;
    sender_user_name?: string;
    sender_chat?: {
        title?: string;
        username?: string;
        id?: number;
    };
    chat?: {
        title?: string;
        username?: string;
        id?: number;
    };
    author_signature?: string;
}
export interface BaleReplyToMessage {
    message_id?: number;
    from?: BaleMessageUser;
    text?: string;
    caption?: string;
    rich_message?: BaleRichMessage;
    photo?: BalePhotoSize[];
    document?: BaleDocument;
    video?: BaleVideo;
    audio?: BaleAudio;
    voice?: BaleVoice;
    animation?: BaleAnimation;
    sticker?: BaleSticker;
}
export interface BaleSticker {
    file_id: string;
    is_video?: boolean;
    is_animated?: boolean;
}
export interface BaleMediaMessage {
    message_id: number;
    chat?: {
        id: number;
        type?: string;
        username?: string;
    };
    from?: BaleMessageUser;
    forward_origin?: BaleMessageForwardOrigin;
    forward_from?: BaleMessageUser;
    forward_sender_name?: string;
    text?: string;
    caption?: string;
    rich_message?: BaleRichMessage;
    reply_to_message?: BaleReplyToMessage;
    media_group_id?: string;
    photo?: BalePhotoSize[];
    document?: BaleDocument;
    video?: BaleVideo;
    audio?: BaleAudio;
    voice?: BaleVoice;
    animation?: BaleAnimation;
    sticker?: BaleSticker;
}
export interface BaleMediaGroupMessage {
    message_id: number;
    chat: {
        id: number;
    };
    message_thread_id?: number;
    media_group_id?: string;
}
export interface BaleMediaGroupController<TMessage extends BaleMediaGroupMessage, TContext = unknown> {
    queueMessage: (options: {
        message: TMessage;
        context?: TContext;
        dispatchMessages: (messages: TMessage[], ctx?: TContext) => unknown | Promise<unknown>;
    }) => boolean;
    removeMessages: (messageIds: number[]) => number;
    flushMessage: (messageId: number) => Promise<boolean>;
    suspend: () => void;
    resume: (context: TContext) => void;
    clear: () => void;
}
export interface BaleMediaGroupDispatchRuntimeDeps<TMessage extends BaleMediaGroupMessage, TContext> {
    mediaGroups: BaleMediaGroupController<TMessage, TContext>;
    dispatchMessages: (messages: TMessage[], ctx: TContext) => Promise<void>;
    onDeferredMessage?: (message: TMessage) => void;
}
export interface BaleMediaGroupDispatchRuntime<TMessage extends BaleMediaGroupMessage, TContext> {
    handleMessage: (message: TMessage, ctx: TContext) => Promise<void>;
}
export interface BaleMediaGroupControllerOptions {
    debounceMs?: number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export type BaleAttachmentKind = "photo" | "document" | "video" | "audio" | "voice" | "animation" | "sticker";
/** Where an inbound attachment came from; the download layer turns it into a scoped file name. */
export interface BaleAttachmentSource {
    kind: string;
    messageId: number;
    index?: number;
    /** Sender-chosen file name, kept as a trailing readable segment. */
    userFileName?: string;
    chat?: {
        id: number;
        type?: string;
        username?: string;
    };
    /** Explicit source scope, e.g. a Guest Mode peer whose message IDs are not the bot chat's. */
    scope?: string;
}
export interface BaleFileInfo {
    file_id: string;
    fileName: string;
    /** Present only when the sender chose the name. */
    userFileName?: string;
    /** Position inside a rich message. */
    index?: number;
    source?: BaleAttachmentSource;
    mimeType?: string;
    kind: BaleAttachmentKind;
    isImage: boolean;
}
export interface DownloadedBaleFile {
    path: string;
    fileName?: string;
    isImage?: boolean;
    mimeType?: string;
    kind?: BaleAttachmentKind;
}
export interface DownloadedBaleMessageFile {
    path: string;
    fileName: string;
    isImage: boolean;
    mimeType?: string;
    kind?: BaleAttachmentKind;
}
export interface DownloadBaleMessageFilesDeps {
    downloadFile: (fileId: string, fileName: string, source?: BaleAttachmentSource) => Promise<string>;
}
export declare function guessMediaType(path: string): string | undefined;
export declare function extractBaleMessageText(message: BaleMediaMessage): string;
export declare function extractBaleForwardContextText(message: BaleMediaMessage, allowedUserId?: number): string;
export declare function buildBaleReplyContextBlock(message: BaleMediaMessage, replyFiles?: Pick<DownloadedBaleFile, "path">[], replyOutputs?: readonly string[]): string;
export declare function extractBaleMessagesText(messages: BaleMediaMessage[]): string;
export declare function extractBaleMessagesPromptText(messages: BaleMediaMessage[]): string;
export declare function extractFirstBaleMessageText(messages: BaleMediaMessage[]): string;
export declare function hasBaleMessagesPromptContent(messages: BaleMediaMessage[]): boolean;
export declare function collectBaleMessageIds(messages: BaleMediaMessage[]): number[];
export declare function getBaleMediaGroupKey(message: BaleMediaGroupMessage): string | undefined;
/** One pending input group; only `transitionBalePendingGroups` produces a new one. */
export interface BalePendingGroup<TMessage, TContext, TMeta = undefined> {
    readonly messages: readonly TMessage[];
    readonly context?: TContext;
    /** Domain data carried with the group, such as a text group's forward-comment pairing side. */
    readonly meta?: TMeta;
    readonly timerId: number | null;
    /** The batch in flight; its messages leave the group only once that exact dispatch succeeds. */
    readonly dispatch: {
        readonly id: number;
        readonly messageIds: readonly number[];
    } | null;
    readonly suspended: boolean;
    /** The next batch ends at this message, so later messages wait for the batch after it, whatever is in flight. */
    readonly boundaryId?: number;
}
export interface BalePendingGroupsState<TMessage, TContext, TMeta> {
    readonly groups: ReadonlyMap<string, BalePendingGroup<TMessage, TContext, TMeta>>;
    readonly nextTimerId: number;
    readonly nextDispatchId: number;
}
export interface BalePendingGroupsConfig {
    debounceMs: number;
    /** A group without a context waits (text) instead of dispatching without one (media). */
    requireContext: boolean;
}
export type BalePendingGroupsEvent<TMessage, TContext, TMeta> = {
    type: "queued";
    key: string;
    message: TMessage;
    context?: TContext;
    meta?: TMeta;
    delayMs: number;
    /** `always` restarts the debounce; `ifIdle` arms it only when no timer, dispatch or suspension holds it. */
    rearm: "always" | "ifIdle";
}
/** Ends the next batch at the group's current last message; later messages wait for the batch after it. */
 | {
    type: "batchClosed";
    key: string;
} | {
    type: "timerFired";
    key: string;
    timerId: number;
} | {
    type: "dispatchSettled";
    key: string;
    dispatchId: number;
    ok: boolean;
} | {
    type: "flushRequested";
    key: string;
} | {
    type: "suspended";
} | {
    type: "resumed";
    context: TContext;
} | {
    type: "removed";
    messageIds: readonly number[];
} | {
    type: "keyCleared";
    key: string;
} | {
    type: "cleared";
};
export type BalePendingGroupsEffect<TMessage, TContext> = {
    type: "armTimer";
    key: string;
    timerId: number;
    delayMs: number;
} | {
    type: "cancelTimer";
    timerId: number;
} | {
    type: "dispatch";
    key: string;
    dispatchId: number;
    messages: TMessage[];
    context?: TContext;
};
export interface BalePendingGroupsStep<TMessage, TContext, TMeta> extends Machine.BaleMachineStep<BalePendingGroupsState<TMessage, TContext, TMeta>, BalePendingGroupsEffect<TMessage, TContext>> {
    /** `removed`: how many groups were dropped. */
    result: number;
}
export declare function createBalePendingGroupsState<TMessage, TContext, TMeta = undefined>(): BalePendingGroupsState<TMessage, TContext, TMeta>;
/**
 * Pure transition for delayed input groups shared by media albums and split text. A group dispatches one batch at a
 * time; messages that arrive meanwhile wait for the next batch, a failure keeps the batch for a retry, and suspension
 * keeps every admitted message for the replacement context.
 */
export declare function transitionBalePendingGroups<TMessage extends {
    message_id: number;
}, TContext, TMeta>(state: BalePendingGroupsState<TMessage, TContext, TMeta>, event: BalePendingGroupsEvent<TMessage, TContext, TMeta>, config: BalePendingGroupsConfig): BalePendingGroupsStep<TMessage, TContext, TMeta>;
export interface BalePendingGroups<TMessage, TContext, TMeta> {
    /** Read-only view of one group; it never grants mutation. */
    get: (key: string) => BalePendingGroup<TMessage, TContext, TMeta> | undefined;
    queue: (event: Omit<Extract<BalePendingGroupsEvent<TMessage, TContext, TMeta>, {
        type: "queued";
    }>, "type"> & {
        dispatchMessages: (messages: TMessage[], ctx?: TContext) => unknown | Promise<unknown>;
    }) => void;
    clearKey: (key: string) => void;
    closeBatch: (key: string) => void;
    removeMessages: (messageIds: number[]) => number;
    /** Dispatches the group holding this message now; resolves once its batch settles, rejecting if it failed. */
    flushMessage: (messageId: number) => Promise<boolean>;
    suspend: () => void;
    resume: (context: TContext) => void;
    clear: () => void;
}
/**
 * The shell around `transitionBalePendingGroups`: it owns timer handles and each key's latest dispatcher, turns
 * every dispatch outcome, including a synchronous throw, into `dispatchSettled`, and keeps each batch's promise for
 * flush callers.
 */
export declare function createBalePendingGroups<TMessage extends {
    message_id: number;
}, TContext, TMeta = undefined>(options: {
    debounceMs: number;
    requireContext: boolean;
    setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
}): BalePendingGroups<TMessage, TContext, TMeta>;
export declare function createBaleMediaGroupController<TMessage extends BaleMediaGroupMessage, TContext = unknown>(options?: BaleMediaGroupControllerOptions): BaleMediaGroupController<TMessage, TContext>;
export declare function createBaleMediaGroupDispatchRuntime<TMessage extends BaleMediaGroupMessage, TContext>(deps: BaleMediaGroupDispatchRuntimeDeps<TMessage, TContext>): BaleMediaGroupDispatchRuntime<TMessage, TContext>;
/** Pure `[title]` bullet section appended after a blank line; empty items leave text unchanged. */
export declare function appendBaleListSection(text: string, title: string, items: string[]): string;
export declare function appendBaleAttachmentSection(text: string, files: Pick<DownloadedBaleFile, "path">[]): string;
export declare function formatBaleHistoryText(rawText: string, files: DownloadedBaleFile[], handlerOutputs?: string[]): string;
export declare function downloadBaleMessageFiles(messages: BaleMediaMessage[], deps: DownloadBaleMessageFilesDeps): Promise<DownloadedBaleMessageFile[]>;
export declare function collectBaleFileInfos(messages: BaleMediaMessage[]): BaleFileInfo[];
