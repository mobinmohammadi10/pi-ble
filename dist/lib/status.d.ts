/**
 * Bale status rendering helpers
 * Zones: bale ui, pi agent diagnostics, tui
 * Owns status summaries, redacted diagnostics, projection lifecycle and compact connection-failure copy
 * Excludes canonical state, transport admission and filesystem policy
 */
/** UI copy is allowlisted; raw exception text belongs only in redacted diagnostics. */
export declare function formatBaleConnectionFailure(error: unknown): string;
export type BaleStatusQueueLane = "control" | "steer" | "priority" | "default";
export interface BaleUsageStats {
    totalInput: number;
    totalOutput: number;
    totalCacheRead: number;
    totalCacheWrite: number;
    totalCost: number;
    latestCacheHitRate?: number;
}
interface BaleUsageMessage {
    role: string;
    usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        cost: {
            total: number;
        };
    };
}
interface BaleStatusSessionEntry {
    type: string;
    message?: BaleUsageMessage;
}
interface BaleContextUsage {
    contextWindow?: number;
    percent: number | null;
}
export interface BaleStatusActiveModel {
    provider?: string;
    id?: string;
    contextWindow?: number;
}
export interface BaleStatusLineProviderContext {
    activeModel: BaleStatusActiveModel | undefined;
}
export interface BaleStatusLineProviderResult {
    label: string;
    value: string;
}
export type BaleStatusLineProvider = (ctx: BaleStatusLineProviderContext) => BaleStatusLineProviderResult | undefined;
export interface BaleStatusContext {
    sessionManager: {
        getEntries(): BaleStatusSessionEntry[];
    };
    getContextUsage(): BaleContextUsage | undefined;
    isIdle?: () => boolean;
    hasPendingMessages?: () => boolean;
    isCompactionInProgress?: () => boolean;
    modelRegistry: {
        isUsingOAuth(model: BaleStatusActiveModel): boolean;
    };
}
export type BaleRuntimeEventDetailValue = string | number | boolean | null;
export interface BaleRuntimeEvent {
    at: number;
    category: string;
    message: string;
    details?: Record<string, BaleRuntimeEventDetailValue>;
}
export interface BaleRuntimeEventInput {
    category: string;
    error?: unknown;
    message?: string;
    details?: Record<string, unknown>;
}
export interface BaleRuntimeEventRecorder {
    record: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getEvents: () => BaleRuntimeEvent[];
    clear: () => void;
}
export interface BaleRuntimeEventRecorderOptions {
    getBotToken: () => string | undefined;
    maxEvents?: number;
    now?: () => number;
}
export interface BaleBridgeStatusBusFollower {
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: {
        chatId: number;
        threadId?: number;
    };
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    slot?: string;
    threadName?: string;
    status?: string;
}
export interface BaleBridgeStatusLocalBus {
    leaderSocketPath?: string;
    leaderTransport?: "pipe" | "socket";
    followerSocketPath?: string;
    followerTransport?: "pipe" | "socket";
    followerRegistered?: boolean;
    followerTarget?: {
        chatId: number;
        threadId?: number;
    };
    followerSlot?: string;
    followerThreadName?: string;
    leaderProtocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
}
export interface BaleBridgeStatusTopicTarget {
    instanceId?: string;
    status?: string;
    target?: {
        chatId: number;
        threadId?: number;
    };
    slot?: string;
    threadName?: string;
    syncStatus?: string;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface BaleBridgeStatusThreadReservation {
    target?: {
        chatId: number;
        threadId?: number;
    };
    slot?: string;
    reason?: string;
    instanceId?: string;
    expiresAtMs?: number;
    lastReconcileAction?: string;
}
export interface BaleBridgeStatusSyncObservation {
    target?: {
        chatId: number;
        threadId?: number;
    };
    syncStatus: string;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface BaleBridgeStatusSyncSlice {
    status: string;
    updatedAtMs?: number;
    suspectAtMs?: number;
    reason?: string;
    lastReconcileAction?: string;
}
export interface BaleBridgeThreadReconciliationState {
    phase: string;
    event: string;
    atMs: number;
    leaderEpoch?: number | string;
    pendingProvisionCount: number;
    syncActionCount: number;
    cleanupActionCount: number;
}
export type BaleBridgeBusRole = "leader" | "follower";
export type BaleBridgeBusLifecyclePhase = "electing";
export interface BaleBridgePollingState {
    phase: string;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    startedAtMs?: number;
    stoppedAtMs?: number;
    lastSuccessfulResponseAtMs?: number;
    lastSuccessfulResponseUpdateCount?: number;
    stopReason?: string;
}
export interface BaleBridgeInboundWorkerState {
    phase: string;
    generation: number;
    phaseStartedAtMs?: number;
    currentUpdateId?: number;
    blockedReason?: string;
    blockedInputCustody?: {
        updateId: number;
        kind: string;
    };
    journalEntryCount: number;
    journalSerializedBytes: number;
    oldestAdmittedAtMs?: number;
    deferredClaimCount: number;
    queuedClaimCount: number;
    foreignQueuedCount: number;
    foreignQueuedOwnerLiveness?: "alive" | "dead" | "unverifiable";
    foreignQueuedOwner?: {
        instanceId: string;
        processId: number;
        processBirthId: string;
        sessionGeneration: number;
        acquisitionId: string;
        acquiredAtMs: number;
    };
    retryWaitCount: number;
    failedCount: number;
    nextRetryUpdateId?: number;
    nextRetryAtMs?: number;
    nextRetryAttemptCount?: number;
    nextRetryFailureClass?: string;
    failedUpdateId?: number;
    failedFailureId?: string;
    failedAttemptCount?: number;
    failedClass?: string;
    failedSummary?: string;
    terminalFailureAtMs?: number;
    unsettledExecutionCount: number;
    lastCompletedUpdateId?: number;
    lastCompletedAtMs?: number;
    lastFailureAtMs?: number;
    lastFailurePhase?: string;
}
export interface BaleBridgeStatusLineState {
    hasBotToken?: boolean;
    botUsername?: string;
    /** Redacted named-variable diagnostic when the stored token reference cannot resolve. */
    botTokenDiagnostic?: string;
    activeProfileName?: string;
    diagnosticPaths?: {
        state: string;
        logs: string;
    };
    allowedUserId?: number;
    botThreadMode?: "unknown" | "enabled" | "disabled";
    botThreadModeUpdatedAtMs?: number;
    botThreadModeAction?: string;
    busRole?: BaleBridgeBusRole;
    busProtocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    busLifecyclePhase?: BaleBridgeBusLifecyclePhase;
    instanceSlot?: string;
    instanceThreadName?: string;
    lockState?: string;
    pollingActive: boolean;
    polling?: BaleBridgePollingState;
    inboundWorker?: BaleBridgeInboundWorkerState;
    lastUpdateId?: number;
    activeSourceMessageIds?: number[];
    pendingDispatch: boolean;
    compactionInProgress: boolean;
    activeToolExecutions: number;
    pendingModelSwitch: boolean;
    queuedItems: Array<{
        queueLane: BaleStatusQueueLane;
    }>;
    busFollowers?: BaleBridgeStatusBusFollower[];
    localBus?: BaleBridgeStatusLocalBus;
    topicTargets?: BaleBridgeStatusTopicTarget[];
    threadReservations?: BaleBridgeStatusThreadReservation[];
    topicSyncObservations?: BaleBridgeStatusSyncObservation[];
    syncState?: Record<string, BaleBridgeStatusSyncSlice | undefined>;
    threadReconciliation?: BaleBridgeThreadReconciliationState;
    busNowMs?: number;
    recentRuntimeEvents: BaleRuntimeEvent[];
}
export interface BaleStatusBarTheme {
    fg: (token: "accent" | "dim" | "error" | "muted" | "warning" | "success", text: string) => string;
}
export interface BaleStatusBarState {
    hasBotToken: boolean;
    pollingActive: boolean;
    pollingStopReason?: string;
    paired: boolean;
    busRole?: BaleBridgeBusRole;
    followerRegistered?: boolean;
    busLifecyclePhase?: BaleBridgeBusLifecyclePhase;
    instanceSlot?: string;
    instanceThreadName?: string;
    compactionInProgress: boolean;
    processing: boolean;
    processingStatus?: string;
    queuedStatus: string;
    error?: string;
}
export interface BaleStatusRuntimeContext {
    ui: {
        theme: BaleStatusBarTheme;
        setStatus: (key: string, text: string) => void;
    };
}
export interface BaleStatusRuntimeDeps<TContext extends BaleStatusRuntimeContext> {
    statusKey?: string;
    getStatusBarState: (ctx: TContext, error?: string) => BaleStatusBarState;
    getBridgeStatusLineState: () => BaleBridgeStatusLineState;
}
export interface BaleBridgeStatusConfig {
    botToken?: string;
    /** Caller-resolved token availability; falls back to raw presence. */
    botHasToken?: boolean;
    /** Caller-supplied redacted diagnostic for an unresolved token reference. */
    botTokenDiagnostic?: string;
    botUsername?: string;
    allowedUserId?: number;
}
/** Narrow config-store view used to project resolved bot-token availability. */
export interface BaleBridgeStatusConfigSource {
    get: () => BaleBridgeStatusConfig;
    hasBotToken?: () => boolean;
    getBotTokenDiagnostic?: () => string | undefined;
}
/**
 * Project a config store into the status view without moving token-reference
 * resolution into this structural leaf domain.
 */
export declare function createBaleBridgeStatusConfigGetter(source: BaleBridgeStatusConfigSource): () => BaleBridgeStatusConfig;
export interface BaleBridgeStatusRuntimeDeps<TQueueItem extends {
    queueLane: BaleStatusQueueLane;
}> {
    statusKey?: string;
    getConfig: () => BaleBridgeStatusConfig;
    getActiveProfileName?: () => string | undefined;
    getDiagnosticPaths?: (profileName?: string) => {
        state: string;
        logs: string;
    };
    isPollingActive: () => boolean;
    getPollingState?: () => BaleBridgePollingState;
    getInboundWorkerState?: () => BaleBridgeInboundWorkerState | undefined;
    getAcceptedThroughUpdateId?: () => number | undefined;
    getActiveSourceMessageIds: () => number[] | undefined;
    hasActiveTurn: () => boolean;
    hasDispatchPending: () => boolean;
    isCompactionInProgress: () => boolean;
    getActiveToolExecutions: () => number;
    hasPendingModelSwitch: () => boolean;
    getQueuedItems: () => TQueueItem[];
    getQueuedItemCount?: (items: TQueueItem[]) => number;
    getRecentRuntimeEvents: () => BaleRuntimeEvent[];
    getRuntimeLockState?: () => string;
    getBusRole?: () => BaleBridgeBusRole | undefined;
    getBusProtocol?: () => {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    getBusLifecyclePhase?: () => BaleBridgeBusLifecyclePhase | undefined;
    getBotThreadMode?: () => {
        threadMode: "unknown" | "enabled" | "disabled";
        updatedAtMs?: number;
        lastReconcileAction?: string;
    } | undefined;
    getBusFollowers?: () => BaleBridgeStatusBusFollower[];
    getLocalBus?: () => BaleBridgeStatusLocalBus | undefined;
    getTopicTargets?: () => BaleBridgeStatusTopicTarget[];
    getThreadReservations?: () => BaleBridgeStatusThreadReservation[];
    getTopicSyncObservations?: () => BaleBridgeStatusSyncObservation[];
    getSyncState?: () => Record<string, BaleBridgeStatusSyncSlice | undefined>;
    getThreadReconciliationState?: () => BaleBridgeThreadReconciliationState | undefined;
    getInstanceSlot?: () => string | undefined;
    getInstanceThreadName?: () => string | undefined;
    getNowMs?: () => number;
}
export interface BaleBridgeStatusLineOptions {
    verbose?: boolean;
}
export interface BaleStatusRuntime<TContext extends BaleStatusRuntimeContext> {
    updateStatus: (ctx: TContext, error?: string) => void;
    getStatusLines: (options?: BaleBridgeStatusLineOptions) => string[];
    getStatusState: () => BaleBridgeStatusLineState;
}
export declare function recordStructuredBaleRuntimeEvent(events: BaleRuntimeEvent[], input: BaleRuntimeEventInput, options: {
    botToken?: string;
    maxEvents: number;
    now?: number;
}): void;
/**
 * Register a compact extension-provided line for the Bale status menu.
 *
 * Providers are synchronous and should return undefined when their line is not
 * relevant for the active model. Errors are isolated so optional extension
 * status cannot break the core Bale menu.
 */
export declare function registerBaleStatusLineProvider(provider: BaleStatusLineProvider, options: {
    id: string;
}): () => void;
export declare function clearBaleStatusLineProviders(): void;
export declare function createBaleRuntimeEventRecorder(options: BaleRuntimeEventRecorderOptions): BaleRuntimeEventRecorder;
export declare function buildBaleRuntimeEventLines(events: BaleRuntimeEvent[]): string[];
export declare function createBaleStatusHtmlBuilder<TContext>(deps: {
    getActiveModel: (ctx: TContext) => BaleStatusActiveModel | undefined;
    isCompactionInProgress?: () => boolean;
    getBridgeStatusLineState?: () => BaleBridgeStatusLineState;
}): (ctx: TContext & BaleStatusContext) => string;
export declare function createBaleStatusRuntime<TContext extends BaleStatusRuntimeContext>(deps: BaleStatusRuntimeDeps<TContext>): BaleStatusRuntime<TContext>;
export declare function createBaleBridgeStatusRuntime<TContext extends BaleStatusRuntimeContext, TQueueItem extends {
    queueLane: BaleStatusQueueLane;
}>(deps: BaleBridgeStatusRuntimeDeps<TQueueItem>): BaleStatusRuntime<TContext>;
export interface BaleRuntimeLogScope extends Record<string, unknown> {
    instanceId: string;
    role: string;
    slot?: string;
    threadName?: string;
    lockState?: string;
}
export declare function createBaleRuntimeLogScope(input: {
    state: BaleBridgeStatusLineState;
    instanceId: string;
}): BaleRuntimeLogScope;
export interface BaleStatusSnapshot {
    runtime: Record<string, unknown>;
    liveRoster: Record<string, unknown>;
    diagnostics: Record<string, unknown>;
}
export interface BaleStoredRuntimeProjection extends BaleStatusSnapshot {
    version: 1;
    source: "snapshot";
    writtenAtMs: number;
}
export declare function createBaleStatusSnapshot(state: BaleBridgeStatusLineState): BaleStatusSnapshot;
export interface BaleRuntimeProjectionScope {
    path: string;
    profile: string;
}
export interface BaleRuntimeProjectionStorage {
    read: (scope: BaleRuntimeProjectionScope) => unknown;
    /** The adapter must enforce exact owner plus the supplied physical/logical scope in one transaction. */
    publish: (scope: BaleRuntimeProjectionScope, mutate: (current: unknown) => {
        value: unknown;
        changed: boolean;
    }, isCurrent: () => boolean) => boolean;
}
export interface BaleRuntimeProjectionStoreOptions {
    getPath: () => string;
    getProfile: () => string | undefined;
    /** Capture exact owner/context/session authority at submission, never renew it after the queued await. */
    captureAuthority: () => (() => boolean) | undefined;
    storage: BaleRuntimeProjectionStorage;
    getNowMs?: () => number;
}
/** Observational runtime storage only; Workspace, admission, transport, logs and recovery remain with their owners. */
export declare function createBaleRuntimeProjectionStore(options: BaleRuntimeProjectionStoreOptions): {
    read: () => BaleStoredRuntimeProjection | undefined;
    persist: (snapshot: BaleStatusSnapshot) => Promise<boolean>;
};
export declare function createBaleRuntimeDiagnosticsSnapshotScheduler(deps: {
    persistSnapshot: (isCurrent: () => boolean) => Promise<void>;
    recordError: (error: unknown) => void;
    captureScope?: () => (() => boolean) | undefined;
    setTimer?: (callback: () => void, ms: number) => {
        unref?: () => void;
    } | number;
    clearTimer?: (timer: {
        unref?: () => void;
    } | number) => void;
}): (() => void) & {
    resume(): void;
    suspend(): Promise<void>;
};
export declare function getBaleStatusBarProcessingStatus(state: {
    hasActiveTurn: boolean;
    hasPendingDispatch: boolean;
    hasPendingModelSwitch: boolean;
    activeToolExecutions: number;
    queuedItems: number;
}): string | undefined;
export declare function buildBaleStatusBarText(theme: BaleStatusBarTheme, state: BaleStatusBarState): string;
export declare function buildBaleBridgeStatusLines(state: BaleBridgeStatusLineState, options?: BaleBridgeStatusLineOptions): string[];
export {};
