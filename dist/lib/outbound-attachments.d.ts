/**
 * Bale outbound attachment helpers
 * Zones: bale outbound, pi agent tool, filesystem
 * Owns bale_attach registration, outbound attachment queueing, and delivery so Bale file output stays in one domain module
 */
import type { BaleBusAgentMessage, BaleBusAgentTargetSelector } from "./bus.ts";
import type { ExtensionAPI } from "./pi.ts";
import { type BaleTarget } from "./target.ts";
export declare const BALE_OUTBOUND_ATTACHMENT_DEFAULT_MAX_BYTES: number;
export declare function getBaleOutboundAttachmentByteLimitFromEnv(env: NodeJS.ProcessEnv, names: string[], defaultValue?: number): number;
export interface BaleOutboundAttachmentToolResult {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: {
        paths: string[];
    };
}
export interface BaleOutboundAttachmentRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleOutboundAttachmentToolRegistrationDeps extends BaleOutboundAttachmentRuntimeEventRecorderPort {
    maxAttachmentsPerTurn?: number;
    maxAttachmentSizeBytes?: number;
    getActiveTurn: () => BaleOutboundAttachmentQueueTargetView | undefined;
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => BaleTarget | undefined;
    canSendDirect?: () => boolean;
    sendMultipart?: BaleQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}
