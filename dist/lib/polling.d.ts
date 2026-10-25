/**
 * Bale polling runtime domain helpers
 * Zones: bale transport, polling runtime
 * Owns polling request builders, stop conditions, and the long-poll loop runtime for Bale updates
 */
type MaybePromise<T> = T | Promise<T>;
/**
 * Structural port for run-collapsing diagnostics: a repeated identical failure extends its run instead of logging
 * again, and the closing success records one outcome. The composition root owns the collapsed implementation.
 */
export interface BaleRepeatedFailureLogPort {
    record: (error: unknown, details?: Record<string, unknown>) => void;
    settled: () => void;
    reset: () => void;
}
export interface BalePollingConfig {
    botToken?: string;
}
export interface BaleUpdate {
    update_id: number;
}
export declare const BALE_GET_UPDATES_CONFLICT_STOP_LIMIT = 10;
export declare const BALE_ALLOWED_UPDATES: readonly ["message", "edited_message", "callback_query", "message_reaction", "guest_message"];
export declare function buildBaleInitialSyncRequest(): {
    offset: number;
    limit: number;
    timeout: number;
};
export declare function buildBaleLongPollRequest(lastUpdateId?: number): {
    offset?: number;
    limit: number;
    timeout: number;
    allowed_updates: readonly string[];
};
export declare function getLatestBaleUpdateId(updates: readonly BaleUpdate[]): number | undefined;
export declare class BalePersistentGetUpdatesConflictError extends Error {
    readonly count: number;
    constructor(count: number);
}
/** Exponential backoff for non-conflict polling/admission failures. */
export declare function getBalePollingRetryDelayMs(consecutiveFailures: number): number;
export declare class BaleGetUpdatesTimeoutError extends Error {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
export declare function getBaleGetUpdatesRequestBudgetMs(body: Record<string, unknown>, graceMs?: number): number;
export declare function shouldStopBalePolling(signalAborted: boolean, error: unknown): boolean;
export interface BalePollingStartState {
    hasBotToken: boolean;
    hasPollingPromise: boolean;
}
export type BalePollingWorkPhase = "long-poll" | "persisting-journal" | "persisting-offset" | "retrying";
export type BalePollingPhase = "stopped" | "starting" | BalePollingWorkPhase;
export type BalePollingStopReason = "not-started" | "requested" | "completed" | "failed" | "persistent-conflict";
export interface BalePollingStateSnapshot {
    phase: BalePollingPhase;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    startedAtMs?: number;
    stoppedAtMs?: number;
    lastSuccessfulResponseAtMs?: number;
    lastSuccessfulResponseUpdateCount?: number;
    stopReason?: BalePollingStopReason;
}
export interface BalePollingControllerState extends BalePollingStateSnapshot {
    pollingPromise?: Promise<void>;
    pollingController?: AbortController;
}
export declare function createBalePollingControllerState(): BalePollingControllerState;
export declare function createBalePollingStateReader(state: BalePollingControllerState): () => BalePollingStateSnapshot;
export declare function isBalePollingControllerActive(state: BalePollingControllerState): boolean;
export declare function createBalePollingActivityReader(state: BalePollingControllerState): () => boolean;
export interface BalePollingRuntimeDeps<TContext> extends BaleRuntimeEventRecorderPort {
    hasBotToken: () => boolean;
    getPollingPromise: () => Promise<void> | undefined;
    setPollingPromise: (promise: Promise<void> | undefined) => void;
    getPollingController: () => AbortController | undefined;
    setPollingController: (controller: AbortController | undefined) => void;
    stopTypingLoop: () => unknown;
    runPollLoop: (ctx: TContext, signal: AbortSignal) => Promise<void>;
    updateStatus: (ctx: TContext, message?: string) => void;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    onPollingStateChange?: () => void;
    onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
    onPollingStarted?: () => void;
    onPollingStopped?: (reason: BalePollingStopReason) => void;
}
export type BalePollingControllerDeps<TContext> = Omit<BalePollingRuntimeDeps<TContext>, "getPollingPromise" | "setPollingPromise" | "getPollingController" | "setPollingController"> & {
    state?: BalePollingControllerState;
};
export interface BalePollingController<TContext> {
    isActive: () => boolean;
    start: (ctx: TContext) => void;
    stop: () => Promise<void>;
}
export interface BalePollingAdmissionRuntime<TContext> {
    isActive: () => boolean;
    start: (ctx: TContext) => Promise<void>;
    stop: () => Promise<void>;
}
export declare function createBalePollingAdmissionRuntime<TContext>(deps: {
    polling: BalePollingController<TContext>;
    prepareStart?: () => MaybePromise<void>;
    canStart?: (ctx: TContext) => boolean;
    validateStart?: () => void;
    worker: {
        onSessionStart: (ctx: TContext) => Promise<void>;
    };
}): BalePollingAdmissionRuntime<TContext>;
export interface BaleDurablePollingRuntimeAssembly<TContext> {
    controller: BalePollingController<TContext>;
    admission: BalePollingAdmissionRuntime<TContext>;
}
export type BaleDurablePollingRuntimeAssemblyDeps<TUpdate extends BaleUpdate, TContext> = Omit<BalePollingControllerRuntimeDeps<TUpdate, TContext>, "appendUpdateBatch" | "getJournalEntryCount" | "signalUpdateWorker"> & {
    canStart?: (ctx: TContext) => boolean;
    prepareUpdateBatch?: (updates: readonly TUpdate[]) => void;
    journal: {
        appendBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => {
            nonExcludedUpdateIds: readonly number[];
        };
        getAcceptedThroughUpdateId: () => number | undefined;
        prepareCursorCutover?: () => MaybePromise<void>;
        getEntryCount: () => number;
        signalWorker: () => void;
        getBootstrapEntryCount: () => number;
        onSessionStart: (ctx: TContext) => Promise<void>;
    };
};
/** Own journal-first polling assembly and cursor bootstrap validation. */
export declare function createBaleDurablePollingRuntimeAssembly<TUpdate extends BaleUpdate, TContext>(deps: BaleDurablePollingRuntimeAssemblyDeps<TUpdate, TContext>): BaleDurablePollingRuntimeAssembly<TContext>;
export type BalePollingControllerRuntimeDeps<TUpdate extends BaleUpdate, TContext = unknown> = Omit<BalePollLoopRunnerDeps<TUpdate, TContext>, "onPhaseChange" | "onSuccessfulResponse"> & {
    state?: BalePollingControllerState;
    hasBotToken: () => boolean;
    stopTypingLoop: () => unknown;
    createAbortController?: () => AbortController;
    getNowMs?: () => number;
    onPollingStateChange?: () => void;
    onPersistentConflict?: (ctx: TContext, count: number) => MaybePromise<void>;
};
export declare function createBalePollingControllerRuntime<TUpdate extends BaleUpdate, TContext = unknown>(deps: BalePollingControllerRuntimeDeps<TUpdate, TContext>): BalePollingController<TContext>;
export declare function createBalePollingController<TContext>(deps: BalePollingControllerDeps<TContext>): BalePollingController<TContext>;
export declare function shouldStartBalePolling(state: BalePollingStartState): boolean;
export declare function stopBalePollingRuntime<TContext>(deps: BalePollingRuntimeDeps<TContext>): Promise<void>;
export declare function startBalePollingRuntime<TContext>(ctx: TContext, deps: BalePollingRuntimeDeps<TContext>): void;
export interface BaleRuntimeEventRecorderPort {
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type BaleThreadCapabilityMode = "enabled" | "disabled" | "unknown";
export interface BaleThreadCapabilityState {
    threadMode?: BaleThreadCapabilityMode;
    updatedAtMs?: number;
    lastSlot?: string;
    lastReconcileAction?: string;
}
export interface BaleThreadCapabilityRecordView {
    status?: string;
    target?: {
        chatId?: number;
        threadId?: number;
    };
}
export interface BaleThreadCapabilityStore {
    load: () => Promise<void>;
    refresh?: () => Promise<void>;
    persist: () => Promise<void>;
    getBotState: () => BaleThreadCapabilityState;
    setBotState: (state: BaleThreadCapabilityState) => void;
    list?: () => BaleThreadCapabilityRecordView[];
}
export interface BaleThreadCapabilityReaderDeps {
    getAllowedUserId: () => number | undefined;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
}
interface BaleThreadCapabilityLifecycle {
    capture: () => () => boolean;
    invalidate: () => void;
}
export interface BaleStartupThreadCapabilityProbeDeps extends BaleThreadCapabilityReaderDeps {
    topicTargetStore: BaleThreadCapabilityStore;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    setTopicModeUnavailable: (unavailable: boolean) => void;
    getNowMs?: () => number;
}
export interface BaleThreadCapabilityRuntimeDeps<TContext> extends BaleThreadCapabilityReaderDeps {
    /** Collapses one sustained probe failure run; the caller supplies its owner. */
    failureLog: BaleRepeatedFailureLogPort;
    lifecycle?: BaleThreadCapabilityLifecycle;
    topicTargetStore: BaleThreadCapabilityStore;
    ownsLock: (ctx: TContext) => boolean;
    isFollowerRegistered?: () => boolean;
    getPollingStartedWithBaleBus: () => boolean;
    setPollingStartedWithBaleBus: (started: boolean) => void;
    setTopicModeUnavailable: (unavailable: boolean) => void;
    suspendLiveThreadTarget?: () => void;
    stopFollowerRegistration: () => void;
    startClassicPolling: (ctx: TContext) => MaybePromise<void>;
    stopClassicPolling: () => MaybePromise<void>;
    startBusPolling: (ctx: TContext) => MaybePromise<void>;
    stopBusPolling: () => MaybePromise<void>;
    startLeaderHealth: () => void;
    stopLeaderHealth: () => void;
    isTopicModeUnavailableError?: (error: unknown) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    intervalMs?: number;
}
export interface BaleThreadCapabilityMonitor<TContext> {
    start: (ctx: TContext) => void;
    stop: () => void;
}
export interface BaleThreadCapabilityStateRuntime {
    isBusPollingStarted(): boolean;
    setBusPollingStarted(started: boolean): void;
    isTopicModeUnavailable(): boolean;
    setTopicModeUnavailable(unavailable: boolean): void;
    isBusRuntimeEnabled(): boolean;
    shouldForceFreshLeaderThread(): boolean;
    setForceFreshLeaderThread(forceFresh: boolean): void;
    getRequestedThreadName(): string | undefined;
    setRequestedThreadName(threadName: string | undefined): void;
}
export type BaleThreadTargetObservationHandler<TContext> = (ctx: TContext) => Promise<void>;
export interface BaleThreadTargetObservationBinding<TContext> {
    handle: BaleThreadTargetObservationHandler<TContext>;
    set(handler: BaleThreadTargetObservationHandler<TContext>): void;
}
export declare function createBaleThreadTargetObservationBinding<TContext>(): BaleThreadTargetObservationBinding<TContext>;
export interface BaleThreadAwarePollingPorts<TContext, TOwner> {
    startPolling: (ctx: TContext, options?: {
        forceFreshLeaderThread?: boolean;
    }) => Promise<void>;
    stopPolling: () => Promise<void>;
    registerFollowerWithOwner: (ctx: TContext, owner: TOwner, options?: {
        recoverConnection?: boolean;
    }) => Promise<boolean | undefined>;
    restoreFollowerWithOwner: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    stopFollowerRegistration: () => void;
}
/** Classic/leader polling and follower registration controls that thread-aware polling switches between. */
export interface BaleThreadAwarePollingControls<TContext, TOwner> {
    startClassicPolling: (ctx: TContext) => MaybePromise<void>;
    stopClassicPolling: () => Promise<void>;
    startBusLeaderPolling: (ctx: TContext) => Promise<void>;
    stopBusLeaderPolling: () => Promise<void>;
    startLeaderHealth: () => void;
    stopLeaderHealth: () => void;
    registerFollowerWithLeader: (ctx: TContext, owner: TOwner, options?: {
        recoverConnection?: boolean;
    }) => Promise<boolean | undefined>;
    restoreFollowerWithLeader?: (ctx: TContext, owner: TOwner) => Promise<boolean | undefined>;
    hasRememberedWorkspaceBinding?: (ctx: TContext) => boolean;
    stopFollowerRegistration: () => void;
    isBusRuntimeEnabled: () => boolean;
    isTopicModeUnavailableError: (error: unknown) => boolean;
}
export interface BaleThreadAwarePollingDeps<TContext, TOwner> extends BaleStartupThreadCapabilityProbeDeps, BaleThreadAwarePollingControls<TContext, TOwner> {
    lifecycle?: BaleThreadCapabilityLifecycle;
    getPollingStartedWithBaleBus: () => boolean;
    setPollingStartedWithBaleBus: (started: boolean) => void;
    setForceFreshLeaderThreadOnNextStart: (forceFresh: boolean) => void;
}
export interface BaleThreadCapabilityOrchestrationDeps<TContext, TOwner> extends BaleThreadCapabilityReaderDeps, BaleThreadAwarePollingControls<TContext, TOwner> {
    /** Collapses one sustained probe failure run; the composition root supplies its owner. */
    failureLog: BaleRepeatedFailureLogPort;
    state: BaleThreadCapabilityStateRuntime;
    topicTargetStore: BaleThreadCapabilityStore;
    ownsLock: (ctx: TContext) => boolean;
    isFollowerRegistered?: () => boolean;
    suspendLiveThreadTarget?: () => void;
    updateStatus: (ctx: TContext) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleThreadCapabilityOrchestration<TContext, TOwner> {
    monitor: BaleThreadCapabilityMonitor<TContext>;
    observeTarget: BaleThreadTargetObservationHandler<TContext>;
    pollingPorts: BaleThreadAwarePollingPorts<TContext, TOwner>;
}
export declare function createBaleThreadCapabilityStateRuntime(): BaleThreadCapabilityStateRuntime;
export declare function createBaleThreadCapabilityOrchestration<TContext, TOwner>(deps: BaleThreadCapabilityOrchestrationDeps<TContext, TOwner>): BaleThreadCapabilityOrchestration<TContext, TOwner>;
export declare function applyBaleThreadCapability<TContext>(ctx: TContext, threadModeEnabled: boolean, phase: string, deps: BaleThreadCapabilityRuntimeDeps<TContext>, isCurrent?: () => boolean): Promise<void>;
export declare function createBaleThreadAwarePollingPorts<TContext, TOwner>(deps: BaleThreadAwarePollingDeps<TContext, TOwner>): BaleThreadAwarePollingPorts<TContext, TOwner>;
export declare function canProbeBaleThreadCapability<TContext>(ctx: TContext, deps: Pick<BaleThreadCapabilityRuntimeDeps<TContext>, "ownsLock" | "isFollowerRegistered">): boolean;
export declare function createBaleThreadCapabilityMonitor<TContext>(deps: BaleThreadCapabilityRuntimeDeps<TContext>): BaleThreadCapabilityMonitor<TContext>;
export declare class BalePollingBatchValidationError extends Error {
    constructor(message: string);
}
export declare class BalePollingCursorBootstrapError extends Error {
    constructor(message: string);
}
export interface BalePollingCursorCutoverDeps {
    getLegacyCursor: () => number | undefined;
    readJournal: () => {
        acceptedThroughUpdateId?: number;
        entries: readonly {
            updateId: number;
        }[];
    };
    publishJournalCursor: (acceptedThroughUpdateId: number) => MaybePromise<void>;
    removeLegacyCursor: () => MaybePromise<void>;
}
/** Transfer one legacy config cursor into journal authority before deleting it. */
export declare function cutOverBalePollingCursor(deps: BalePollingCursorCutoverDeps): Promise<void>;
export interface BalePollingBatchAdmissionResult {
    updateCount: number;
    latestUpdateId?: number;
}
export interface BalePollingBatchAdmissionDeps<TUpdate extends BaleUpdate> extends BaleRuntimeEventRecorderPort {
    updates: readonly TUpdate[];
    config: BalePollingConfig;
    appendBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => MaybePromise<unknown>;
    getAcceptedThroughUpdateId?: () => number | undefined;
    persistConfig: (config: BalePollingConfig) => Promise<void>;
    signalWorker: () => void;
    onPhaseChange?: (phase: BalePollingWorkPhase, currentUpdateId?: number) => void;
}
export declare function admitBalePollingUpdateBatch<TUpdate extends BaleUpdate>(deps: BalePollingBatchAdmissionDeps<TUpdate>): Promise<BalePollingBatchAdmissionResult>;
/** Bot API, journal and progress ports shared by one poll loop and its restartable runner. */
export interface BalePollLoopTransportPorts<TUpdate extends BaleUpdate> extends BaleRuntimeEventRecorderPort {
    deleteWebhook: (signal: AbortSignal) => Promise<unknown>;
    getUpdates: (body: Record<string, unknown>, signal: AbortSignal) => Promise<TUpdate[]>;
    getUpdatesRequestBudgetMs?: (body: Record<string, unknown>) => number;
    persistConfig: (config: BalePollingConfig) => Promise<void>;
    appendUpdateBatch: (updates: readonly TUpdate[], acceptedThroughUpdateId?: number) => MaybePromise<unknown>;
    getAcceptedThroughUpdateId?: () => number | undefined;
    getJournalEntryCount: () => number;
    signalUpdateWorker: () => void;
    onPhaseChange?: (phase: BalePollingWorkPhase, currentUpdateId?: number) => void;
    onSuccessfulResponse?: (updateCount: number) => void;
}
export interface BalePollLoopDeps<TUpdate extends BaleUpdate, TContext = unknown> extends BalePollLoopTransportPorts<TUpdate> {
    ctx: TContext;
    signal: AbortSignal;
    config: BalePollingConfig;
    onErrorStatus: (message: string) => void;
    onStatusReset: () => void;
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export interface BalePollLoopRunnerDeps<TUpdate extends BaleUpdate, TContext = unknown> extends BalePollLoopTransportPorts<TUpdate> {
    getConfig: () => BalePollingConfig;
    updateStatus: (ctx: TContext, message?: string) => void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}
export declare function sleepBalePollingRetry(ms: number, signal?: AbortSignal): Promise<void>;
export declare function createBalePollLoopRunner<TUpdate extends BaleUpdate, TContext = unknown>(deps: BalePollLoopRunnerDeps<TUpdate, TContext>): (ctx: TContext, signal: AbortSignal) => Promise<void>;
export declare function isBaleGetUpdatesConflictError(error: unknown): boolean;
export declare function runBalePollLoop<TUpdate extends BaleUpdate, TContext = unknown>(deps: BalePollLoopDeps<TUpdate, TContext>): Promise<void>;
export {};
