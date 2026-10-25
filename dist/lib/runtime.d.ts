/**
 * Bale bridge runtime-state helpers
 * Zones: pi agent runtime state, bale session, shared coordination
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Bale transport
 */
import * as Machine from "./machine.ts";
/**
 * Structural port for run-collapsing diagnostics: a repeated identical failure extends its run instead of logging
 * again, and the closing success records one outcome. The composition root owns the collapsed implementation.
 */
export interface BaleRepeatedFailureLogPort {
    record: (error: unknown, details?: Record<string, unknown>) => void;
    settled: () => void;
    reset: () => void;
}
export interface BaleRuntimeQueueCounters {
    nextQueuedBaleItemOrder: number;
    nextQueuedBaleControlOrder: number;
}
export interface BaleRuntimeLifecycleFlags {
    activeBaleToolExecutions: number;
    baleTurnDispatchPending: boolean;
    compactionInProgress: boolean;
    foldQueuedPromptsIntoHistory: boolean;
    setupInProgress: boolean;
}
export interface BaleBridgeRuntimeState extends BaleRuntimeQueueCounters, BaleRuntimeLifecycleFlags {
    abortHandler?: () => void;
}
export interface BaleRuntimeQueuePort {
    syncCounters: (counters: Partial<BaleRuntimeQueueCounters>) => void;
    allocateItemOrder: () => number;
    allocateControlOrder: () => number;
}
export interface BaleRuntimeLifecyclePort {
    syncFlags: (flags: Partial<BaleRuntimeLifecycleFlags>) => void;
    getActiveToolExecutions: () => number;
    setActiveToolExecutions: (count: number) => void;
    resetActiveToolExecutions: () => void;
    hasDispatchPending: () => boolean;
    setDispatchPending: (pending: boolean) => void;
    clearDispatchPending: () => void;
    isCompactionInProgress: () => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    shouldFoldQueuedPromptsIntoHistory: () => boolean;
    setFoldQueuedPromptsIntoHistory: (fold: boolean) => void;
}
export interface BaleRuntimeSetupPort {
    isInProgress: () => boolean;
    start: () => boolean;
    finish: () => void;
}
export interface BaleRuntimeAbortPort {
    hasHandler: () => boolean;
    setHandler: (abortHandler: () => void) => void;
    clearHandler: () => void;
    getHandler: () => (() => void) | undefined;
    abortTurn: () => boolean;
}
export interface BaleRuntimeTypingPort {
    start: (deps: BaleTypingLoopDeps) => boolean;
    stop: () => boolean;
    /** Waits for the in-flight action, bounded so a never-settling request cannot hold shutdown. */
    waitForIdle: (timeoutMs?: number) => Promise<void>;
}
export interface BaleBridgeRuntime {
    state: BaleBridgeRuntimeState;
    queue: BaleRuntimeQueuePort;
    lifecycle: BaleRuntimeLifecyclePort;
    setup: BaleRuntimeSetupPort;
    abort: BaleRuntimeAbortPort;
    typing: BaleRuntimeTypingPort;
}
export declare function createBaleBridgeRuntimeState(): BaleBridgeRuntimeState;
export declare function createBaleBridgeRuntime(state?: BaleBridgeRuntimeState, typing?: BaleRuntimeTypingPort): BaleBridgeRuntime;
export declare function syncBaleQueueRuntimeCounters(state: BaleBridgeRuntimeState, counters: Partial<BaleRuntimeQueueCounters>): void;
export declare function allocateBaleQueueItemOrder(state: BaleBridgeRuntimeState): number;
export declare function allocateBaleQueueControlOrder(state: BaleBridgeRuntimeState): number;
export declare function syncBaleLifecycleRuntimeFlags(state: BaleBridgeRuntimeState, flags: Partial<BaleRuntimeLifecycleFlags>): void;
export declare function getActiveBaleToolExecutions(state: BaleBridgeRuntimeState): number;
export declare function setActiveBaleToolExecutions(state: BaleBridgeRuntimeState, count: number): void;
export declare function resetActiveBaleToolExecutions(state: BaleBridgeRuntimeState): void;
export declare function hasBaleDispatchPending(state: BaleBridgeRuntimeState): boolean;
export declare function clearBaleDispatchPending(state: BaleBridgeRuntimeState): void;
export declare function isBaleCompactionInProgress(state: BaleBridgeRuntimeState): boolean;
export declare function setBaleCompactionInProgress(state: BaleBridgeRuntimeState, inProgress: boolean): void;
export declare function shouldFoldQueuedPromptsIntoHistory(state: BaleBridgeRuntimeState): boolean;
export declare function setFoldQueuedPromptsIntoHistory(state: BaleBridgeRuntimeState, fold: boolean): void;
export declare function isBaleSetupInProgress(state: BaleBridgeRuntimeState): boolean;
export declare function startBaleSetup(state: BaleBridgeRuntimeState): boolean;
export declare function finishBaleSetup(state: BaleBridgeRuntimeState): void;
export declare function hasBaleAbortHandler(state: BaleBridgeRuntimeState): boolean;
export declare function setBaleAbortHandler(state: BaleBridgeRuntimeState, abortHandler: () => void): void;
export declare function clearBaleAbortHandler(state: BaleBridgeRuntimeState): void;
export declare function getBaleAbortHandler(state: BaleBridgeRuntimeState): (() => void) | undefined;
export declare function abortBaleTurn(state: BaleBridgeRuntimeState): boolean;
export interface BaleTypingLoopTarget {
    chatId: number;
    threadId?: number;
}
export interface BaleTypingLoopDeps {
    chatId: number | undefined;
    target?: BaleTypingLoopTarget;
    intervalMs: number;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
    }) => Promise<unknown>;
    shouldContinue?: () => boolean;
    onStopped?: () => void;
}
export interface BaleRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleTypingLoopStarterDeps<TContext> extends BaleRuntimeEventRecorderPort {
    /** Collapses one sustained presence failure run; the caller supplies its owner. */
    failureLog: BaleRepeatedFailureLogPort;
    typing: BaleRuntimeTypingPort;
    getDefaultChatId: () => number | undefined;
    sendTypingAction: (chatId: number, options?: {
        message_thread_id?: number;
        assertAuthority?: () => void;
    }) => Promise<unknown>;
    updateStatus: (ctx: TContext, error?: string) => void;
    isContextActive?: (ctx: TContext) => boolean;
    getSessionGeneration?: () => number;
    isTransportAvailable?: () => boolean;
    isThreadedMode?: () => boolean;
    getTransportAuthority?: () => string | number | undefined;
    intervalMs?: number;
}
export declare function createBaleTypingLoopStarter<TContext>(deps: BaleTypingLoopStarterDeps<TContext>): (ctx: TContext, chatId?: number, options?: {
    target?: BaleTypingLoopTarget;
    ensure?: boolean;
}) => boolean;
/** The whole typing-loop state; only `transitionBaleTypingLoop` produces a new one. */
export interface BaleTypingMachineState {
    /** The loop the interval serves; its callbacks live in the shell under `id`. A loop exists exactly while ticking. */
    readonly loop: {
        readonly id: number;
        readonly key: string;
        readonly chatId: number;
        readonly threadParams?: {
            readonly message_thread_id: number;
        };
    } | null;
    /** The action in flight; a tick waits for it, and replacing or stopping the loop forgets it. */
    readonly inFlight: number | null;
    readonly nextSendId: number;
}
export type BaleTypingEvent = {
    type: "started";
    /** Shell-assigned, so the shell can hold the caller's callbacks before effects run. */
    loopId: number;
    chatId: number | undefined;
    key: string;
    threadParams?: {
        message_thread_id: number;
    };
    intervalMs: number;
    /** The caller's `shouldContinue`, sampled at dispatch. */
    continues: boolean;
} | {
    type: "ticked";
    continues: boolean;
} | {
    type: "sendSettled";
    sendId: number;
} | {
    type: "stopRequested";
};
export type BaleTypingEffect = {
    type: "send";
    loopId: number;
    sendId: number;
    chatId: number;
    threadParams?: {
        message_thread_id: number;
    };
} | {
    type: "armInterval";
    intervalMs: number;
} | {
    type: "cancelInterval";
} | {
    type: "loopEnded";
    loopId: number;
};
export interface BaleTypingStep extends Machine.BaleMachineStep<BaleTypingMachineState, BaleTypingEffect> {
    /** `start`: a loop began or moved to a new target. `stop`: a running loop ended. */
    result: boolean;
}
export declare function createBaleTypingMachineState(): BaleTypingMachineState;
/**
 * Pure typing-loop transition. Every start replaces the caller's callbacks, even on the same target, and forgets the
 * old in-flight action; only a new target sends at once on a running loop, whose interval keeps its phase.
 */
