/**
 * Bale outbound surface helpers
 * Zones: bale outbound, command templates, voice delivery
 * Owns configured outbound handler execution, text transforms, public assistant-output reply composition and mutation fencing, voice-file generation/delivery, runtime-event bridge, and compatibility re-exports; assistant markup parsing lives in outbound-markup and button callback actions live in outbound-buttons
 */
import type { BaleAssistantSegmentEvent } from "./activity.ts";
import { type BaleButtonActionStore, type BaleOutboundButtonBinding, type BaleOutboundButtonMarkup } from "./outbound-buttons.ts";
import { type BaleVoiceReplyItem } from "./outbound-markup.ts";
import type { BalePreparedPreviewDelivery } from "./preview.ts";
import * as Replies from "./replies.ts";
import type { BaleTarget } from "./target.ts";
import type { BaleEditMessageTextBody, BaleSendMessageBody, BaleSendRichMessageBody, BaleSentMessage } from "./bale-api.ts";
import { type CommandTemplateObjectConfig } from "./command-templates.ts";
/**
 * Record a runtime event that appears in `/bale-status`.
 * Voice synthesis provider extensions can call this to surface diagnostics
 * alongside pi-bale's own events. Events are silently dropped
 * when pi-bale is not loaded.
 */
export type BaleRuntimeEventRecorder = (category: string, error: unknown, details?: Record<string, unknown>) => void;
export declare function bindBaleRuntimeEventRecorder(recorder: BaleRuntimeEventRecorder): void;
export declare function recordBaleRuntimeEvent(category: string, error: unknown, details?: Record<string, unknown>): void;
export type BaleOutboundCommandTemplateConfig = string | CommandTemplateObjectConfig;
export interface BaleOutboundHandlerConfig extends CommandTemplateObjectConfig {
    type?: string;
    match?: string | string[];
    output?: string;
    timeout?: number | string;
}
export interface BaleVoiceExecOptions {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
    stdin?: string;
    retry?: number;
    recover?: () => Promise<void>;
}
export interface BaleVoiceExecResult {
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
}
export interface BaleVoiceReplyTurnView {
    chatId: number;
    replyToMessageId: number;
    target?: BaleTarget;
}
export interface BaleVoiceReplySenderDeps {
    execCommand: (command: string, args: string[], options?: BaleVoiceExecOptions) => Promise<BaleVoiceExecResult>;
    sendMultipart: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
    sendTextReply?: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        parseMode?: "HTML";
    }) => Promise<unknown>;
    sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
    sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
    isDeliveryActive?: () => boolean;
    getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
    cwd?: string;
    tempDir?: string;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type BaleOutboundProgrammaticHandler = (text: string, options?: {
    lang?: string;
    rate?: string;
}) => Promise<string>;
export interface BaleOutboundHandlerRegistry {
    handlers: Map<string, BaleOutboundProgrammaticHandler[]>;
}
export declare function registerBaleOutboundHandler(kind: string, handler: BaleOutboundProgrammaticHandler): () => void;
export interface BaleOutboundTextReplyRuntimeDeps<TReplyMarkup = unknown> {
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
    getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
    sendTextReply: (chatId: number, replyToMessageId: number | undefined, text: string, options?: {
        parseMode?: "HTML";
        target?: BaleTarget;
    } & Pick<Replies.BaleReplyTargetOptions, "assertAuthority">) => Promise<number | undefined>;
    sendMarkdownReply: (chatId: number, replyToMessageId: number | undefined, markdown: string, options?: {
        replyMarkup?: TReplyMarkup;
        target?: BaleTarget;
    } & Pick<Replies.BaleReplyTargetOptions, "assertAuthority">) => Promise<number | undefined>;
    cwd?: string;
    recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
}
export interface BaleInlineKeyboardLike {
    inline_keyboard: Array<Array<{
        text: string;
        callback_data: string;
    }>>;
}
export interface BaleOutboundTextTransformOptions<TReplyMarkup = unknown> {
    handlers?: BaleOutboundHandlerConfig[];
    cwd?: string;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
    recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
    replyMarkup?: TReplyMarkup;
}
export interface BaleOutboundTextTransformResult<TReplyMarkup = unknown> {
    text: string;
    replyMarkup?: TReplyMarkup;
}
export interface BaleOutboundTextPreviewRuntimeDeps<TReplyMarkup = unknown> {
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
    getHandlers?: () => BaleOutboundHandlerConfig[] | undefined;
    finalizeMarkdownPreview: BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"];
    preparePreviewDelivery?: (isDeliveryActive: () => boolean) => BalePreparedPreviewDelivery<TReplyMarkup>;
    cwd?: string;
    recordRuntimeEvent?: BaleVoiceReplySenderDeps["recordRuntimeEvent"];
}
export declare function findBaleOutboundHandlers(handlers: BaleOutboundHandlerConfig[] | undefined, type: string): BaleOutboundHandlerConfig[];
export declare function generateBaleVoiceReplyFile(text: string, options: {
    lang?: string;
    rate?: string;
    handler?: BaleOutboundHandlerConfig;
    tempDir?: string;
    cwd?: string;
    execCommand: BaleVoiceReplySenderDeps["execCommand"];
}): Promise<string | undefined>;
export declare function createBaleOutboundTextReplyRuntime<TReplyMarkup = unknown>(deps: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>): Pick<BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>, "sendTextReply" | "sendMarkdownReply">;
export declare function createBaleOutboundTextPreviewRuntime<TReplyMarkup = unknown>(deps: BaleOutboundTextPreviewRuntimeDeps<TReplyMarkup>): {
    finalizeMarkdownPreview: BalePreparedPreviewDelivery<TReplyMarkup>["finalizeMarkdownPreview"];
    preparePreviewDelivery: (isDeliveryActive: () => boolean) => BalePreparedPreviewDelivery<TReplyMarkup> | undefined;
};
export interface BaleOutboundReplyPlan<TReplyMarkup = unknown> {
    markdown: string;
    replyMarkup?: TReplyMarkup;
    voiceText?: string;
    voiceReplies?: BaleVoiceReplyItem[];
    lang?: string;
    rate?: string;
}
export { clearBaleVoiceSynthesisProviders, clearBaleVoiceTranscriptionProviders, computeVoicePromptContribution, computeVoiceTurnFlags, getBaleVoiceReplyMode, getBaleVoiceSynthesisProviders, getBaleVoiceTranscriptionProviders, hasBaleVoiceSynthesisProvider, hasBaleVoiceTranscriptionProvider, isVoiceTurn, registerBaleVoiceSynthesisProvider, registerBaleVoiceTranscriptionProvider, shouldSuppressPreviewForVoice, type BaleVoiceReplyMode, type BaleVoiceSynthesisProvider, type BaleVoiceSynthesisProviderResult, type BaleVoiceTranscriptionFile, type BaleVoiceTranscriptionProvider, type BaleVoiceTranscriptionProviderResult, type BaleVoiceTurnView, } from "./voice.ts";
export declare function createBaleVoiceReplySender(deps: BaleVoiceReplySenderDeps): (turn: import("./outbound-voice.ts").BaleVoiceReplyTurnView, text: string, options?: {
    lang?: string;
    rate?: string;
    replyToPrompt?: boolean;
    replyMarkup?: unknown;
} | undefined) => Promise<void>;
export { createBaleButtonActionStore, createBaleButtonPromptTurn, createBaleButtonReplyPlanner, handleBaleButtonCallbackQuery, markBaleButtonSelected, planBaleButtonReply, type BaleButtonActionStore, type BaleButtonCallbackHandlerDeps, type BaleButtonCallbackQuery, type BaleButtonReplyPlan, type BaleOutboundButtonAction, type BaleOutboundButtonBinding, type BaleOutboundButtonMarkup, type BaleOutboundButtonStoredAction, } from "./outbound-buttons.ts";
export declare function createBaleOutboundReplyPlanner(store: Pick<BaleButtonActionStore, "register">, getRenderingMode?: () => "rich" | "html"): (markdown: string, options?: {
    binding?: BaleOutboundButtonBinding;
}) => BaleOutboundReplyPlan<BaleOutboundButtonMarkup>;
/**
 * Create an artifact sender that delivers planned voice replies for a turn.
 * Iterates over `voiceReplies` (or a single `voiceText`) and sends each as
 * a Bale voice message via the voice reply sender. Throws if no voice
 * reply could be delivered.
 */
