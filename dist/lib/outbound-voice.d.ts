/**
 * Bale outbound voice delivery helpers
 * Zones: bale outbound, voice delivery
 * Owns native Bale voice upload orchestration across configured voice handlers, programmatic outbound voice handlers, and registered synthesis providers
 */
import { type BaleTarget } from "./target.ts";
export interface BaleVoiceReplyTurnView {
    chatId: number;
    replyToMessageId: number;
    target?: BaleTarget;
}
export interface BaleVoiceReplySenderDeps {
    execCommand: (command: string, args: string[], options?: {
        cwd?: string;
        timeout?: number;
        signal?: AbortSignal;
        stdin?: string;
        retry?: number;
    }) => Promise<{
        stdout: string;
        stderr: string;
        code: number;
        killed: boolean;
    }>;
    sendMultipart: (method: string, fields: Record<string, string>, fileField: string, filePath: string, fileName: string) => Promise<unknown>;
    sendChatAction?: (chatId: number, action: string) => Promise<unknown>;
    sendRecordVoiceAction?: (chatId: number) => Promise<unknown>;
    isDeliveryActive?: () => boolean;
    getHandlers?: () => unknown[] | undefined;
    cwd?: string;
    tempDir?: string;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type BaleOutboundProgrammaticVoiceHandler = (text: string, options?: {
    lang?: string;
    rate?: string;
}) => Promise<string>;
export interface BaleVoiceReplySenderPorts<THandler = unknown> {
    findVoiceHandlers?: (handlers: unknown[] | undefined) => THandler[];
    generateVoiceFile?: (text: string, options: {
        lang?: string;
        rate?: string;
        handler: THandler;
        tempDir?: string;
        cwd?: string;
        execCommand: BaleVoiceReplySenderDeps["execCommand"];
    }) => Promise<string | undefined>;
    getProgrammaticVoiceHandlers?: () => BaleOutboundProgrammaticVoiceHandler[];
}
export declare function createBaleVoiceReplySender<THandler = unknown>(deps: BaleVoiceReplySenderDeps, ports?: BaleVoiceReplySenderPorts<THandler>): (turn: BaleVoiceReplyTurnView, text: string, options?: {
    lang?: string;
    rate?: string;
    replyToPrompt?: boolean;
    replyMarkup?: unknown;
}) => Promise<void>;
