/**
 * Bale bus leader orchestration
 * Zones: multi-instance bus, leader polling/server lifecycle, follower routing
 * Owns leader-only runtime orchestration: follower registration envelopes, follower API proxying,
 * leader activation hot-switching, local bus server startup, and stale follower pruning.
 */
import { type BaleBusEnvelope, type BaleBusLeaderQueueHandoffOffer, type BaleBusFollowerRegistry, type BaleBusFollowerView, type BaleBusInstanceRegistration, type BaleBusProtocolIdentity, type BaleBusSelectedMenuDelivery, type BaleBusSocketPathSource } from "./bus.ts";
import type { BaleThreadDisplayMode } from "./config.ts";
import type { BaleAttachmentSource } from "./media.ts";
import * as Sync from "./sync.ts";
import { type BaleTarget } from "./target.ts";
import { type BaleApiCallOptions, type BaleBridgeApiRuntime } from "./bale-api.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import * as Threads from "./threads.ts";
import { type BaleWorkspaceAdmissionLedger } from "./workspace-admission.ts";
import { type BaleWorkspaceCapacityRunner, type BaleWorkspaceOperationRunner, type BaleWorkspaceSlotRotationPorts } from "./workspace-retirement.ts";
export declare const BALE_BUS_FOLLOWER_STALE_AFTER_MS = 15000;
export type BaleBusWorkspaceAdmissionRunner = BaleWorkspaceOperationRunner;
export interface BaleBusLeaderRuntime<TContext> {
    runWorkspaceOperation?: BaleBusWorkspaceAdmissionRunner;
    captureWorkspaceExternalProtection?: (binding: Threads.BaleWorkspaceThreadBinding) => Threads.BaleWorkspaceExternalProtectionEvidence;
    reconcileThreadDisplay?: () => Promise<{
        changed: number;
    }>;
    setThreadDisplayMode?: (mode: BaleThreadDisplayMode) => Promise<void>;
    renameLeaderThread?: (threadName: string) => Promise<Threads.BaleTopicTargetRecord>;
    startPolling: (ctx: TContext) => Promise<void>;
    stopPolling: () => Promise<void>;
    routeQueueHandoff: (input: BaleBusLeaderQueueHandoffOffer) => Promise<BaleBusEnvelope>;
}
export interface BaleBusFollowerLifecycleAnnouncement {
    target: BaleTarget & {
        threadId: number;
    };
    text: string;
    parseMode: "HTML";
}
export interface BaleBusLeaderTargetProvisionerDeps<TContext> {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    getCwd?: (ctx: TContext) => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    getBaleProfile?: () => string | undefined;
    shouldForceFreshUnnamed?: () => boolean;
    getRequestedThreadName?: () => string | undefined;
    resolveInitialWorkspaceDisplayTitle?: (binding: Threads.BaleWorkspaceDisplayBinding) => string | undefined;
    topicTargetStore: Threads.BaleTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    getSyncState: () => Sync.BaleSyncState;
    setSyncState: (state: Sync.BaleSyncState) => void;
    setLeaderTarget: (input: {
        target: BaleTarget;
        slot?: string;
        threadName?: string;
    }) => void;
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
}
export interface BaleBusFollowerTargetProvisionerDeps {
    getAllowedUserId: () => number | undefined;
    getLiveFollowers?: () => readonly BaleBusFollowerView[];
    isFollowerProcessAlive?: (pid: number) => boolean;
    topicTargetStore: Threads.BaleTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getSyncState: () => Sync.BaleSyncState;
    setSyncState: (state: Sync.BaleSyncState) => void;
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    resolveInitialWorkspaceDisplayTitle?: (binding: Threads.BaleWorkspaceDisplayBinding) => string | undefined;
    runWorkspaceOperation?: BaleBusWorkspaceAdmissionRunner;
    getNowMs?: () => number;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleBusFollowerDisconnectHandlerDeps {
    topicTargetStore: Pick<Threads.BaleTopicTargetStore, "list" | "markStaleByTarget" | "persist" | "upsertPendingCleanup" | "removePendingCleanup">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getSyncState: () => Sync.BaleSyncState;
    setSyncState: (state: Sync.BaleSyncState) => void;
    getNowMs?: () => number;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleBusLeaderApiProxyDeps {
    call: (method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<unknown>;
    callMultipart: (method: string, fields: Record<string, string>, fieldName: string, filePath: string, fileName: string, options?: BaleApiCallOptions) => Promise<unknown>;
    downloadFile: (fileId: string, suggestedName: string, source?: BaleAttachmentSource) => Promise<unknown>;
    recoverStaleTargetError?: (apiBody: unknown, error: unknown) => Promise<unknown> | unknown;
}
export interface BaleBusLeaderRuntimeAssemblyDeps<TContext> {
    getThreadDisplayMode?: () => BaleThreadDisplayMode;
    persistThreadDisplayMode?: (mode: BaleThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    onThreadDisplayChanged?: () => void;
    runtime: Omit<BaleBusLeaderRuntimeDeps<TContext>, "callApi" | "onFollowerDisconnected" | "onFollowerConfirmedDead" | "onFollowerConfirmedDeadPreserved" | "getBaleProfile" | "getAllowedUserId" | "provisionFollowerTarget" | "commitFollowerRegistration" | "provisionLeaderTarget" | "recordRuntimeEvent">;
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    getCwd?: (ctx: TContext) => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    getBaleProfile?: () => string | undefined;
    shouldForceFreshUnnamed?: () => boolean;
    getRequestedThreadName?: () => string | undefined;
    topicTargetStore: Threads.BaleTopicTargetStore;
    callApi: BaleBusLeaderTargetProvisionerDeps<TContext>["callApi"];
    callMultipart: BaleBusLeaderApiProxyDeps["callMultipart"];
    downloadFile: BaleBusLeaderApiProxyDeps["downloadFile"];
    recoverStaleTargetError?: BaleBusLeaderApiProxyDeps["recoverStaleTargetError"];
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: BaleBusLeaderTargetProvisionerDeps<TContext>["getThreadReconciliationMachineState"];
    recordThreadReconciliationPlan?: BaleBusLeaderTargetProvisionerDeps<TContext>["recordThreadReconciliationPlan"];
    getSyncState: () => Sync.BaleSyncState;
    setSyncState: (state: Sync.BaleSyncState) => void;
    setLeaderTarget: BaleBusLeaderTargetProvisionerDeps<TContext>["setLeaderTarget"];
    onProvisioningStart?: () => void;
    onProvisioningEnd?: () => void;
    recordRuntimeEvent: NonNullable<BaleBusLeaderRuntimeDeps<TContext>["recordRuntimeEvent"]>;
    captureWorkspaceExternalProtection?: (binding: Threads.BaleWorkspaceThreadBinding) => Threads.BaleWorkspaceExternalProtectionEvidence;
    getWorkspaceAdmission?: () => Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    runWorkspaceOperation?: BaleBusWorkspaceAdmissionRunner;
    workspaceRotation?: BaleWorkspaceSlotRotationPorts;
}
export type BaleBusFollowerSessionReplacementOperation = (follower: BaleBusFollowerView, intent: Threads.BaleSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
/**
 * Leader-owned durable session-replacement authority for registered followers.
 * Followers cannot persist `state.json`; the leader validates the request
 * against its live registry entry and authoritative Workspace binding before
 * one CAS publication or claim. Follower memory is never accepted as binding
 * evidence.
 */
export declare function createBaleBusFollowerSessionReplacementAuthority(deps: {
    store: Pick<Threads.BaleTopicTargetStore, "load" | "getWorkspaceBindingByTarget" | "getSessionReplacementIntent" | "commitSessionReplacementIntent" | "removeSessionReplacementIntent">;
    getBaleProfile?: () => string | undefined;
    getNowMs?: () => number;
    ttlMs?: number;
}): {
    publish: BaleBusFollowerSessionReplacementOperation;
    settle: BaleBusFollowerSessionReplacementOperation;
};
export declare function createBaleBusLeaderRuntimeAssembly<TContext>(deps: BaleBusLeaderRuntimeAssemblyDeps<TContext>): BaleBusLeaderRuntime<TContext> & {
    renameLeaderThreadAdmitted: (threadName: string, expectedTarget?: Threads.BaleTopicTargetRecord["target"], assertRecipientAuthority?: () => void) => Promise<Threads.BaleTopicTargetRecord>;
    resetLeaderThreadName: (expectedTarget: Threads.BaleTopicTargetRecord["target"], assertRecipientAuthority?: () => void) => Promise<{
        threadName: string;
    }>;
    resetThreadNameAdmitted: (target: Threads.BaleTopicTargetRecord["target"]) => Promise<{
        threadName: string;
    }>;
};
export interface BaleBusFollowerMessageOwnershipRecord {
    follower: BaleBusFollowerView;
    chatId: number;
    messageId: number;
    target?: BaleTarget;
}
export type BaleBusFollowerMessageOwnershipRecorder = (record: BaleBusFollowerMessageOwnershipRecord) => void;
export type BaleBusFollowerRegistrationCommitter = (input: {
    registration: BaleBusInstanceRegistration;
    target?: BaleTarget;
    slot?: string;
}, publish: () => void) => Promise<void> | void;
export interface BaleBusLeaderRuntimeDeps<TContext> extends Omit<BaleBusLeaderEnvelopeHandlerDeps, "runFollowerMutation" | "getWorkspaceRestoreObservationGeneration"> {
    socketPath: BaleBusSocketPathSource;
    commitEndpointPublication?: (commit: () => void) => boolean;
    startPolling: (ctx: TContext) => void | Promise<void>;
    stopPolling: () => void | Promise<void>;
    provisionLeaderTarget?: (ctx: TContext) => Promise<void> | void;
    followerPruneIntervalMs?: number;
    /** Leader housekeeping after each current prune pass; throttling is the callee's concern. */
    afterFollowerPrune?: () => void;
    followerStaleAfterMs?: number;
    isFollowerProcessAlive?: (pid: number) => boolean;
    shouldCleanupConfirmedDeadFollower?: () => Promise<boolean> | boolean;
    onFollowerConfirmedDead?: (follower: BaleBusFollowerView) => Promise<void> | void;
    /** True settles this observation; false needs fresh proof before another attempt. */
    onFollowerConfirmedDeadPreserved?: (follower: BaleBusFollowerView, isDetached: () => boolean, operationId: string) => Promise<boolean> | boolean;
}
export declare function createBaleBusInstanceLifecycleAnnouncement(input: {
    target: BaleTarget & {
        threadId: number;
    };
    threadName?: string;
    slot?: string;
    state: "connected";
}): BaleBusFollowerLifecycleAnnouncement;
export declare function createBaleBusFollowerTargetProvisioner(deps: BaleBusFollowerTargetProvisionerDeps): (registration: BaleBusInstanceRegistration, options?: {
    existingWorkspaceBindingOnly?: boolean;
    recoverConnection?: boolean;
}) => Promise<(BaleTarget & {
    slot?: string;
    threadName?: string;
}) | undefined>;
export declare function createBaleBusFollowerDisconnectHandler(deps: BaleBusFollowerDisconnectHandlerDeps): (follower: BaleBusFollowerView) => Promise<void>;
export declare function createBaleBusFollowerConfirmedDeadHandler(deps: BaleBusFollowerDisconnectHandlerDeps): (follower: BaleBusFollowerView) => Promise<void>;
export declare function createBaleBusLeaderTargetProvisioner<TContext>(deps: BaleBusLeaderTargetProvisionerDeps<TContext>): (ctx: TContext) => Promise<void>;
export declare function createBaleBusLeaderApiProxy(deps: BaleBusLeaderApiProxyDeps): (method: string, args: unknown[]) => Promise<unknown>;
type BaleBusFollowerMutationRunner = <T>(follower: {
    instanceId: string;
    profileKey?: string;
}, operation: () => Promise<T>) => Promise<T>;
/** One delegated text effect through existing Workspace/API owners; no closure transport, ordinary proxy or replay loop. */
export declare function createBaleBusSelectedMenuDeliveryHandler(deps: {
    followerRegistry: BaleBusFollowerRegistry;
    protocolIdentity: BaleBusProtocolIdentity;
    workspace: {
        /** Exact active bot/profile namespace, independently captured by the leader; never follower-supplied. */
        getScopeKey(): string | undefined;
        captureAuthority(): Threads.BaleWorkspaceRestoreAuthority | undefined;
        getStore(): Threads.BaleWorkspaceRestore | undefined;
        threadStore: Pick<Threads.BaleTopicTargetStore, "withWorkspaceLiveRebindSnapshot">;
        getJournalBindingKey(follower: BaleBusFollowerView): string | undefined;
        run: BaleBusWorkspaceAdmissionRunner;
    };
    api: {
        runtime: Pick<BaleBridgeApiRuntime, "call">;
        authorize(input: {
            follower: BaleBusFollowerView;
            method: string;
            args: unknown[];
        }): boolean;
        /** Synchronous publication acceptance through the existing ownership owner, never delivery/cleanup permission. */
        record(record: BaleBusFollowerMessageOwnershipRecord, assertCurrent: () => void): boolean;
    };
}): (input: BaleBusSelectedMenuDelivery, isCallerCurrent: () => boolean) => Promise<BaleBusEnvelope>;
export interface BaleBusLeaderEnvelopeHandlerDeps {
    followerRegistry: BaleBusFollowerRegistry;
    authSecret?: string;
    protocolIdentity: BaleBusProtocolIdentity;
    getNowMs?: () => number;
    timeoutMs?: number;
    selectedMenuDelivery?: ReturnType<typeof createBaleBusSelectedMenuDeliveryHandler>;
    callApi?: (method: string, args: unknown[]) => Promise<unknown> | unknown;
    authorizeFollowerApiCall?: (input: {
        follower: BaleBusFollowerView;
        method: string;
        args: unknown[];
    }) => boolean;
    recordFollowerMessageOwnership?: BaleBusFollowerMessageOwnershipRecorder;
    resolveAgentTarget?: (follower: BaleBusFollowerView, selector: Extract<BaleBusEnvelope, {
        kind: "follower.resolveAgentTarget";
    }>["selector"]) => Promise<BaleTarget | undefined> | BaleTarget | undefined;
    routeAgentMessage?: (follower: BaleBusFollowerView, message: Extract<BaleBusEnvelope, {
        kind: "follower.routeAgentMessage";
    }>["message"]) => Promise<void> | void;
    routeQueueHandoff?: (follower: BaleBusFollowerView, envelope: Extract<BaleBusEnvelope, {
        kind: "follower.offerQueueHandoff";
    }>) => Promise<unknown> | unknown;
    provisionFollowerTarget?: (registration: BaleBusInstanceRegistration, options?: {
        existingWorkspaceBindingOnly?: boolean;
        recoverConnection?: boolean;
    }) => Promise<(BaleTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined> | (BaleTarget & {
        slot?: string;
        threadName?: string;
    }) | undefined;
    commitFollowerRegistration?: BaleBusFollowerRegistrationCommitter;
    onFollowerDisconnected?: (follower: BaleBusFollowerView) => Promise<void> | void;
    renameFollowerThread?: (follower: BaleBusFollowerView, threadName: string) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    resetFollowerThreadName?: (follower: BaleBusFollowerView) => Promise<{
        threadName: string;
    }> | {
        threadName: string;
    };
    publishFollowerSessionReplacement?: BaleBusFollowerSessionReplacementOperation;
    settleFollowerSessionReplacement?: BaleBusFollowerSessionReplacementOperation;
    getFollowerDisplayTitle?: (follower: BaleBusFollowerView) => string | undefined;
    onFollowerRegistered?: () => void;
    /** Observation only: reacquire admission and inspect work, never infer completion.
     * Listener settlement ends its currentness fence; return asynchronous work to retain that fence. */
    onWorkspaceRestoreRecipientObserved?: (follower: BaleBusFollowerView, isCurrent: () => boolean) => Promise<void> | void;
    getWorkspaceRestoreObservationGeneration?: () => number | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    applyThreadDisplayMode?: (mode: BaleThreadDisplayMode, isCurrent: () => boolean) => Promise<void>;
    getThreadDisplayMode?: () => BaleThreadDisplayMode;
    requiresPreDispatchRebindReader?: () => boolean;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getBaleProfile?: () => string | undefined;
    getAllowedUserId?: () => number | undefined;
    runFollowerMutation?: BaleBusFollowerMutationRunner;
    runWorkspaceAdmission?: BaleBusWorkspaceAdmissionRunner;
    runWithWorkspaceCapacity?: BaleWorkspaceCapacityRunner;
}
export declare function createBaleBusLeaderEnvelopeHandler(deps: BaleBusLeaderEnvelopeHandlerDeps): (envelope: BaleBusEnvelope) => Promise<BaleBusEnvelope> | BaleBusEnvelope;
export declare function createBaleBusLeaderRuntime<TContext>(deps: BaleBusLeaderRuntimeDeps<TContext>): BaleBusLeaderRuntime<TContext>;
export {};
