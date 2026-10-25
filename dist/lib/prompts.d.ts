/**
 * Bale prompt injection helpers
 * Zones: pi agent prompts, bale guidance
 * Owns stable Bale guidance, turn-scoped context, and compatibility fallback hooks
 */
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult } from "./pi.ts";
export declare const BALE_CONNECTED_CONTEXT_MESSAGE = "Bale session connected. Use Bale features for Bale-originated turns or explicit Bale requests; connectivity alone is not user intent.";
export declare const BALE_DISCONNECTED_CONTEXT_MESSAGE = "Bale session disconnected. Do not use Bale delivery, actions, or Bale-specific reply features unless the user reconnects it.";
export declare const BALE_ATTACH_PROMPT_SNIPPET = "Queue files for the active Bale reply; outside Bale turns, send files directly to Bale.";
export declare const BALE_ATTACH_PROMPT_GUIDELINES: readonly ["When handling a [bale] message and the user asked for a file or generated artifact, call bale_attach with the local path instead of only mentioning the path in text.", "When a local/TUI user explicitly asks to send a generated file to Bale, bale_attach can deliver it to the paired/default Bale chat even without an active Bale turn.", "For an explicit thread target, provide chat_id plus thread_id; registered multi-instance followers default to their assigned thread target."];
export declare const BALE_MESSAGE_PROMPT_SNIPPET = "Send direct Bale Markdown text when the user explicitly asks for Bale delivery to a concrete chat, channel, or live Pi Thread outside the normal reply flow.";
export declare const BALE_MESSAGE_PROMPT_GUIDELINES: readonly ["Use bale_message only when the user explicitly asks to send a message to Bale from the local/TUI side, or names a concrete Bale delivery target.", "For an explicitly requested channel post, pass its exact numeric id or public @username as chat_id; no local channel registry is required, and Bale remains the authority on the bot's posting permission.", "For an explicitly requested channel media post, pass one local .jpg/.jpeg/.png/.webp photo or .mp4 video as media; the text becomes its caption (max 1024 characters), and albums or other media types are rejected.", "For a live Pi thread target, provide thread as its case-insensitive name or numeric id; the bridge sends visibly and admits one attributed turn to that live instance. Unknown, ambiguous, same, or offline targets fail before sending.", "Add buttons by embedding the same top-level bale_button HTML comments used in normal Bale replies; Bale does not support standalone buttons.", "During an active Bale turn, omit bale_message for the current target and answer normally; use thread only when the user requests delivery to a different live Pi thread."];
export interface BaleModelContextAvailabilityMemory {
    suspended: boolean;
    toolNames: Set<string>;
}
export interface BaleModelContextAvailabilityRuntime {
    reconcile: () => void;
}
export interface BaleModelContextAvailabilityBinding extends BaleModelContextAvailabilityRuntime {
    bind: (runtime: BaleModelContextAvailabilityRuntime) => void;
}
export declare function createBaleModelContextAvailabilityBinding(): BaleModelContextAvailabilityBinding;
export declare function createBaleModelContextAvailabilityRuntime(deps: {
    getActiveTools: () => string[];
    setActiveTools: (names: string[]) => void;
    isAvailable: () => boolean;
    canReconcile?: () => boolean;
    memory?: BaleModelContextAvailabilityMemory;
}): BaleModelContextAvailabilityRuntime;
export type BaleSystemPrompt = string | string[];
type BaleBeforeAgentStartEvent = Omit<BeforeAgentStartEvent, "systemPrompt" | "prompt" | "messageType"> & {
    messageType?: "user" | "custom";
    prompt?: string;
    systemPrompt?: BaleSystemPrompt | null;
};
type BaleBeforeAgentStartResult = {
    systemPrompt: BaleSystemPrompt;
};
type BaleProactiveBeforeAgentStartResult = Omit<BeforeAgentStartEventResult, "systemPrompt"> & {
    systemPrompt?: BaleSystemPrompt;
};
type BaleBeforeAgentStartHook = (event: BaleBeforeAgentStartEvent) => BaleBeforeAgentStartResult;
export declare function buildBaleBridgeSystemPrompt(options: {
    prompt?: string;
    systemPrompt?: BaleSystemPrompt | null;
    balePrefix?: string;
    localSystemPromptSuffix: string;
    baleTurnSystemPromptSuffix: string;
}): BaleBeforeAgentStartResult;
export declare function createBaleBeforeAgentStartHook(options?: {
    balePrefix?: string;
    localSystemPromptSuffix?: string;
    baleTurnSystemPromptSuffix?: string;
}): BaleBeforeAgentStartHook;
export interface BaleProactivePromptHookDeps<TContext> {
    baseHook?: BaleBeforeAgentStartHook;
    reconcileAvailability?: () => void;
    isAvailable: (ctx: TContext) => boolean;
}
export declare function createBaleProactiveBeforeAgentStartHook<TContext>(deps: BaleProactivePromptHookDeps<TContext>): (event: BaleBeforeAgentStartEvent, ctx: TContext) => Promise<BaleProactiveBeforeAgentStartResult | undefined>;
export {};
