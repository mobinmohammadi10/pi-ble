/**
 * Bale reply delivery helpers
 * Zones: bale outbound, native rich markdown, UI/compat rendering transport
 * Owns native assistant replies, rendered UI delivery, guest placeholder rotation, reply transport wiring, and plain text replies
 */
import { renderBaleMessage, type BaleRenderedChunk, type BaleRenderMode } from "./rendering.ts";
import { type BaleTarget } from "./target.ts";
import type { BaleApiCallOptions, BaleInputRichMessage, BaleReplyParameters, BaleSendRichMessageBody, BaleSentMessage } from "./bale-api.ts";
export { renderBaleMessage, type BaleRenderedChunk, type BaleRenderMode, };
export declare function renderBaleMarkdownToHtmlDraft(markdown: string): string;
export declare const BALE_RICH_MESSAGE_MAX_CHARS = 32768;
export declare const BALE_RICH_MESSAGE_MAX_BLOCKS = 500;
export declare function resetTransportReplyDedup(): void;
/** Keeps a successfully published transition notice as the first reply of the
 * next agent turn. The following agent-start reset consumes this one-shot
 * preservation, so later messages in that turn do not repeat the reply header. */
export declare function preserveTransportReplyDedupOnNextReset(chatId: number, messageId: number, target?: BaleTarget): void;
export declare function buildBaleReplyParameters(chatId: number, messageId: number | undefined, target?: BaleTarget): BaleReplyParameters | undefined;
export declare function withBaleReplyParameters<T>(chatId: number, messageId: number | undefined, target: BaleTarget | undefined, send: (parameters: BaleReplyParameters | undefined) => Promise<T>): Promise<T>;
export declare function isAssistantAgentMessage(message: unknown): boolean;
export declare function getAgentMessageText(message: unknown): string;
export declare function extractLatestAssistantMessageText(messages: readonly unknown[]): {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
};
/**
 * Extract the run's answer without trusting an empty final assistant message.
 * A low-level run may end with a completed assistant message whose content was
 * suppressed (a companion extension preserving an earlier draft, for example
 * State Flow's fallback final:true patch turn). In that case the run's answer
 * is the latest earlier completed assistant message that carries text;
 * tool-use prefaces, errors, and aborts stay excluded.
 */