export declare function transitionBaleTypingLoop(state: BaleTypingMachineState, event: BaleTypingEvent): BaleTypingStep;
/**
 * The shell around `transitionBaleTypingLoop`: it holds each loop's callbacks, samples `shouldContinue` into
 * events, owns the interval and turns every action outcome into `sendSettled`.
 */
export declare function createBaleTypingLoop(): BaleRuntimeTypingPort;
export declare function createBaleContextAbortHandlerSetter<TContext extends {
    abort: () => void;
}>(abort: Pick<BaleRuntimeAbortPort, "setHandler">): (ctx: TContext) => void;
export interface BaleAgentEndResetDeps {
    abort: Pick<BaleRuntimeAbortPort, "clearHandler">;
    typing: Pick<BaleRuntimeTypingPort, "stop">;
    clearActiveTurn: () => void;
    resetToolExecutions: () => void;
    clearPendingModelSwitch: () => void;
    clearDispatchPending: () => void;
}
export declare function createBaleAgentEndResetter(deps: BaleAgentEndResetDeps): () => void;
export interface BalePromptDispatchLifecycleDeps<TContext> extends BaleRuntimeEventRecorderPort {
    lifecycle: Pick<BaleRuntimeLifecyclePort, "setDispatchPending" | "clearDispatchPending">;
    typing: Pick<BaleRuntimeTypingPort, "stop">;
    startTypingLoop: (ctx: TContext, chatId?: number, options?: {
        target?: BaleTypingLoopTarget;
    }) => boolean | void;
    updateStatus: (ctx: TContext, error?: string) => void;
}
export interface BalePromptDispatchRuntimeDeps<TContext> extends BaleTypingLoopStarterDeps<TContext> {
    lifecycle: BalePromptDispatchLifecycleDeps<TContext>["lifecycle"];
}
export interface BalePromptDispatchRuntime<TContext> {
    startTypingLoop: (ctx: TContext, chatId?: number, options?: {
        target?: BaleTypingLoopTarget;
        ensure?: boolean;
    }) => boolean | void;
    onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: BaleTypingLoopTarget) => void;
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}
export declare function createBalePromptDispatchRuntime<TContext>(deps: BalePromptDispatchRuntimeDeps<TContext>): BalePromptDispatchRuntime<TContext>;
export declare function createBalePromptDispatchLifecycle<TContext>(deps: BalePromptDispatchLifecycleDeps<TContext>): {
    onPromptDispatchStart: (ctx: TContext, chatId?: number, target?: BaleTypingLoopTarget) => void;
    onPromptDispatchFailure: (ctx: TContext, message: string) => void;
};
