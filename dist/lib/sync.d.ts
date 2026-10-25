/**
 * Bale synchronization helpers
 * Zones: Bale bot reality mirror, demand-driven reconciliation, status diagnostics
 * Owns pure contracts for deciding when local Bale mirror state should be refreshed without querying Bale on every action
 */
import { type BaleTarget } from "./target.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type BaleOwnTopicProvisionResult, type BaleTopicTargetStore, type BaleWorkspaceDisplayBinding, type BaleWorkspaceThreadBinding } from "./threads.ts";
import { type BaleWorkspaceAdmissionLedger } from "./workspace-admission.ts";
export interface BaleTopicLifecycleSyncUpdate<TMessage = unknown> {
    kind: "created" | "closed" | "reopened";
    target: BaleTarget & {
        threadId: number;
    };
    message: TMessage;
}
export type BaleSyncWorkspaceOperationRunner = <T>(input: {
    operationId: string;
    operationKind: string;
    scopes: readonly [{
        kind: "profile";
    }];
}, operation: () => Promise<T>) => Promise<T>;
export interface BaleLeaderThreadSyncDeps {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    cwd?: string;
    sessionId?: string;
    baleProfile?: string;
    forceFreshUnnamed?: boolean;
    requestedThreadName?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: BaleWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    topicTargetStore: BaleTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    probeWorkspaceBinding?: (binding: BaleWorkspaceThreadBinding) => Promise<void>;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleTopicLifecycleSyncDeps {
    topicTargetStore: Pick<BaleTopicTargetStore, "load" | "list" | "listReservations" | "listPendingProvisions" | "markStaleByTarget" | "markActiveByTarget" | "removePendingProvision" | "persist">;
    isBusEnabled: () => boolean;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    isTopicProvisioningActive?: () => boolean;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    assertExecutionCurrent?: (message: unknown) => void;
    recordEvent?: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export type BaleTopicLifecycleSyncHandler<TMessage = unknown> = (lifecycle: BaleTopicLifecycleSyncUpdate<TMessage>) => Promise<void>;
export interface BaleObservedTopicLifecycleSyncDeps<TSyncState> extends BaleTopicLifecycleSyncDeps {
    runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    getNowMs?: () => number;
}
export interface BaleLeaderHealthRuntimeDeps<TSyncState> {
    getNowMs?: () => number;
    intervalMs?: number;
    callGetMe: () => Promise<unknown>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleLeaderHealthRuntime {
    start: () => void;
    stop: () => void;
}
export interface BaleManualThreadDisconnectDeps<TSyncState> {
    instanceId: string;
    getCurrentThreadRecord: () => {
        target: BaleTarget;
        instanceId?: string;
        profileKey?: string;
        owner?: {
            kind?: string;
        };
    } | undefined;
    topicTargetStore: Pick<BaleTopicTargetStore, "list" | "markStaleByTarget" | "persist" | "upsertPendingCleanup" | "removePendingCleanup">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getLeaderTarget: () => BaleTarget | undefined;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    clearLeaderTarget: () => void;
    disconnectFollowerThread?: () => Promise<boolean>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    stopPolling: () => Promise<string>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
    workspaceOperationKind?: string;
    isDisconnectCurrent?: () => boolean;
    getNowMs?: () => number;
}
export declare function createBalePreservedLeaderQuitHandler(deps: {
    instanceId: string;
    topicTargetStore: Pick<BaleTopicTargetStore, "load" | "list" | "listPendingCleanups" | "detachTargetOwner">;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getProfileName: () => string | undefined;
    isPollingSuspended: () => boolean;
    resolveAutomaticThreadCleanupEnabled: () => boolean | Promise<boolean>;
    runWorkspaceOperation: BaleSyncWorkspaceOperationRunner;
}): (isSessionCurrent: () => boolean) => (() => Promise<void>) | undefined;
export interface BaleSessionRestartThreadCleanupDeps<TSyncState extends BaleSyncState> extends Omit<BaleManualThreadDisconnectDeps<TSyncState>, "stopPolling"> {
    suspendPolling: () => Promise<void>;
}
export interface BaleThreadDisconnectAssembly {
    disconnect: () => Promise<string>;
    cleanupForSessionRestart: () => Promise<string>;
}
export declare function createBaleThreadDisconnectAssembly<TSyncState extends BaleSyncState>(deps: Omit<BaleManualThreadDisconnectDeps<TSyncState>, "stopPolling"> & {
    stopPolling: () => Promise<string>;
    captureStopPolling?: () => {
        isCurrent: () => boolean;
        stop: () => Promise<string>;
    };
    suspendPolling: () => Promise<void>;
}): BaleThreadDisconnectAssembly;
export declare function createBaleManualThreadDisconnectHandler<TSyncState extends BaleSyncState>(deps: BaleManualThreadDisconnectDeps<TSyncState>): () => Promise<string>;
export declare function createBaleLeaderHealthRuntime<TSyncState extends BaleSyncState>(deps: BaleLeaderHealthRuntimeDeps<TSyncState>): BaleLeaderHealthRuntime;
export interface BaleStaleTopicApiErrorRecoveryDeps<TSyncState> {
    topicTargetStore: Pick<BaleTopicTargetStore, "load" | "markStaleByTarget" | "persist"> & Partial<Pick<BaleTopicTargetStore, "invalidateTarget">>;
    getSyncState: () => TSyncState;
    setSyncState: (state: TSyncState) => void;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    isCurrent?: () => boolean;
    isAuthorityCurrent?: () => boolean;
    getWorkspaceAdmission?: () => Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
}
export declare function captureBaleStaleTargetRequestRecovery<TSyncState extends BaleSyncState>(body: Record<string, unknown>, deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState> & {
    topicTargetStore: Pick<BaleTopicTargetStore, "load" | "list" | "markStaleByTarget" | "persist" | "invalidateTarget">;
    getCurrentLeaderEpoch: () => number | string | undefined;
    getSessionGeneration: () => number;
    getProfileName: () => string | undefined;
    onRecovered: () => void;
}): ((error: unknown) => Promise<void>) | undefined;
export declare function createBaleStaleTopicApiErrorRecoveryRuntime<TSyncState extends BaleSyncState>(deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>): (apiBody: unknown, error: unknown) => Promise<boolean>;
export declare function settleStaleBaleTopicExecutionFailure<TSyncState extends BaleSyncState>(error: unknown, deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>): Promise<boolean>;
export declare function recoverStaleBaleTopicApiError<TSyncState extends BaleSyncState>(apiBody: unknown, error: unknown, deps: BaleStaleTopicApiErrorRecoveryDeps<TSyncState>): Promise<boolean>;
export declare function ensureBaleLeaderThreadBinding(deps: BaleLeaderThreadSyncDeps): Promise<BaleOwnTopicProvisionResult | undefined>;
export declare const BALE_SYNC_SLICES: readonly ["bot-identity", "bot-capabilities", "pairing", "allowed-user", "topic-capability", "topic-state", "target-bindings", "reservations", "transport-health"];
export type BaleSyncSlice = (typeof BALE_SYNC_SLICES)[number];
export interface BaleSyncSliceState {
    status: "fresh" | "suspect" | "unknown";
    updatedAtMs?: number;
    suspectAtMs?: number;
    reason?: string;
    lastReconcileAction?: string;
}
export type BaleSyncState = Partial<Record<BaleSyncSlice, BaleSyncSliceState>>;
export declare function createUnknownBaleSyncState(): BaleSyncState;
export interface BaleSyncStateRuntime {
    getState(): BaleSyncState;
    setState(state: BaleSyncState): void;
    markConfigChange(action: string): void;
    markSliceFresh(slice: BaleSyncSlice, options: {
        nowMs: number;
        action: string;
    }): void;
}
export declare function createBaleConfigSyncPersister<TConfig>(deps: {
    persist: (config?: TConfig) => Promise<void>;
    markConfigChange: (action: string) => void;
}): (config?: TConfig) => Promise<void>;
export declare function createBaleSyncStateRuntime(initialState?: Partial<Record<"reservations" | "bot-identity" | "bot-capabilities" | "pairing" | "allowed-user" | "topic-capability" | "topic-state" | "target-bindings" | "transport-health", BaleSyncSliceState>>): BaleSyncStateRuntime;
export interface BaleProvisioningActivityRuntime {
    isActive(): boolean;
    start(): void;
    end(): void;
}
export declare function createBaleProvisioningActivityRuntime(): BaleProvisioningActivityRuntime;
export declare function markBaleSyncSliceSuspect(state: BaleSyncState, slice: BaleSyncSlice, input: {
    reason: string;
    nowMs: number;
    action?: string;
}): BaleSyncState;
export declare function markBaleSyncSliceFresh(state: BaleSyncState, slice: BaleSyncSlice, input: {
    nowMs: number;
    action: string;
}): BaleSyncState;
export declare function createBaleObservedTopicLifecycleSyncHandler<TMessage = unknown, TSyncState extends BaleSyncState = BaleSyncState>(deps: BaleObservedTopicLifecycleSyncDeps<TSyncState>): BaleTopicLifecycleSyncHandler<TMessage>;
export declare function createBaleTopicLifecycleSyncHandler<TMessage = unknown>(deps: BaleTopicLifecycleSyncDeps): BaleTopicLifecycleSyncHandler<TMessage>;