export declare function createBaleOutboundReplyArtifactSender(deps: BaleVoiceReplySenderDeps): (turn: BaleVoiceReplyTurnView, plan: Pick<BaleOutboundReplyPlan, "voiceText" | "voiceReplies" | "lang" | "rate" | "replyMarkup">, options?: {
    replyToPrompt?: boolean;
    isDeliveryActive?: () => boolean;
}) => Promise<void>;
export interface BaleAssistantOutputMutationFence {
    run: <TArgs extends unknown[], TResult>(mutation: (...args: TArgs) => Promise<TResult>, ...args: TArgs) => Promise<TResult>;
}
export interface BaleAssistantOutputDeliveryAuthority<TTransportStamp> {
    transportStamp: TTransportStamp;
    route: "direct" | "follower" | "none";
    directEpoch?: number | string;
    followerGeneration?: string;
    target?: BaleTarget;
}
export declare function createBaleAssistantOutputMutationFence(isAuthorityActive: () => boolean): BaleAssistantOutputMutationFence;
export declare function createBaleAssistantOutputSender<TTransportStamp, TReplyMarkup = unknown>(deps: {
    recordOwnership?: Replies.BaleReplyOwnershipRecorder["record"];
    sendMessage: (body: BaleSendMessageBody) => Promise<BaleSentMessage>;
    sendRichMessage: (body: BaleSendRichMessageBody) => Promise<BaleSentMessage>;
    editMessage: (body: BaleEditMessageTextBody) => Promise<unknown>;
    getAssistantRenderingMode: () => "rich" | "html";
    planButtonReply?: (markdown: string) => {
        markdown: string;
        replyMarkup?: TReplyMarkup;
    };
    execCommand: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["execCommand"];
    getHandlers?: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["getHandlers"];
    recordRuntimeEvent?: BaleOutboundTextReplyRuntimeDeps<TReplyMarkup>["recordRuntimeEvent"];
}): (event: BaleAssistantSegmentEvent, authority: BaleAssistantOutputDeliveryAuthority<TTransportStamp>, isAuthorityActive: () => boolean) => Promise<void>;
