/**
 * Bale session lifecycle coordination and hook registration
 * Zones: pi agent lifecycle, bale session
 * Owns context generations, bounded connect intent across resume, and session sequencing.
 * Transport authority, durable bindings, and queue custody remain with their owners.
 */
import * as BusFollower from "./bus-follower.ts";
import type { AgentEndEvent, AgentSettledEvent, AgentStartEvent, AssistantMessageEvent, BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI, ExtensionContext, InputEvent, MessageEndEvent, SessionBeforeCompactEvent, SessionCompactEvent, SessionCompactFailedEvent, SessionShutdownEvent, SessionStartEvent, ToolExecutionEndEvent, ToolExecutionStartEvent, ToolExecutionUpdateEvent, TurnEndEvent, TurnEndEventResult, UIPromptEndEvent, UIPromptStartEvent } from "./pi.ts";
import * as Machine from "./machine.ts";
import * as Queue from "./queue.ts";
export declare function createAgentStartDedupHook(inner: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>, resetReplyDedup: () => void, schedulePublication?: (task: () => Promise<void>) => void): (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
type BaleBeforeAgentStartEvent = Omit<BeforeAgentStartEvent, "systemPrompt"> & {
    systemPrompt: string | string[];
};
export interface BaleBeforeAgentStartResult {
    systemPrompt?: string | string[];
    message?: BeforeAgentStartEventResult["message"];
}
type BaleBeforeAgentStartReturn = Promise<BaleBeforeAgentStartResult | undefined> | BaleBeforeAgentStartResult | undefined;
type BaleLifecycleModel = ExtensionContext["model"];
type BaleLifecycleMessage = AgentEndEvent["messages"][number];
export interface BaleLifecycleRegistrationDeps {
    isSessionActive?: (ctx: ExtensionContext) => boolean;
    onInput?: (event: InputEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionBeforeCompact?: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionCompact?: (event: SessionCompactEvent, ctx: ExtensionContext) => Promise<void> | void;
    onSessionCompactFailed?: (event: SessionCompactFailedEvent, ctx: ExtensionContext) => Promise<void> | void;
    onBeforeAgentStart: (event: BaleBeforeAgentStartEvent, ctx: ExtensionContext) => BaleBeforeAgentStartReturn;
    onModelSelect: (event: {
        model: BaleLifecycleModel;
    }, ctx: ExtensionContext) => Promise<void> | void;
    onTurnEnd?: (event: TurnEndEvent, ctx: ExtensionContext) => TurnEndEventResult | undefined;
    onAgentStart: (event: AgentStartEvent, ctx: ExtensionContext) => Promise<void>;
    onToolExecutionStart: (event: ToolExecutionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
    onToolExecutionUpdate?: (event: ToolExecutionUpdateEvent, ctx: ExtensionContext) => Promise<void> | void;
    onToolExecutionEnd: (event: ToolExecutionEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onMessageStart: (event: {
        message: BaleLifecycleMessage;
    }, ctx: ExtensionContext) => Promise<void>;
    onMessageUpdate: (event: {
        message: BaleLifecycleMessage;
        assistantMessageEvent?: AssistantMessageEvent;
    }, ctx: ExtensionContext) => Promise<void>;
    onMessageEnd?: (event: MessageEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onUiPromptStart?: (event: UIPromptStartEvent, ctx: ExtensionContext) => Promise<void> | void;
    onUiPromptEnd?: (event: UIPromptEndEvent, ctx: ExtensionContext) => Promise<void> | void;
    onAgentEnd: (event: AgentEndEvent, ctx: ExtensionContext) => Promise<void>;
    onAgentSettled?: (event: AgentSettledEvent, ctx: ExtensionContext) => Promise<void> | void;
}
export interface BaleSessionLifecycleHooks {
    onSessionStart: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
}
export interface BaleConnectionIntent {
    id: string;
    cwd: string;
    profileName?: string;
}
interface BaleConnectionHandoff extends BaleConnectionIntent {
    pid: number;
    targetSessionFile: string;
    expiresAtMs: number;
}
export interface BaleConnectionHandoffStore {
    pending?: BaleConnectionHandoff;
}
export interface BaleConnectionLifecycle {
    prepare(event: SessionStartEvent, ctx: ExtensionContext): (() => void) | undefined;
    onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): void;
}
export declare function createBaleConnectionLifecycle(deps: {
    intent: ReturnType<typeof createBaleConnectionIntentRuntime>;
    getGeneration(): number;
    isCurrent(ctx: ExtensionContext): boolean;
    getProfileName(): string | undefined;
    isConnected(): boolean;
    activateProfile(profileName: string | undefined, isCurrent: () => boolean): Promise<boolean>;
    start(ctx: ExtensionContext): Promise<{
        ok: boolean;
        message?: string;
    }>;
    recordError(error: unknown): void;
}): BaleConnectionLifecycle;
export declare function createBaleConnectionIntentRuntime(options?: {
    store?: BaleConnectionHandoffStore;
    now?: () => number;
    pid?: number;
}): {
    begin(cwd: string, profileName?: string): string;
    isActive(id: string): boolean;
    finish(id: string): void;
    cancel(): void;
    suspend(input: {
        reason: string;
        cwd: string;
        targetSessionFile?: string;
        connected: boolean;
        profileName?: string;
    }): void;
    resume(input: {
        reason: string;
        cwd: string;
        sessionFile?: string;
    }): BaleConnectionIntent | undefined;
};
export interface BaleSessionContextStore<TContext> {
    get: () => TContext | undefined;
    getGeneration: () => number;
    isCurrent: (ctx: TContext, generation?: number) => boolean;
    set: (ctx: TContext) => number;
    clear: (ctx?: TContext) => boolean;
}
export declare function createBaleSessionContextStore<TContext>(options?: {
    getIdentity?: (ctx: TContext) => unknown;
}): BaleSessionContextStore<TContext>;
/** Capture drain hints at work admission; late completion never borrows a replacement session or transport. */
export declare function createBaleSessionDrainObserver<TContext, TAuthority>(deps: {
    context: Pick<BaleSessionContextStore<TContext>, "get" | "getGeneration" | "isCurrent">;
    captureAuthority: () => TAuthority | undefined;
    isAuthorityActive: (authority: TAuthority) => boolean;
    onDrained: (ctx: TContext) => void;
}): () => (() => void) | undefined;
export declare function createBaleSessionGenerationFence(store: BaleSessionContextStore<ExtensionContext>, hooks: BaleSessionLifecycleHooks): BaleSessionLifecycleHooks;
export interface BaleBridgeSessionServiceRuntime {
    connection?: BaleConnectionLifecycle;
    resumeGroupedInput(ctx: ExtensionContext): void;
    suspendGroupedInput(): void;
    delivery: {
        onSessionStart(): Promise<void>;
        onSessionShutdown(): Promise<void>;
    };
    polling: {
        onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
    };
    inboundWorker: {
        onSessionShutdown(): Promise<void>;
    };
    capabilityMonitor: {
        start(ctx: ExtensionContext): void;
        stop(): void;
    };
    queueWatchdog: {
        start(ctx: ExtensionContext): void;
        stop(): void;
    };
    guestPlaceholder?: {
        stopAll(): void;
    };
    prepareThreadPreservationOnQuit?: (isSessionCurrent: () => boolean) => (() => Promise<void>) | undefined;
}
export interface BaleBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel = unknown> {
    contextStore: BaleSessionContextStore<ExtensionContext>;
    queue: Omit<Queue.BaleSessionLifecycleRuntimeDeps<ExtensionContext, TQueueItem, TModel>, "isSessionActive" | "stopPolling" | "clearPendingMediaGroups">;
    follower: Omit<BusFollower.BaleBusFollowerSessionRefreshHookDeps<ExtensionContext>, "isSessionActive"> & BusFollower.BaleBusFollowerSessionReplacementSuspenderDeps;
    services: BaleBridgeSessionServiceRuntime;
}
export interface BaleBridgeSessionLifecyclePorts<TQueueItem, TModel = unknown> {
    contextStore: BaleSessionContextStore<ExtensionContext>;
    queue: Omit<Queue.BaleSessionLifecycleRuntimeDeps<ExtensionContext, TQueueItem, TModel>, "isSessionActive" | "stopPolling" | "clearPendingMediaGroups">;
    follower: Omit<BusFollower.BaleBusFollowerSessionRefreshHookDeps<ExtensionContext>, "isSessionActive"> & BusFollower.BaleBusFollowerSessionReplacementSuspenderDeps;
    services: {
        mediaGroup: {
            resume(ctx: ExtensionContext): void;
            suspend(): void;
        };
        textGroup: {
            resume(ctx: ExtensionContext): void;
            suspend(): void;
        };
        delivery: BaleBridgeSessionServiceRuntime["delivery"];
        polling: BaleBridgeSessionServiceRuntime["polling"];
        connection?: BaleBridgeSessionServiceRuntime["connection"];
        inboundWorker: BaleBridgeSessionServiceRuntime["inboundWorker"];
        capabilityMonitor: BaleBridgeSessionServiceRuntime["capabilityMonitor"];
        queueWatchdog: BaleBridgeSessionServiceRuntime["queueWatchdog"];
        guestPlaceholder?: BaleBridgeSessionServiceRuntime["guestPlaceholder"];
        prepareThreadPreservationOnQuit?: BaleBridgeSessionServiceRuntime["prepareThreadPreservationOnQuit"];
    };
}
export declare function createBaleBridgeSessionLifecycleDeps<TQueueItem, TModel = unknown>(ports: BaleBridgeSessionLifecyclePorts<TQueueItem, TModel>): BaleBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel>;
export declare function createBaleBridgeSessionLifecycleAssembly<TQueueItem, TModel = unknown>(deps: BaleBridgeSessionLifecycleAssemblyDeps<TQueueItem, TModel>): BaleSessionLifecycleHooks;
type BaleLifecycleTimer = number | ReturnType<typeof setTimeout>;
export interface BaleCompactionObserverRuntimeDeps<TContext> {
    isContextActive?: (ctx: TContext) => boolean;
    setCompactionInProgress: (inProgress: boolean) => void;
    updateStatus: (ctx: TContext) => void;
    startTypingLoop?: (ctx: TContext) => boolean | void;
    stopTypingLoop?: () => void;
    requestDeferredDispatchNextQueuedBaleTurn: (dispatch: (ctx: TContext) => void) => void;
    dispatchNextQueuedBaleTurn: (ctx: TContext) => void;
    recordRuntimeEvent?: (category: string, error: unknown) => void;
    onCompactionAbandoned?: () => void;
    timeoutMs?: number;
    setTimer?: (callback: () => void, ms: number) => BaleLifecycleTimer;
    clearTimer?: (timer: BaleLifecycleTimer) => void;
}
export interface BaleCompactionObserverRuntime<TContext> {
    onSessionBeforeCompact: (event: SessionBeforeCompactEvent, ctx: TContext) => void;
    onSessionCompact: (event: SessionCompactEvent, ctx: TContext) => void;
    onSessionCompactFailed: (event: SessionCompactFailedEvent, ctx: TContext) => void;
    onSessionShutdown: () => void;
}
/** The whole compaction-observer state; only `transitionBaleCompactionObserver` produces a new one. */
export interface BaleCompactionObserverState {
    /** The fallback timer's observation; a timer from any other one is inert. */
    readonly observation: number | null;
    /** The typing loop is the observer's to stop; a loop the agent already ran is never stopped by compaction. */
    readonly typingOwned: boolean;
    readonly nextObservation: number;
}
export type BaleCompactionObserverEvent = {
    type: "beforeCompact";
}
/** The outcome of the observer's own typing start, reported back by the shell. */
 | {
    type: "typingStarted";
    started: boolean;
} | {
    type: "compacted";
} | {
    type: "compactFailed";
} | {
    type: "timerFired";
    observation: number;
    contextActive: boolean;
} | {
    type: "shutdown";
};
export type BaleCompactionObserverEffect = {
    type: "setInProgress";
    inProgress: boolean;
} | {
    type: "startTyping";
} | {
    type: "stopTyping";
} | {
    type: "updateStatus";
} | {
    type: "armTimer";
    observation: number;
} | {
    type: "cancelTimer";
} | {
    type: "recordTimeout";
} | {
    type: "abandoned";
} | {
    type: "requestDispatch";
};
export declare function createBaleCompactionObserverState(): BaleCompactionObserverState;
/**
 * Pure compaction-observer transition. A completion or failure always releases presence; the timeout releases only its
 * own observation. Typing ownership is sticky: a repeated start while the observer's own loop runs reports `false`
 * from the shared loop, and must not hand that loop to nobody.
 */
export declare function transitionBaleCompactionObserver(state: BaleCompactionObserverState, event: BaleCompactionObserverEvent): Machine.BaleMachineStep<BaleCompactionObserverState, BaleCompactionObserverEffect>;
/**
 * The shell around `transitionBaleCompactionObserver`: it fences inactive contexts, runs effects with the calling
 * context, reports the typing start back and owns the fallback timer, which keeps the context it was armed under.
 */
export declare function createBaleCompactionObserverRuntime<TContext>(deps: BaleCompactionObserverRuntimeDeps<TContext>): BaleCompactionObserverRuntime<TContext>;
export interface BaleMessageActivityTypingDeps<TContext> {
    hasActiveTurn: () => boolean;
    isContextActive?: (ctx: TContext) => boolean;
    getSessionGeneration?: () => number;
    startTypingLoop: (ctx: TContext) => void;
    onMessageStart: BaleLifecycleRegistrationDeps["onMessageStart"];
    onMessageUpdate: BaleLifecycleRegistrationDeps["onMessageUpdate"];
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export declare function createBaleMessageActivityTypingHooks<TContext extends ExtensionContext>(deps: BaleMessageActivityTypingDeps<TContext>): Pick<BaleLifecycleRegistrationDeps, "onMessageStart" | "onMessageUpdate">;
export interface BaleExtraLifecycleHooks {
    onSessionStart?: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
    onSessionShutdown?: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>;
}
export declare function appendBaleLifecycleHooks(base: BaleSessionLifecycleHooks, extra: BaleExtraLifecycleHooks, isSessionActive?: (ctx: ExtensionContext) => boolean): BaleSessionLifecycleHooks;
export declare function registerBaleLifecycleHooks(pi: ExtensionAPI, deps: BaleLifecycleRegistrationDeps): void;
export {};
