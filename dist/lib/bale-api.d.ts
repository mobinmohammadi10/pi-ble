/**
 * Bale API transport helpers
 * Zones: bale transport, filesystem, runtime diagnostics
 *
 * Wraps bot API calls, file uploads/downloads (including voice messages),
 * multipart sending, runtime transport binding, and Bale temp-file lifecycle.
 */
import type { BaleAttachmentSource } from "./media.ts";
export declare const BALE_FILE_MAX_BYTES: number;
/** Bale documents classic chats and Markdown, not private topics or Rich Messages. */
export declare function prepareBaleRequest(method: string, input: Record<string, unknown>): {
    method: string;
    body: Record<string, unknown>;
};
/** First positive safe-integer byte limit among ordered env names, else the caller's default. */
export declare function getBaleByteLimitFromEnv(env: NodeJS.ProcessEnv, names: readonly string[], defaultValue: number): number;
export type BaleNetworkFamilyPolicy = "auto" | "ipv4" | "ipv6" | "ipv4-fallback";
type BaleNetworkFamily = 4 | 6;
export interface BaleUser {
    id: number;
    is_bot: boolean;
    first_name: string;
    username?: string;
}
export interface BaleChat {
    id: number;
    type: string;
}
export interface BalePhotoSize {
    file_id: string;
    file_size?: number;
}
export interface BaleDocument {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface BaleVideo {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface BaleAudio {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface BaleVoice {
    file_id: string;
    mime_type?: string;
    file_size?: number;
}
export interface BaleAnimation {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface BaleSticker {
    file_id: string;
    emoji?: string;
}
export interface BaleRichMessage {
    blocks?: unknown[];
    is_rtl?: boolean;
}
export interface BaleMessage {
    message_id: number;
    chat: BaleChat;
    from?: BaleUser;
    text?: string;
    caption?: string;
    rich_message?: BaleRichMessage;
    media_group_id?: string;
    photo?: BalePhotoSize[];
    document?: BaleDocument;
    video?: BaleVideo;
    audio?: BaleAudio;
    voice?: BaleVoice;
    animation?: BaleAnimation;
    sticker?: BaleSticker;
}
export interface BaleCallbackQuery {
    id: string;
    from: BaleUser;
    message?: BaleMessage;
    data?: string;
}
export interface BaleReactionTypeEmoji {
    type: "emoji";
    emoji: string;
}
export interface BaleReactionTypeCustomEmoji {
    type: "custom_emoji";
    custom_emoji_id: string;
}
export interface BaleReactionTypePaid {
    type: "paid";
}
export type BaleReactionType = BaleReactionTypeEmoji | BaleReactionTypeCustomEmoji | BaleReactionTypePaid;
export interface BaleMessageReactionUpdated {
    chat: BaleChat;
    message_id: number;
    user?: BaleUser;
    actor_chat?: BaleChat;
    old_reaction: BaleReactionType[];
    new_reaction: BaleReactionType[];
    date: number;
}
export interface BaleGuestMessage {
    message_id: number;
    from?: BaleUser;
    chat: BaleChat;
    date: number;
    text?: string;
    caption?: string;
    rich_message?: BaleRichMessage;
    guest_query_id: string;
    guest_bot_caller_user?: BaleUser;
    guest_bot_caller_chat?: BaleChat;
    reply_to_message?: BaleMessage;
}
export interface BaleUpdate {
    update_id: number;
    message?: BaleMessage;
    edited_message?: BaleMessage;
    callback_query?: BaleCallbackQuery;
    message_reaction?: BaleMessageReactionUpdated;
    guest_message?: BaleGuestMessage;
    deleted_business_messages?: {
        message_ids?: unknown;
    };
}
export interface BaleSentMessage {
    message_id: number;
}
export interface BaleSentGuestMessage {
    inline_message_id?: string;
}
export interface BaleReplyParameters {
    message_id: number;
    allow_sending_without_reply?: boolean;
    chat_id?: number;
    message_thread_id?: number;
}
export interface BaleLinkPreviewOptions {
    is_disabled?: boolean;
}
export type BaleSendMessageBody = Record<string, unknown> & {
    chat_id: number;
    text: string;
    parse_mode?: "HTML";
    link_preview_options?: BaleLinkPreviewOptions;
    reply_markup?: unknown;
    reply_parameters?: BaleReplyParameters;
};
export interface BaleInputMediaPhoto extends Record<string, unknown> {
    type: "photo";
    media: string;
    has_spoiler?: boolean;
}
export interface BaleInputMediaVideo extends Record<string, unknown> {
    type: "video";
    media: string;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
    supports_streaming?: boolean;
    has_spoiler?: boolean;
}
export interface BaleInputMediaAnimation extends Record<string, unknown> {
    type: "animation";
    media: string;
    thumbnail?: string;
    width?: number;
    height?: number;
    duration?: number;
    has_spoiler?: boolean;
}
export interface BaleInputMediaAudio extends Record<string, unknown> {
    type: "audio";
    media: string;
    thumbnail?: string;
    duration?: number;
    performer?: string;
    title?: string;
}
export interface BaleInputMediaVoiceNote extends Record<string, unknown> {
    type: "voice_note";
    media: string;
    caption?: string;
    parse_mode?: string;
    caption_entities?: unknown[];
    duration?: number;
}
export type BaleInputRichMessageMediaValue = BaleInputMediaAnimation | BaleInputMediaAudio | BaleInputMediaPhoto | BaleInputMediaVideo | BaleInputMediaVoiceNote;
export interface BaleInputRichMessageMedia {
    id: string;
    media: BaleInputRichMessageMediaValue;
}
type BaleInputRichMessageCommon = {
    is_rtl?: boolean;
    skip_entity_detection?: boolean;
};
export type BaleRichText = string | BaleRichText[] | {
    type: "bold" | "code";
    text: BaleRichText;
};
export type BaleInputRichBlock = {
    type: "heading";
    text: BaleRichText;
    size?: 1 | 2 | 3;
} | {
    type: "pre";
    text: BaleRichText;
    language?: string;
} | {
    type: "details";
    summary: BaleRichText;
    blocks: BaleInputRichBlock[];
    is_open?: true;
};
export type BaleInputRichDraftBlock = BaleInputRichBlock | {
    type: "thinking";
    text: BaleRichText;
};
export type BaleInputRichMessage = BaleInputRichMessageCommon & ({
    markdown: string;
    html?: never;
    blocks?: never;
    media?: BaleInputRichMessageMedia[];
} | {
    html: string;
    markdown?: never;
    blocks?: never;
    media?: BaleInputRichMessageMedia[];
} | {
    blocks: BaleInputRichBlock[];
    markdown?: never;
    html?: never;
    media?: never;
});
export type BaleSendRichMessageBody = Record<string, unknown> & {
    chat_id: number;
    rich_message: BaleInputRichMessage;
    reply_markup?: unknown;
    reply_parameters?: BaleReplyParameters;
};
export type BaleEditMessageTextBody = Record<string, unknown> & {
    chat_id: number;
    message_id: number;
    text?: string;
    rich_message?: BaleInputRichMessage;
    parse_mode?: "HTML";
    link_preview_options?: BaleLinkPreviewOptions;
    reply_markup?: unknown;
};
export type BaleSendMessageDraftBody = Record<string, unknown> & {
    chat_id: number;
    draft_id: number;
    text?: string;
    parse_mode?: string;
    entities?: unknown[];
    message_thread_id?: number;
};
export type BaleSendRichMessageDraftBody = Record<string, unknown> & {
    chat_id: number;
    draft_id: number;
    rich_message: BaleInputRichMessage | (BaleInputRichMessageCommon & {
        blocks: BaleInputRichDraftBlock[];
        markdown?: never;
        html?: never;
        media?: never;
    });
    message_thread_id?: number;
};
interface BaleApiResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: {
        retry_after?: number;
    };
}
export interface BaleApiRetryWait {
    method: string;
    delayMs: number;
    attempt: number;
    retryAfterSeconds?: number;
}
export interface BaleApiCallOptions {
    /** Local per-call effect authority; independent of source completion and transport ownership. */
    assertAuthority?: () => void;
    signal?: AbortSignal;
    maxAttempts?: number;
    retryRateLimit?: boolean;
    retrySafety?: "safe" | "non-idempotent";
    retryBaseDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** Observability hook fired before a 429 retry wait, never for 5xx waits. */
    onRetryWait?: (wait: BaleApiRetryWait) => void;
    /** Caller-owned expected failure: still thrown, but the caller records the outcome instead of the API log. */
    isExpectedError?: (error: unknown) => boolean;
}
export declare class BaleApiAuthorityError extends Error {
    readonly requestIssued: boolean;
    constructor(requestIssued: boolean);
}
/** Recheck caller authority, classifying refusal by whether a Bot API request was already issued. */
export declare function assertBaleApiCallAuthority(assertAuthority: (() => void) | undefined, requestIssued: boolean): void;
export interface BaleFileDownloadOptions {
    signal?: AbortSignal;
    maxFileSizeBytes?: number;
}
export type BaleGuestCachedMediaResult = {
    type: "document";
    id: string;
    title: string;
    document_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "photo";
    id: string;
    photo_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "audio";
    id: string;
    audio_file_id: string;
    caption?: string;
    parse_mode?: string;
} | {
    type: "voice";
    id: string;
    voice_file_id: string;
    title: string;
    caption?: string;
    parse_mode?: string;
};
export interface BaleAnswerGuestQueryOptions {
    parseMode?: string;
    richMessage?: BaleInputRichMessage;
    result?: BaleGuestCachedMediaResult;
}
export interface BaleEditGuestInlineMessageContent {
    /** Cached media only: inline edits cannot upload a new local file. */
    media?: {
        type: "photo" | "document" | "audio";
        media: string;
        caption?: string;
    };
    text?: string;
    richMessage?: BaleInputRichMessage;
    parseMode?: "HTML";
}
export interface BaleAnswerCallbackQueryOptions extends Pick<BaleApiCallOptions, "assertAuthority"> {
    recordRuntimeEvent?: (kind: "api", error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleApiClient {
    call: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    callMultipart: <TResponse>(method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: BaleApiCallOptions) => Promise<TResponse>;
    downloadFile: (fileId: string, suggestedName: string, tempDir: string, options?: BaleFileDownloadOptions) => Promise<string>;
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    answerGuestQuery?: (guestQueryId: string, text?: string, options?: BaleAnswerGuestQueryOptions) => Promise<void>;
}
export interface BaleApiTargetActivityRuntime {
    begin: (method: string, body: Record<string, unknown>) => () => void;
    hasPendingTarget: (target: {
        chatId: number;
        threadId?: number;
    }) => boolean;
    listPendingTargets: () => {
        chatId: number;
        threadId: number;
    }[];
    listPendingChats: () => number[];
}
export declare function createBaleApiTargetActivityRuntime(deps?: {
    captureDrain?: () => (() => void) | undefined;
}): BaleApiTargetActivityRuntime;
export declare function createBaleApiTargetTrackingClient(client: BaleApiClient, activity: BaleApiTargetActivityRuntime): BaleApiClient;
export type BaleApiWorkspaceAdmissionScopeLike = {
    kind: "target";
    target: {
        chatId: number;
        threadId: number;
    };
} | {
    kind: "chat";
    chatId: number;
} | {
    kind: "profile";
};
export interface BaleApiWorkspaceAdmissionLeaseLike {
    operationId: string;
    operationKind: string;
    profileKey: string;
    scope: BaleApiWorkspaceAdmissionScopeLike;
    owner: {
        processId: number;
        processBirthId: string;
    };
    acquiredAtMs: number;
}
export interface BaleApiWorkspaceAdmissionPort {
    acquireAdmission: (input: {
        operationId: string;
        operationKind: string;
        scope: BaleApiWorkspaceAdmissionScopeLike;
    }) => {
        kind: "acquired";
        lease: BaleApiWorkspaceAdmissionLeaseLike;
        resumed: boolean;
    } | {
        kind: "blocked";
        reason: "retirement-fenced";
    };
    releaseAdmission: (expected: BaleApiWorkspaceAdmissionLeaseLike) => boolean;
}
export declare class BaleApiWorkspaceAdmissionError extends Error {
    readonly code: "blocked" | "unavailable" | "release-lost" | "duplicate-operation";
    constructor(code: BaleApiWorkspaceAdmissionError["code"], message: string);
}
export declare function getBaleApiWorkspaceAdmissionScope(body: Record<string, unknown>): BaleApiWorkspaceAdmissionScopeLike | undefined;
export declare function createBaleApiWorkspaceAdmissionClient(client: BaleApiClient, admission: BaleApiWorkspaceAdmissionPort | (() => BaleApiWorkspaceAdmissionPort | undefined), options?: {
    onReleaseError?: (error: unknown, method: string) => void;
    createOperationId?: () => string;
}): BaleApiClient;
export interface BaleBridgeApiRuntimeDeps {
    captureRequestErrorHandler?: (body: Record<string, unknown>) => ((error: unknown) => Promise<void>) | undefined;
    client: BaleApiClient;
    tempDir: string;
    maxFileSizeBytes: number;
    tempFileMaxAgeMs: number;
    /** Bot `@username` (or numeric id) naming private-chat attachments. */
    getBotScope?: () => string | undefined;
    recordRuntimeEvent: (kind: "api" | "multipart" | "download", error: unknown, details?: Record<string, unknown>) => void;
    now?: () => number;
    chatActionMinIntervalMs?: number;
    chatActionMaxGates?: number;
}
/** Typing issuance guard is local authority, never Bot API body or IPC data. */
export interface BaleTypingActionOptions extends Pick<BaleApiCallOptions, "assertAuthority"> {
    message_thread_id?: number;
}
export interface BaleBridgeApiRuntime extends Pick<BaleApiClient, "call" | "callMultipart"> {
    downloadFile: (fileId: string, suggestedName: string, source?: BaleAttachmentSource) => Promise<string>;
    deleteWebhook: (signal?: AbortSignal) => Promise<boolean>;
    getUpdates: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<BaleUpdate[]>;
    setMyCommands: (commands: readonly {
        command: string;
        description: string;
    }[], options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<boolean>;
    sendChatAction: (chatId: number, action: string, options?: {
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendTypingAction: (chatId: number, options?: BaleTypingActionOptions) => Promise<unknown>;
    sendRecordVoiceAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    sendMessageDraft: (chatId: number, draftId: number, text?: string, options?: {
        parse_mode?: string;
        entities?: unknown[];
        message_thread_id?: number;
    }) => Promise<boolean>;
    sendMessage: (body: BaleSendMessageBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
    sendRichMessage: (body: BaleSendRichMessageBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
    sendRichMessageDraft: (body: BaleSendRichMessageDraftBody) => Promise<boolean>;
    editMessageText: (body: BaleEditMessageTextBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<"edited" | "unchanged">;
    editMessageReplyMarkup: (chatId: number, messageId: number, replyMarkup: unknown) => Promise<void>;
    answerCallbackQuery: (callbackQueryId: string, text?: string, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    answerGuestQuery: (guestQueryId: string, text?: string, options?: BaleAnswerGuestQueryOptions) => Promise<void>;
    /**
     * Answers the guest query and retains the sent inline message id for final
     * text or cached-media replacement. Requires direct transport ownership;
     * actual guest-media rendering remains live-client gated.
     */
    answerGuestQueryForInlineMessage: (guestQueryId: string, text?: string, options?: BaleAnswerGuestQueryOptions) => Promise<string | undefined>;
    editGuestInlineMessage: (inlineMessageId: string, content: BaleEditGuestInlineMessageContent, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<void>;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    prepareTempDir: () => Promise<number>;
}
/** Names follow `<kind>-<scope>-<messageId>[-<index>][-<name>|.<ext>]`. */
/**
 * `scope` is the bot `@username` (id fallback) in a private chat and the public chat `@username` (id fallback) elsewhere.
 * A negative chat id loses its sign, so the name never contains two adjacent dashes.
 */
export declare function createBaleAttachmentFileName(source: BaleAttachmentSource, generatedName: string, botScope?: string): string;
export declare class BaleApiCommitUnknownError extends Error {
    readonly kind: "commit-unknown";
    readonly method: string;
    readonly cause: unknown;
    constructor(method: string, cause: unknown);
}
export declare function isBaleApiCommitUnknownError(error: unknown): error is BaleApiCommitUnknownError;
export declare class BaleApiStaleTargetError extends Error {
    readonly requestTarget: {
        chatId: number;
        threadId: number;
    };
    constructor(message: string, requestTarget: {
        chatId: number;
        threadId: number;
    });
}
/** A follower API refusal; legacy text alone does not prove the request was rejected before execution. */
export declare class BaleApiFollowerNotAllowedError extends Error {
    readonly requestTarget: {
        chatId: number;
        threadId: number;
    } | undefined;
    /** Present only after a structured pre-execution refusal matches the requested API method. */
    readonly rejectedRequestMethod: string | undefined;
    constructor(message: string, requestTarget?: {
        chatId: number;
        threadId: number;
    }, rejectedRequestMethod?: string);
}
export declare function getBaleApiErrorRequestTarget(error: unknown): {
    chatId: number;
    threadId: number;
} | undefined;
export declare function isBaleStaleTargetHttpError(error: unknown): boolean;
/** Only a parsed Bale rejection of this method proves a request had no effect. */
export declare function isBaleApiRequestRejected(error: unknown, method: string): boolean;
export declare function isBaleMessageNotModifiedError(error: unknown): boolean;
export declare function isBaleApiMethodRetrySafe(method: string): boolean;
export declare function isRetryableBaleApiError(error: unknown): boolean;
export declare function getBaleApiRetryAfterMs(error: unknown): number | undefined;
export declare function isBaleMessageUnavailableError(error: unknown): boolean;
declare function baleHttpsFetch(input: string | URL | Request, init: RequestInit, family: BaleNetworkFamily): Promise<Response>;
export declare function setBaleApiHttpsFetchForTesting(fetchImpl: typeof baleHttpsFetch | undefined): () => void;
export declare function cleanupBaleTempFiles(tempDir: string, maxAgeMs: number, now?: number): Promise<number>;
export declare function prepareBaleTempDir(tempDir: string, maxAgeMs: number): Promise<number>;
export declare function callBale<TResponse>(botToken: string | undefined, method: string, body: Record<string, unknown>, options?: BaleApiCallOptions): Promise<TResponse>;
export type BaleBotIdentityResponse = Pick<BaleApiResponse<BaleUser>, "ok" | "result" | "description">;
export declare function fetchBaleBotIdentity(botToken: string, fetchImpl?: typeof fetch): Promise<BaleBotIdentityResponse>;
/**
 * Low-level helper to send a multipart/form-data request to the Bale Bot API.
 * This is the core implementation used for uploading voice messages, photos,
 * documents, animations, etc. It handles FormData construction, retry logic
 * (via callBaleWithRetry), and error recording under the "multipart" category.
 */
export declare function callBaleMultipart<TResponse>(botToken: string | undefined, method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string, options?: BaleApiCallOptions): Promise<TResponse>;
export declare function downloadBaleFile(botToken: string | undefined, fileId: string, suggestedName: string, tempDir: string, options?: BaleFileDownloadOptions): Promise<string>;
export declare function answerBaleCallbackQuery(botToken: string | undefined, callbackQueryId: string, text?: string, options?: BaleAnswerCallbackQueryOptions): Promise<void>;
export declare function createBaleChatActionSender<TAction extends string>(sendChatAction: (chatId: number, action: TAction, options?: BaleTypingActionOptions) => Promise<unknown>, action: TAction): (chatId: number, options?: BaleTypingActionOptions) => Promise<unknown>;
export declare function createBaleNativeMarkdownDraftSender(deps: {
    sendMessageDraft: BaleBridgeApiRuntime["sendMessageDraft"];
    sendRichMessageDraft: BaleBridgeApiRuntime["sendRichMessageDraft"];
}): BaleBridgeApiRuntime["sendMessageDraft"];
export declare function createBaleAssistantDraftSender(deps: {
    getAssistantRenderingMode: () => "rich" | "html";
    renderMarkdownToHtmlDraft: (markdown: string) => string;
    sendMessageDraft: BaleBridgeApiRuntime["sendMessageDraft"];
    sendRichMessageDraft: BaleBridgeApiRuntime["sendRichMessageDraft"];
}): BaleBridgeApiRuntime["sendMessageDraft"];
export declare function buildBaleAnswerGuestQueryBody(guestQueryId: string, text?: string, options?: BaleAnswerGuestQueryOptions): Record<string, unknown>;
export type BaleWorkspaceThreadDeletionTransport = (authorize: () => {
    chatId: number;
    threadId: number;
}) => Promise<void>;
export declare function createDefaultBaleBridgeApiRuntime(deps: {
    getBotToken: () => string | undefined;
    getBotScope?: () => string | undefined;
    isThreadedMode?: () => boolean;
    recordRuntimeEvent: BaleBridgeApiRuntimeDeps["recordRuntimeEvent"];
    captureRequestErrorHandler?: BaleBridgeApiRuntimeDeps["captureRequestErrorHandler"];
    targetActivity?: BaleApiTargetActivityRuntime;
    workspaceAdmission?: BaleApiWorkspaceAdmissionPort | (() => BaleApiWorkspaceAdmissionPort | undefined);
}): BaleBridgeApiRuntime & {
    deleteWorkspaceThread: BaleWorkspaceThreadDeletionTransport;
};
export declare function createBaleBridgeApiRuntime(deps: BaleBridgeApiRuntimeDeps): BaleBridgeApiRuntime;
/**
 * Creates a low-level Bale Bot API client.
 * This is the main entry point for all direct Bot API communication
 * (both JSON calls and multipart uploads for files/voice).
 */
export declare function createBaleApiClient(getBotToken: () => string | undefined, options?: BaleAnswerCallbackQueryOptions & {
    now?: () => number;
    isThreadedMode?: () => boolean;
}): BaleApiClient;
export {};