export declare function extractRunAssistantMessage(messages: readonly unknown[]): {
    text?: string;
    stopReason?: string;
    errorMessage?: string;
    recoveredFromEarlier?: boolean;
};
export interface BaleReplyOwnershipRecorder {
    record: (input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
    }) => void;
}
export interface BaleReplyDeliveryDeps<TReplyMarkup> {
    recordOwnership?: BaleReplyOwnershipRecorder["record"];
    sendMessage: (body: {
        chat_id: number;
        text: string;
        parse_mode?: "HTML";
        reply_markup?: TReplyMarkup;
        reply_parameters?: BaleReplyParameters;
        reply_to_message_id?: number;
        message_thread_id?: number;
    }, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
    editMessage: (body: {
        chat_id: number;
        message_id: number;
        text?: string;
        rich_message?: BaleInputRichMessage;
        parse_mode?: "HTML";
        reply_markup?: TReplyMarkup;
        message_thread_id?: number;
    }, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown>;
}
export interface BaleReplyTargetOptions extends Pick<BaleApiCallOptions, "assertAuthority"> {
    target?: BaleTarget;
    replyToMessageId?: number;
}
export interface BaleReplyTransport<TReplyMarkup> {
    sendRenderedChunks: (chatId: number, chunks: BaleRenderedChunk[], options?: BaleReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
    editRenderedMessage: (chatId: number, messageId: number, chunks: BaleRenderedChunk[], options?: BaleReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
}
export declare function buildBaleReplyTransport<TReplyMarkup>(deps: BaleReplyDeliveryDeps<TReplyMarkup>): BaleReplyTransport<TReplyMarkup>;
export declare function sendBaleRenderedChunks<TReplyMarkup>(chatId: number, chunks: BaleRenderedChunk[], deps: BaleReplyDeliveryDeps<TReplyMarkup>, options?: BaleReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export declare function editBaleRenderedMessage<TReplyMarkup>(chatId: number, messageId: number, chunks: BaleRenderedChunk[], deps: BaleReplyDeliveryDeps<TReplyMarkup>, options?: BaleReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export interface BaleTextReplyOptions extends BaleReplyTargetOptions {
    parseMode?: "HTML";
}
export interface BaleReplyRuntimeDeps<TReplyMarkup = unknown> {
    renderBaleMessage: (text: string, options?: {
        mode?: BaleRenderMode;
    }) => BaleRenderedChunk[];
    sendRenderedChunks: (chunks: BaleRenderedChunk[], options?: {
        replyMarkup?: TReplyMarkup;
    } & BaleReplyTargetOptions) => Promise<number | undefined>;
}
export declare function sendBalePlainReply(text: string, deps: BaleReplyRuntimeDeps, options?: BaleTextReplyOptions): Promise<number | undefined>;
/** An open fenced code block: its marker character and the minimum closing run length. */
export interface BaleMarkdownFence {
    marker: "`" | "~";
    length: number;
}
export declare function parseBaleMarkdownFenceOpening(line: string): BaleMarkdownFence | undefined;
export declare function isBaleMarkdownFenceClosing(line: string, fence: BaleMarkdownFence): boolean;
export declare function normalizeBaleNativeMarkdown(markdown: string): string;
export declare function splitBaleNativeMarkdown(markdown: string): string[];
export declare function sendBaleNativeMarkdownReply<TReplyMarkup = unknown>(chatId: number, replyToMessageId: number | undefined, markdown: string, deps: {
    recordOwnership?: BaleReplyOwnershipRecorder["record"];
    sendRichMessage: (body: BaleSendRichMessageBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
}, options?: BaleReplyTargetOptions & {
    replyMarkup?: TReplyMarkup;
}): Promise<number | undefined>;
export type BaleAssistantRenderingMode = "rich" | "html";
export interface BaleRenderedMessageRuntimeDeps<TReplyMarkup> {
    renderBaleMessage: (text: string, options?: {
        mode?: BaleRenderMode;
    }) => BaleRenderedChunk[];
    replyTransport: BaleReplyTransport<TReplyMarkup>;
    recordOwnership?: BaleReplyOwnershipRecorder["record"];
    getAssistantRenderingMode?: () => BaleAssistantRenderingMode;
    sendRichMessage: (body: BaleSendRichMessageBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
}
export interface BaleRenderedMessageRuntime<TReplyMarkup> {
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: BaleTextReplyOptions) => Promise<number | undefined>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: BaleReplyTargetOptions & {
        replyMarkup?: TReplyMarkup;
    }) => Promise<number | undefined>;
    editInteractiveMessage: (chatId: number, messageId: number, text: string, mode: BaleRenderMode, replyMarkup: TReplyMarkup, options?: BaleReplyTargetOptions) => Promise<void>;
    sendInteractiveMessage: (chatId: number, text: string, mode: BaleRenderMode, replyMarkup: TReplyMarkup, options?: BaleReplyTargetOptions) => Promise<number | undefined>;
    sendSectionRichMessage: (chatId: number, message: BaleInputRichMessage, options?: BaleReplyTargetOptions) => Promise<number>;
}
export interface BaleRenderedMessageDeliveryRuntime<TReplyMarkup> extends BaleRenderedMessageRuntime<TReplyMarkup> {
    replyTransport: BaleReplyTransport<TReplyMarkup>;
}
export interface BaleRenderedMessageDeliveryRuntimeDeps<TReplyMarkup> extends BaleReplyDeliveryDeps<TReplyMarkup> {
    renderBaleMessage?: (text: string, options?: {
        mode?: BaleRenderMode;
    }) => BaleRenderedChunk[];
    getAssistantRenderingMode?: () => BaleAssistantRenderingMode;
    sendRichMessage: (body: BaleSendRichMessageBody, options?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<BaleSentMessage>;
}
export declare function createBaleRenderedMessageDeliveryRuntime<TReplyMarkup>(deps: BaleRenderedMessageDeliveryRuntimeDeps<TReplyMarkup>): BaleRenderedMessageDeliveryRuntime<TReplyMarkup>;
export declare function createBaleRenderedMessageRuntime<TReplyMarkup>(deps: BaleRenderedMessageRuntimeDeps<TReplyMarkup>): BaleRenderedMessageRuntime<TReplyMarkup>;
/**
 * Guest reply sender: answers guest queries with native Rich Markdown content.
 * Guest queries use InlineQueryResult input_message_content rather than chat
 * sendRichMessage, so this stays as a dedicated guest transport adapter.
 */
export declare function createGuestMarkdownReplySender(deps: {
    answerGuestQuery: (guestQueryId: string, text?: string, options?: {
        parseMode?: string;
        richMessage?: BaleInputRichMessage;
    }) => Promise<void>;
}): (guestQueryId: string, markdown: string) => Promise<void>;
/**
 * Guest reply editor: replaces the early Guest Mode placeholder ACK with
 * native Rich Markdown content addressed by `inline_message_id` instead of a
 * chat/message pair.
 */
export declare function createGuestMarkdownReplyEditor(deps: {
    editGuestInlineMessage: (inlineMessageId: string, content: {
        richMessage?: BaleInputRichMessage;
        text?: string;
    }, options?: {
        assertAuthority?: () => void;
    }) => Promise<void>;
}): (inlineMessageId: string, markdown: string, options?: {
    assertAuthority?: () => void;
}) => Promise<void>;
/**
 * Guest Mode placeholder rotation: the early ACK is the first placeholder
 * frame and the runtime steps the remaining frames once per interval, moving
 * the globe every second while the trailing dots grow once every two seconds.
 *
 * Rotation completes whole six-frame cycles and only stops once at least
 * `BALE_GUEST_PLACEHOLDER_MIN_MS` has elapsed, so a pending answer holds
 * the finished cycle's last frame (`🌏 Working on it...`) instead of whatever
 * step a hard time cap happens to cut. The `BALE_GUEST_PLACEHOLDER_MAX_MS`
 * safety bound keeps the edit stream clear of the first flood-control
 * rejections measured in live guest runs (+26.5 s at ~53 edits, +27.8 s at
 * ~28 edits): rotation caps at 23 edits and never starts a frame after 26 s.
 */
export declare const BALE_GUEST_PLACEHOLDER_FRAME_MS = 1000;
export declare const BALE_GUEST_PLACEHOLDER_MIN_MS = 20000;
export declare const BALE_GUEST_PLACEHOLDER_MAX_MS = 26000;
export declare const BALE_GUEST_PLACEHOLDER_FRAMES: readonly ["<b>🌎 Working on it.</b>", "<b>🌍 Working on it.</b>", "<b>🌏 Working on it..</b>", "<b>🌎 Working on it..</b>", "<b>🌍 Working on it...</b>", "<b>🌏 Working on it...</b>"];
export declare const BALE_DISMISSED_GUEST_PLACEHOLDER_TEXT = "\u2063";
export declare function buildBaleGuestPlaceholderFrame(step: number): string;
export interface BaleGuestPlaceholderRuntimeDeps {
    editGuestInlineMessage: (inlineMessageId: string, content: {
        text: string;
        parseMode: "HTML";
    }) => Promise<void>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    intervalMs?: number;
    minMs?: number;
    maxMs?: number;
    now?: () => number;
    setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface BaleGuestPlaceholderRuntime {
    /** Starts the frame loop on an answered guest inline message. */
    start: (inlineMessageId: string) => void;
    /** Cancels the loop and waits for any in-flight frame edit before returning. */
    stop: (inlineMessageId: string) => Promise<void>;
    /** Cancels every loop without waiting for in-flight edits (session shutdown). */
    stopAll: () => void;
    /** Stops rotation and visually clears the inline placeholder. */
    dismiss: (inlineMessageId: string) => Promise<void>;
}
export declare function createBaleGuestPlaceholderRuntime(deps: BaleGuestPlaceholderRuntimeDeps): BaleGuestPlaceholderRuntime;
