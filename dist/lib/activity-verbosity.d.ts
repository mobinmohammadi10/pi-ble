/**
 * Bridge-owned Bale activity verbosity projection
 * Zones: bale activity, rich rendering, operational delivery
 * Owns persistent bounded thinking and tool disclosures; excludes activity normalization, assistant answer rendering, and transport authority policy
 */
import type { BaleActivityEvent, BaleActivityPublicationRuntime } from "./activity.ts";
import { type BaleTarget } from "./target.ts";
import type { BaleEditMessageTextBody, BaleInputRichMessage, BaleSendMessageBody, BaleSendRichMessageBody, BaleSentMessage } from "./bale-api.ts";
export declare const BALE_ACTIVITY_MESSAGE_MAX_TOOLS = 6;
export declare const BALE_REASONING_BUFFER_MAX_CHARS = 1200;
export declare const BALE_TOOL_UPDATE_MAX_ENTRIES = 4;
interface ToolActivity {
    id: string;
    name: string;
    args: string;
    updates: string[];
    droppedUpdates: number;
    result?: string;
    isError?: boolean;
    complete: boolean;
}
export declare function renderBaleToolActivityHtml(tools: readonly ToolActivity[]): string;
export declare function renderBaleToolActivityRichMessage(tools: readonly ToolActivity[]): BaleInputRichMessage;
export declare function renderBaleThinkingActivityHtml(text: string): string;
export interface BaleActivityVerbosityRuntime {
    accept: (event: BaleActivityEvent) => void;
    reset: () => void;
    stop: () => void;
    waitForIdle: () => Promise<void>;
}
export declare function createBaleActivityVerbosityRuntime<TAuthority>(deps: {
    enqueue?: BaleActivityPublicationRuntime["enqueue"];
    getActivityMode: () => "quiet" | "thinking" | "tools" | "verbose";
    refreshActivityMode?: () => Promise<void>;
    getNowMs?: () => number;
    setReasoningTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearReasoningTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
    resolveTarget: (event: BaleActivityEvent) => BaleTarget | undefined;
    captureAuthority: () => TAuthority;
    isAuthorityActive: (authority: TAuthority) => boolean;
    sendMessage: (body: BaleSendMessageBody) => Promise<BaleSentMessage>;
    sendRichMessage: (body: BaleSendRichMessageBody) => Promise<BaleSentMessage>;
    editMessageText: (body: BaleEditMessageTextBody) => Promise<"edited" | "unchanged">;
    recordFailure?: (operation: "config-refresh" | "reasoning-send" | "reasoning-edit" | "tool-send" | "tool-edit", event: BaleActivityEvent, error: unknown) => void;
}): BaleActivityVerbosityRuntime;
export {};