export interface BaleOutboundMessagePlan {
    markdown: string;
    replyMarkup?: unknown;
}
export interface BaleOutboundMessageDeliveryPorts {
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => BaleTarget | undefined;
    getActiveTurn?: () => {
        chatId: number;
        target?: BaleTarget;
    } | undefined;
    resolveAgentTarget?: (selector: BaleBusAgentTargetSelector) => Promise<BaleTarget & {
        threadId: number;
    }>;
    routeAgentMessage?: (message: BaleBusAgentMessage) => Promise<void>;
    canSendDirect: () => boolean;
    planMessage: (markdown: string) => BaleOutboundMessagePlan;
    sendMarkdownMessage: (chatId: number, markdown: string, options?: {
        replyMarkup?: unknown;
        target?: BaleTarget;
    }) => Promise<number | undefined>;
    sendChannelMarkdownMessage?: (channel: number | string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
    sendChannelMediaMessage?: (channel: number | string, mediaPath: string, markdown: string, options: {
        operationId: string;
        replyMarkup?: unknown;
    }) => Promise<number | undefined>;
}
export interface BaleOutboundMessageToolRegistrationDeps extends BaleOutboundMessageDeliveryPorts, BaleOutboundAttachmentRuntimeEventRecorderPort {
    getDefaultChatId: () => number | undefined;
}
export interface BaleQueuedOutboundAttachmentView {
    path: string;
    fileName: string;
}
export interface BaleOutboundAttachmentQueueTargetView {
    queuedAttachments: BaleQueuedOutboundAttachmentView[];
    guestQueryId?: string;
    guestInlineMessageId?: string;
}
export interface BaleQueuedOutboundAttachmentTurnView extends BaleOutboundAttachmentQueueTargetView {
    chatId: number;
    replyToMessageId: number;
    target?: BaleTarget;
}
export interface BaleRichOutboundAttachmentPlan {
    method: "sendRichMessage";
    fields: Record<string, string>;
    fileField: "rich_media_upload";
    filePath: string;
    fileName: string;
}
export interface BaleRichOutboundAttachmentSenderDeps extends BaleOutboundAttachmentRuntimeEventRecorderPort {
    sendMultipart: BaleQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getRenderingMode: () => "rich" | "html";
    recordOwnership?: (input: {
        chatId: number;
        messageId: number;
        target?: BaleTarget;
    }) => void;
}
export declare function planBaleRichOutboundAttachment(options: {
    turn: BaleQueuedOutboundAttachmentTurnView;
    markdown: string;
    renderingMode: "rich" | "html";
    replyMarkup?: unknown;
}): BaleRichOutboundAttachmentPlan | undefined;
export declare function createBaleRichOutboundAttachmentSender(deps: BaleRichOutboundAttachmentSenderDeps): (turn: BaleQueuedOutboundAttachmentTurnView, markdown: string, options?: {
    replyMarkup?: unknown;
    isDeliveryActive?: () => boolean;
}) => Promise<boolean>;
export type BaleGuestCachedAttachmentResult = {
    type: "document";
    id: string;
    title: string;
    document_file_id: string;
    caption?: string;
} | {
    type: "photo";
    id: string;
    photo_file_id: string;
    caption?: string;
} | {
    type: "audio";
    id: string;
    audio_file_id: string;
    caption?: string;
} | {
    type: "voice";
    id: string;
    voice_file_id: string;
    title: string;
    caption?: string;
};
export declare function registerBaleOutboundAttachmentTool(pi: ExtensionAPI, deps: BaleOutboundAttachmentToolRegistrationDeps): void;
export declare function registerBaleOutboundMessageTool(pi: ExtensionAPI, deps: BaleOutboundMessageToolRegistrationDeps): void;
export interface BaleQueuedOutboundAttachmentDeliveryDeps {
    sendMultipart: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
    sendTextReply: (chatId: number, replyToMessageId: number, text: string, options?: {
        target?: BaleTarget;
    }) => Promise<unknown>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    statPath?: (path: string) => Promise<{
        size: number;
    }>;
    maxAttachmentSizeBytes?: number;
    isDeliveryActive?: () => boolean;
}
export declare function queueBaleOutboundAttachments(options: {
    activeTurn: BaleOutboundAttachmentQueueTargetView | undefined;
    paths: string[];
    chatId?: number;
    threadId?: number;
    caption?: string;
    maxAttachmentsPerTurn: number;
    maxAttachmentSizeBytes?: number;
    sendMultipart?: BaleQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => BaleTarget | undefined;
    canSendDirect?: () => boolean;
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}): Promise<BaleOutboundAttachmentToolResult>;
export declare function deliverBaleGuestCachedAttachment(options: {
    guestQueryId: string;
    guestInlineMessageId?: string;
    editGuestInlineMessage?: (inlineMessageId: string, content: {
        media: {
            type: "photo" | "document" | "audio";
            media: string;
            caption?: string;
        };
    }, options: {
        assertAuthority: () => void;
    }) => Promise<void>;
    isDeliveryActive?: () => boolean;
    stagingChatId: number;
    stagingTarget?: BaleTarget;
    attachment: BaleQueuedOutboundAttachmentView;
    caption?: string;
    sendMultipart: BaleQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    answerGuestQuery: (guestQueryId: string, result: BaleGuestCachedAttachmentResult) => Promise<void>;
    answerGuestText?: (guestQueryId: string, text: string) => Promise<void>;
    fallbackText?: string;
    deleteMessage: (chatId: number, messageId: number) => Promise<void>;
    recordRuntimeEvent?: BaleOutboundAttachmentRuntimeEventRecorderPort["recordRuntimeEvent"];
}): Promise<void>;
export declare function sendBaleOutboundMessage(options: BaleOutboundMessageDeliveryPorts & {
    text: string;
    media?: string;
    operationId?: string;
    channel?: boolean;
    chatId?: number | string;
    threadId?: number;
    agentThread?: string | number;
    target?: BaleTarget;
}): Promise<{
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: {
        chatId: number | string;
        messageId?: number;
    };
}>;
export declare function sendBaleOutboundFiles(options: {
    paths: string[];
    chatId?: number;
    threadId?: number;
    target?: BaleTarget;
    caption?: string;
    maxAttachmentsPerTurn: number;
    maxAttachmentSizeBytes?: number;
    sendMultipart: BaleQueuedOutboundAttachmentDeliveryDeps["sendMultipart"];
    getDefaultChatId?: () => number | undefined;
    getDefaultTarget?: () => BaleTarget | undefined;
    canSendDirect?: () => boolean;
    statPath?: (path: string) => Promise<{
        isFile(): boolean;
        size?: number;
    }>;
}): Promise<BaleOutboundAttachmentToolResult & {
    details: {
        paths: string[];
        chatId: number;
    };
}>;
export declare function createBaleQueuedOutboundAttachmentSender(deps: BaleQueuedOutboundAttachmentDeliveryDeps): (turn: BaleQueuedOutboundAttachmentTurnView, options?: {
    isDeliveryActive?: () => boolean;
}) => Promise<void>;
export declare function sendQueuedBaleOutboundAttachments(turn: BaleQueuedOutboundAttachmentTurnView, deps: BaleQueuedOutboundAttachmentDeliveryDeps): Promise<void>;
