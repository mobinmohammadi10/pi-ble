/**
 * Bale bus follower runtime
 * Zones: multi-instance bus, follower lifecycle, manual registration
 * Owns this Pi instance's follower-side bus behavior: manual registration,
 * heartbeat, forwarded-update receiving, and follower-routed API calls.
 * It must not spawn Pi processes or create hidden Bale-originated instances.
 */
import type { BalePreparedHeldCommand } from "./commands.ts";
import type { BaleWorkspaceRestoreExecutor, BaleWorkspaceRestoreIntent } from "./threads.ts";
import type { BaleLiveSourceCompletionReadiness, BaleUpdateAdmissionLifecycleRuntime } from "./updates.ts";
import { BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY, BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY, BALE_BUS_CAPABILITY_WORKSPACE_RESTORE, type BaleBusAgentMessage, type BaleBusAgentTargetSelector, type BaleBusEnvelope, type BaleBusFollowerQueueHandoffOffer, type BaleBusForwardOwnership, type BaleBusLiveRebindApplyObservation, type BaleBusLiveRebindCommandObservation, type BaleBusLiveRebindSaveObservation, type BaleBusLiveRebindSettlementObservation, type BaleBusLiveRebindWorkObservation, type BaleBusLiveRebindWorkState, type BaleBusProtocolIdentity, type BaleBusSelectedMenuDeliveryObservation, type BaleBusSelectedMenuTextEffect, type BaleBusSocketPathSource, type BaleBusWorkspaceRestoreObservation } from "./bus.ts";
import type { BaleConfigStore, BaleThreadDisplayMode } from "./config.ts";
import { type BaleUpdateJournalStoreOptions } from "./journal.ts";
import { type BaleLockEntry, type BaleLockState } from "./locks.ts";
import * as Machine from "./machine.ts";
import type { BaleQueueHandoffStageResult } from "./queue.ts";
import { type BaleTarget } from "./target.ts";
import { type BaleApiCallOptions } from "./bale-api.ts";
import * as Threads from "./threads.ts";
import { type BaleWorkspaceAdmissionLedger } from "./workspace-admission.ts";
export declare const BALE_BUS_FOLLOWER_HEARTBEAT_TIMEOUT_MS = 8000;
export interface BaleFollowerSessionHandoff {
    pid: number;
    instanceId: string;
    createdAtMs: number;
    target: BaleTarget;
    slot?: string;
    threadName?: string;
}
export declare function getBaleFollowerSessionHandoff(): BaleFollowerSessionHandoff | undefined;
export declare function setBaleFollowerSessionHandoff(handoff: BaleFollowerSessionHandoff | undefined): void;
export interface BaleBusFollowerRegistrationRuntime<TContext> {
    registerWithLeader: (ctx: TContext, leader: {
        busSocketPath?: string;
        busSecret?: string;
    }, options?: {
        target?: BaleTarget;
        previousInstanceId?: string;
        restoreWorkspace?: boolean;
        recoverConnection?: boolean;
    }) => Promise<boolean>;
    setContext: (ctx: TContext) => void | Promise<void>;
    disconnectFromLeader?: () => Promise<boolean>;
    renameThread?: (target: BaleTarget & {
        threadId: number;
    }, threadName: string) => Promise<string>;
    resetThreadName?: (target: BaleTarget & {
        threadId: number;
    }) => Promise<string>;
    setThreadDisplayMode?: (mode: BaleThreadDisplayMode) => Promise<void>;
    /** Leader-mediated durable publication or successor claim; true only after exact commit. */
    requestSessionReplacement?: (operation: "publish" | "settle", intent: Threads.BaleSessionReplacementIntent) => Promise<boolean>;
    stop: () => void;
}
export interface BaleBusFollowerSessionReplacementSuspenderDeps {
    registrationState: Pick<BaleBusFollowerRegistrationState, "isRegistered" | "getTarget" | "getSlot" | "getThreadName">;
    instanceId: string;
    suspendPolling: () => Promise<void>;
    isLeader?: () => boolean;
    getLeaderBinding?: () => BaleBusFollowerPromotedBinding | undefined;
    getActiveContext?: () => {
        cwd?: string;
    } | undefined;
    getActiveProfileName?: () => string | undefined;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    getPid?: () => number;
}
export interface BaleBusFollowerSessionRefreshHookDeps<TContext> {
    registrationState: Pick<BaleBusFollowerRegistrationState, "isRegistered">;
    registrationRuntime: Pick<BaleBusFollowerRegistrationRuntime<TContext>, "registerWithLeader" | "setContext">;
    getLeaderState: () => BaleLockState;
    isSessionActive?: (ctx: TContext) => boolean;
    updateStatus: (ctx: TContext) => void;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export type BaleBusFollowerControlLifecyclePhase = "electing";
export interface BaleBusFollowerControlState {
    getActiveAuthSecret: () => string | undefined;
    setActiveAuthSecret: (secret: string | undefined) => void;
    getLifecyclePhase: () => BaleBusFollowerControlLifecyclePhase | undefined;
    setLifecyclePhase: (phase: BaleBusFollowerControlLifecyclePhase | undefined) => void;
}
export interface BaleBusFollowerRegistrationState {
    isRegistered: () => boolean;
    getTarget: () => BaleTarget | undefined;
    getSlot: () => string | undefined;
    getThreadName: () => string | undefined;
    getDisplayTitle: () => string | undefined;
    setDisplayTitle: (title: string, generation: string) => boolean;
    getGeneration: () => string | undefined;
    /** Return the acknowledged session only when it matches the caller's current context. */
    getSessionId: (currentSessionId: string | undefined) => string | undefined;
    beginRecovery: () => number;
    cancelRecovery: () => void;
    waitForGeneration: (timeoutMs?: number) => Promise<string | undefined>;
    getLeaderProtocol: () => BaleBusProtocolIdentity | undefined;
    getEligibleElectionSlots: () => readonly string[];
    setEligibleElectionSlots: (slots: readonly string[]) => void;
    setRegistered: (registered: boolean, target?: BaleTarget, metadata?: {
        slot?: string;
        threadName?: string;
        displayTitle?: string;
        generation?: string;
        sessionId?: string;
        leaderProtocol?: BaleBusProtocolIdentity;
    }) => void;
}
export interface BaleBusForwardedUpdateReceiverRuntime {
    start: () => Promise<void>;
    stop: () => Promise<void>;
}
export interface BaleBusFollowerDurableAdmissionResult {
    deliveryId: string;
    sourceUpdateId: number;
}
export interface BaleBusFollowerDurableAdmissionPort<TContext> {
    admit: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.forwardCallback" | "leader.forwardReaction" | "leader.forwardMessage" | "leader.forwardEditedMessage" | "leader.wakeInputCustody";
    }>, ctx: TContext) => Promise<BaleBusFollowerDurableAdmissionResult>;
}
export interface BaleBusFollowerClientRuntimeDeps<TMessage = unknown> {
    socketPath: BaleBusSocketPathSource;
    instanceId: string;
    getApiAuthSecret?: () => string | undefined;
    getForwardingAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    waitForRegistrationGeneration?: (timeoutMs?: number) => Promise<string | undefined>;
    getForwardCommentBatchPosition?: (message: TMessage) => "comment" | "forward" | undefined;
    validateForwardOwnership?: (ownership: BaleBusForwardOwnership) => boolean;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    timeoutMs?: number;
}
/** Structural port for run-collapsing diagnostics, implemented by the logging domain. */
export interface BaleFailureRunLogPort {
    record: (error: unknown, details?: Record<string, unknown>) => boolean;
    settled: () => BaleFailureRunSummaryPort | undefined;
    reset: () => void;
}
export interface BaleFailureRunSummaryPort {
    signature: string;
    failedAttempts: number;
    suppressedFailures: number;
    failedForMs: number;
}
export interface BaleBusFollowerApiCallerDeps {
    socketPath: BaleBusSocketPathSource;
    instanceId: string;
    createRequestId: () => string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    waitForRegistrationGeneration?: (timeoutMs?: number) => Promise<string | undefined>;
    getNowMs?: () => number;
    timeoutMs?: number;
    /** Receives one diagnostic per call slower than `slowCallMs`; observation only. */
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    slowCallMs?: number;
}
export interface BaleBusFollowerRegistrationRuntimeDeps<TContext extends {
    cwd?: string;
}> {
    /**
     * Collapses one sustained heartbeat failure run. Optional at this unit boundary, where an absent port records
     * every failure; the runtime assembly requires it so production always supplies the logging domain's owner.
     */
    failureLog?: BaleFailureRunLogPort;
    instanceId: string;
    createRequestId: () => string;
    protocolIdentity: BaleBusProtocolIdentity;
    getLeaderAuthSecret?: (leader: {
        busSecret?: string;
    }) => string | undefined;
    setActiveAuthSecret?: (secret: string | undefined) => void;
    followerBusSocketPath?: string;
    getFollowerBusSocketPath?: () => string;
    getLeaderSocketPath?: () => string;
    startReceiving?: () => Promise<void>;
    stopReceiving?: () => Promise<void> | void;
    registrationState?: BaleBusFollowerRegistrationState;
    isContextActive?: (ctx: TContext) => boolean;
    getProfileKey?: (ctx: TContext) => string | undefined;
    getThreadName?: (ctx: TContext) => string | undefined;
    getNowMs?: () => number;
    getPid?: () => number;
    getProcessBirthId?: () => string;
    getSessionId?: (ctx: TContext) => string | undefined;
    getSessionGeneration?: () => number;
    timeoutMs?: number;
    registrationTimeoutMs?: number;
    registrationRetryAttempts?: number;
    registrationRetryDelayMs?: number;
    heartbeatMs?: number;
    heartbeatTimeoutMs?: number;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    onHeartbeatFailure?: (error: unknown, ctx: TContext) => Promise<void> | void;
    onRegistered?: (ctx: TContext) => Promise<void> | void;
    onDisplayTitleChanged?: (ctx: TContext) => void;
}
export declare function createBaleManualFollowerProfileKeyResolver(input: {
    getActiveProfileName: () => string | undefined;
    manualFollowerOwnerId: string;
}): () => string;
export interface BaleBusFollowerElection {
    expectedOwner?: BaleLockEntry;
    /** The expected owner is bus-proven unresponsive; the lock CAS still requires it to be the current owner. */
    unresponsive?: boolean;
}
export type BaleBusFollowerPromotionHandler<TContext> = (ctx: TContext, binding: BaleBusFollowerPromotedBinding, election: BaleBusFollowerElection) => Promise<boolean>;
type BaleBusFollowerWorkspaceAdmissionDeps = {
    getWorkspaceAdmission?: () => Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
};
export declare function createBaleBusFollowerPromotionHandler<TContext extends {
    cwd: string;
}>(input: {
    topicTargetStore: Threads.BaleTopicTargetStore;
    instanceId: string;
    getActiveProfileName: () => string | undefined;
    getSessionId?: (ctx: TContext) => string | undefined;
    startLeader: (ctx: TContext, election: BaleBusFollowerElection, onAcquired: () => Promise<void>) => Promise<boolean>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    getNowMs?: () => number;
    getPid?: () => number;
    getWorkspaceAdmission?: BaleBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"];
}): BaleBusFollowerPromotionHandler<TContext>;
export type BaleBusFollowerLeaderState = {
    kind: "inactive";
} | {
    kind: "active-here";
    lock: BaleBusFollowerLeaderLock;
} | {
    kind: "active-elsewhere";
    lock: BaleBusFollowerLeaderLock;
} | {
    kind: "stale";
    lock: BaleBusFollowerLeaderLock;
};
export type BaleBusFollowerLeaderLock = BaleLockEntry;
export interface BaleBusFollowerPromotedBinding {
    target?: BaleTarget;
    slot?: string;
    threadName?: string;
}
export interface BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext> {
    registrationState: Pick<BaleBusFollowerRegistrationState, "getTarget" | "getSlot" | "getThreadName" | "getEligibleElectionSlots" | "beginRecovery" | "setRegistered">;
    getRegistrationRuntime: () => BaleBusFollowerRegistrationRuntime<TContext>;
    getLeaderState: () => BaleBusFollowerLeaderState;
    setLifecyclePhase: (phase: "electing" | undefined) => void;
    updateStatus: (ctx: TContext) => void;
    promoteToLeader: (ctx: TContext, binding: BaleBusFollowerPromotedBinding, election: BaleBusFollowerElection) => Promise<boolean>;
    sleep?: (ms: number) => Promise<void>;
    scheduleRetry?: (retry: () => void, delayMs: number) => void;
    getActiveContext?: () => TContext | undefined;
    promotionGraceMs?: number;
    /** Bus liveness proof for a live-PID leader that no longer answers; replaces the retired file heartbeat. */
    proveLeaderUnresponsive?: (owner: BaleLockEntry) => Promise<boolean>;
    /** Shared bot state says Threaded Mode is off: followers cannot exist, so recovery goes offline instead. */
    isThreadModeDisabled?: () => boolean | Promise<boolean>;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleBusForwardedUpdateReceiverRuntimeDeps<TContext> {
    socketPath: BaleBusSocketPathSource;
    instanceId: string;
    getAuthSecret?: () => string | undefined;
    getRegistrationGeneration: () => string | undefined;
    getRecipientBindingKey: () => string | undefined;
    /** Live preparation names the current journal, not the stable forwarding/profile identity. */
    getLiveRebindJournalBindingKey?: () => string | undefined;
    durableAdmission: BaleBusFollowerDurableAdmissionPort<TContext>;
    sourceReferenceAdmission?: BaleBusFollowerDurableAdmissionPort<TContext>;
    isSourceReferenceAdmissionEnabled?: () => boolean;
    hasAuthenticatedSourceReferenceTransport?: () => boolean;
    getContext: () => TContext | undefined;
    handleInputCustodyHandoff?: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>, ctx: TContext) => Promise<unknown> | unknown;
    handleQueueHandoff?: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.offerQueueHandoff";
    }>, ctx: TContext) => Promise<BaleQueueHandoffStageResult> | BaleQueueHandoffStageResult;
    getSessionId?: () => string | undefined;
    getLeaderProtocol?: () => BaleBusProtocolIdentity | undefined;
    getLocalProtocol?: () => BaleBusProtocolIdentity | undefined;
    isLiveRebindSaveEnabled?: () => boolean;
    isLiveRebindApplyEnabled?: () => boolean;
    isLiveRebindSettleEnabled?: () => boolean;
    handleLiveRebindSettle?: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.settleLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => Promise<BaleBusLiveRebindSettlementObservation | BaleBusLiveRebindWorkObservation | BaleBusLiveRebindCommandObservation>;
    handleLiveRebindApply?: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.applyLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => Promise<BaleBusLiveRebindApplyObservation>;
    /** Availability only; never future recipient activation or a command execution grant. */
    isLiveRebindCommandSetEnabled?: () => boolean;
    handleLiveRebindSave?: (envelope: Extract<BaleBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean) => BaleBusLiveRebindSaveObservation | Promise<BaleBusLiveRebindSaveObservation>;
    isWorkspaceRestoreEnabled?: () => boolean;
    handleWorkspaceRestore?: (input: {
        operationId: string;
        registrationGeneration: string;
        mode: "apply" | "inspect";
    }, ctx: TContext) => Promise<BaleBusWorkspaceRestoreObservation>;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface BaleBusFollowerRuntimeAssembly<TContext> {
    receiver: BaleBusForwardedUpdateReceiverRuntime;
    registration: BaleBusFollowerRegistrationRuntime<TContext>;
    getReadySessionId: () => string | undefined;
}
export interface BaleBusFollowerRuntimeAssemblyPorts<TContext extends {
    cwd?: string;
}> {
    instanceId: string;
    /** Collapses one sustained heartbeat failure run; the composition root supplies the logging domain's owner. */
    failureLog: BaleFailureRunLogPort;
    registrationState: BaleBusFollowerRegistrationState;
    recordRuntimeEvent: (category: string, error: unknown, details?: Record<string, unknown>) => void;
    receiver: Omit<BaleBusForwardedUpdateReceiverRuntimeDeps<TContext>, "instanceId" | "recordRuntimeEvent" | "getRegistrationGeneration">;
    recovery: Omit<BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext>, "getRegistrationRuntime" | "registrationState" | "recordRuntimeEvent">;
    registration: Omit<BaleBusFollowerRegistrationRuntimeDeps<TContext>, "startReceiving" | "stopReceiving" | "onHeartbeatFailure" | "instanceId" | "registrationState" | "recordRuntimeEvent" | "protocolIdentity"> & {
        protocolIdentity: BaleBusProtocolIdentity;
    };
}
export declare function createBaleBusFollowerRuntimeAssembly<TContext extends {
    cwd?: string;
}>(ports: BaleBusFollowerRuntimeAssemblyPorts<TContext>): BaleBusFollowerRuntimeAssembly<TContext>;
export interface BaleBusFollowerRestoreContext {
    executor: BaleWorkspaceRestoreExecutor;
    profileBindingKey: string;
    operatorUserId: number;
    cwd: string;
    sessionId: string;
    generation: string | number;
    leaderProtocol?: BaleBusProtocolIdentity;
}
/** Binds Restore to real Pi lifetime and the current authenticated transport owner, not request fields. */
export declare function createBaleBusFollowerRestoreContextGetter<TContext>(deps: {
    isContextCurrent: (ctx: TContext) => boolean;
    getSessionId: (ctx: TContext) => string | undefined;
    getCwd: (ctx: TContext) => string | undefined;
    getGeneration: () => number;
    getProfileBindingKey: () => string | undefined;
    getOperatorUserId: () => number | undefined;
    getLeaderState: () => BaleLockState;
    getAuthenticatedSecret: () => string | undefined;
    getLeaderProtocol: () => BaleBusProtocolIdentity | undefined;
    capability?: typeof BALE_BUS_CAPABILITY_WORKSPACE_RESTORE | typeof BALE_BUS_CAPABILITY_LIVE_REBIND_APPLY | typeof BALE_BUS_CAPABILITY_SELECTED_MENU_DELIVERY;
}): (ctx: TContext) => BaleBusFollowerRestoreContext | undefined;
/** Shared canonical/local target owner and scoped live-carrier hooks; caller authenticates transport, no canonical writes or cleanup. */
export declare function createBaleBusFollowerWorkspaceRestoreHandler<TContext>(deps: {
    instanceId: string;
    /** Captures actual Pi lifetime and authenticated leader/profile authority, never request-derived values. */
    getContextAuthority: (ctx: TContext) => BaleBusFollowerRestoreContext | undefined;
    readRestoreIntent: (operationId: string, profileBindingKey: string) => BaleWorkspaceRestoreIntent | undefined;
    readLiveRebindIntent?: (operationId: string, profileBindingKey: string) => Threads.BaleWorkspaceLiveRebindIntent | undefined;
    topicTargetStore: Pick<Threads.BaleTopicTargetStore, "load" | "withWorkspaceRestoreSnapshot"> & Partial<Pick<Threads.BaleTopicTargetStore, "withWorkspaceLiveRebindSnapshot">>;
    registrationState: Pick<BaleBusFollowerRegistrationState, "getTarget" | "getSlot" | "getGeneration" | "setRegistered" | "getLeaderProtocol">;
    getWorkspaceAdmission: NonNullable<BaleBusFollowerWorkspaceAdmissionDeps["getWorkspaceAdmission"]>;
    recordRuntimeEvent?: BaleBusFollowerWorkspaceAdmissionDeps["recordRuntimeEvent"];
}): ((input: {
    operationId: string;
    registrationGeneration: string;
    mode: "apply" | "inspect";
    liveRebind?: {
        sourceUpdateIds: readonly number[];
        isCurrent(): boolean;
        /** Captured prepared-branch target; equality must precede local apply or release grants. */
        expectedTarget?: BaleTarget & {
            threadId: number;
        };
        release?: (canRelease: () => boolean, target: BaleTarget & {
            threadId: number;
        }) => void;
        observeWork?: (oldTarget: BaleTarget & {
            threadId: number;
        }) => void;
    };
}, ctx: TContext) => Promise<BaleBusWorkspaceRestoreObservation>) & {
    /** Capture availability only; asserting current recipient requires canonical released/local-applied ownership. */
    prepareLiveCommandRecipient(input: {
        operationId: string;
        registrationGeneration: string;
        sessionId: string;
        sourceUpdateIds: readonly number[];
        target: BaleTarget & {
            threadId: number;
        };
    }, ctx: TContext): Pick<BaleBusFollowerCommandOwner<TContext>, "isCurrent" | "assertRecipientCurrent"> | undefined;
};
export declare function createBaleBusFollowerClientRuntime<TContext, TReactionUpdate, TCallbackQuery, TMessage = unknown>(deps: BaleBusFollowerClientRuntimeDeps<TMessage>): {
    createRequestId: () => string;
    callApi: (method: string, args: unknown[], localOptions?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown>;
    agentMessages: {
        resolveTarget: (selector: BaleBusAgentTargetSelector) => Promise<BaleTarget & {
            threadId: number;
        }>;
        routeMessage: (message: BaleBusAgentMessage) => Promise<void>;
    };
    foreignOwnedUpdateForwarder: {
        forwardCallback: (input: {
            query: TCallbackQuery;
            ownership: BaleBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").BaleBusForeignUpdateSettlement>;
        forwardReaction: (input: {
            reactionUpdate: TReactionUpdate;
            ownership: BaleBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").BaleBusForeignUpdateSettlement>;
        forwardMessage: (input: {
            message: TMessage;
            ownership: BaleBusForwardOwnership;
            ctx: TContext;
            assertAuthority?: () => void;
        }) => Promise<import("./bus.ts").BaleBusForeignUpdateSettlement>;
        forwardEditedMessage: (input: {
            message: TMessage;
            ownership: BaleBusForwardOwnership;
            ctx: TContext;
        }) => Promise<import("./bus.ts").BaleBusForeignUpdateSettlement>;
    };
    queueHandoff: (input: BaleBusFollowerQueueHandoffOffer) => Promise<BaleQueueHandoffStageResult>;
};
export declare function createBaleBusFollowerQueueHandoffClient(deps: BaleBusFollowerApiCallerDeps): (input: BaleBusFollowerQueueHandoffOffer) => Promise<BaleQueueHandoffStageResult>;
/** Private selected text-effect caller; not a guarded ordinary API adapter or follower command admission grant. */
export declare function createBaleBusFollowerSelectedMenuCaller<TContext>(deps: {
    client: BaleBusFollowerApiCallerDeps;
    protocolIdentity: BaleBusProtocolIdentity;
    recipient: {
        getContextAuthority(ctx: TContext): BaleBusFollowerRestoreContext | undefined;
        getJournalBindingKey(ctx: TContext): string | undefined;
        getProcessIdentity(): {
            processId: number;
            processBirthId: string;
        };
        registrationState: Pick<BaleBusFollowerRegistrationState, "getTarget" | "getSlot" | "getGeneration" | "getLeaderProtocol">;
    };
}): (input: {
    ctx: TContext;
    operationId: string;
    registrationGeneration: string;
    effect: BaleBusSelectedMenuTextEffect;
    assertAuthority: () => void;
}) => Promise<BaleBusSelectedMenuDeliveryObservation>;
export declare function createBaleBusFollowerApiCaller(deps: BaleBusFollowerApiCallerDeps): (method: string, args: unknown[], localOptions?: Pick<BaleApiCallOptions, "assertAuthority">) => Promise<unknown>;
export declare function createBaleBusFollowerSessionReplacementSuspender(deps: BaleBusFollowerSessionReplacementSuspenderDeps): (preserveTarget?: boolean) => Promise<void>;
export declare function createBaleBusFollowerSessionRefreshHook<TContext>(deps: BaleBusFollowerSessionRefreshHookDeps<TContext>): (_event: unknown, ctx: TContext) => Promise<void>;
export declare function createBaleBusFollowerControlState(): BaleBusFollowerControlState;
export declare function createBaleBusFollowerRegistrationState(options?: {
    onAvailabilityChanged?: () => void;
}): BaleBusFollowerRegistrationState;
/** Heartbeat-failure recovery that a deliberate local stop halts until the next deliberate registration. */
export type BaleBusFollowerHeartbeatRecoveryHandler<TContext> = ((error: unknown, ctx: TContext) => Promise<void>) & {
    halt: () => void;
    resume: () => void;
};
/** The whole recovery lifecycle state; only `transitionBaleBusFollowerRecovery` produces a new one. */
export interface BaleBusFollowerRecoveryState {
    /** Bumped by halt and resume, so a recovery or retry from before an operator stop or connect is inert. */
    readonly epoch: number;
    readonly halted: boolean;
    /** One recovery runs at a time; it belongs to the epoch it started in. */
    readonly recovering: boolean;
    readonly retryId: number | null;
    readonly nextRetryId: number;
}
export type BaleBusFollowerRecoveryEvent = {
    type: "recoverRequested";
} | {
    type: "recoverySettled";
    epoch: number;
} | {
    type: "retryRequested";
    epoch: number;
} | {
    type: "retryFired";
    retryId: number;
} | {
    type: "halted";
} | {
    type: "resumed";
};
export type BaleBusFollowerRecoveryEffect = {
    type: "runRecovery";
    epoch: number;
} | {
    type: "armRetry";
    retryId: number;
} | {
    type: "cancelRetry";
    retryId: number;
};
export declare function createBaleBusFollowerRecoveryState(): BaleBusFollowerRecoveryState;
/**
 * Pure follower-recovery lifecycle. An operator stop halts it and a connect resumes it, each in a new epoch: work
 * from the old epoch, a recovery still awaiting or a retry still armed, can no longer register or promote.
 */
export declare function transitionBaleBusFollowerRecovery(state: BaleBusFollowerRecoveryState, event: BaleBusFollowerRecoveryEvent): Machine.BaleMachineStep<BaleBusFollowerRecoveryState, BaleBusFollowerRecoveryEffect>;
export declare function createBaleBusFollowerHeartbeatRecoveryHandler<TContext>(deps: BaleBusFollowerHeartbeatRecoveryHandlerDeps<TContext>): BaleBusFollowerHeartbeatRecoveryHandler<TContext>;
export declare function createBaleBusFollowerRegistrationRuntime<TContext extends {
    cwd?: string;
}>(deps: BaleBusFollowerRegistrationRuntimeDeps<TContext>): BaleBusFollowerRegistrationRuntime<TContext>;
/** Bind source-owned sender checks to the journal's already-admitted synchronous v1 hook. */
export declare function createBaleBusFollowerPairedAdmission(deps: {
    profileName: string;
    tokenSha256: string;
    configStore: Pick<BaleConfigStore, "withPairedUserAdmission">;
    assertExecutionCurrent: () => void;
}): NonNullable<BaleUpdateJournalStoreOptions["withPairedAdmission"]>;
export declare function prepareBaleBusFollowerJournaledUpdateForExecution<TUpdate extends {
    message?: unknown;
} & Record<string, unknown>>(update: TUpdate, prepareForwardedMessage: (message: NonNullable<TUpdate["message"]>, position: "comment" | "forward") => void): TUpdate;
/** Existing Commands/menu assembly preflights the copied input and captures independent recipient/transport owners. */
export interface BaleBusFollowerCommandOwner<TContext> {
    isCurrent(): boolean;
    assertRecipientCurrent(): void;
    prepare(readiness: BaleLiveSourceCompletionReadiness, ctx: TContext, input: {
        target: BaleTarget & {
            threadId: number;
        };
        assertSourceCurrent(): void;
        assertRecipientCurrent(): void;
    }): BalePreparedHeldCommand | undefined;
}
/** One current warm preparation, not a prompt queue or restart recovery record. */
export declare function createBaleBusFollowerLiveRebindRuntime<TContext>(deps: {
    getAdmission(ctx: TContext): Pick<BaleUpdateAdmissionLifecycleRuntime<TContext>, "prepareLiveInput" | "appendBatch" | "getJournalBindingKey"> | undefined;
    applyTarget?: (...args: Parameters<ReturnType<typeof createBaleBusFollowerWorkspaceRestoreHandler<TContext>>>) => ReturnType<ReturnType<typeof createBaleBusFollowerWorkspaceRestoreHandler<TContext>>>;
    observeWork?: (oldTarget: BaleTarget & {
        threadId: number;
    }, ctx: TContext) => BaleBusLiveRebindWorkState;
    /** Pure preflight: undefined refuses before hold/append; this port never activates future recipient authority. */
    getCommandOwner?: (input: Readonly<Omit<Extract<BaleBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, "kind" | "auth" | "requestId" | "sentAtMs">>, ctx: TContext) => BaleBusFollowerCommandOwner<TContext> | undefined;
}): {
    save(envelope: Extract<BaleBusEnvelope, {
        kind: "leader.prepareLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): BaleBusLiveRebindSaveObservation;
    apply(envelope: Extract<BaleBusEnvelope, {
        kind: "leader.applyLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): Promise<BaleBusLiveRebindApplyObservation>;
    settle(envelope: Extract<BaleBusEnvelope, {
        kind: "leader.settleLiveRebind";
    }>, ctx: TContext, isCurrent: () => boolean): Promise<BaleBusLiveRebindSettlementObservation | BaleBusLiveRebindWorkObservation | BaleBusLiveRebindCommandObservation>;
};
export declare function createBaleBusFollowerDurableAdmissionRuntime<TContext>(deps: {
    journal: {
        appendBatch(updates: readonly ({
            update_id: number;
        } & Record<string, unknown>)[]): unknown;
    };
    signalWorker: (ctx: TContext) => void;
    getNowMs?: () => number;
    /** Bounded process-local replay window; omit for the production 24 h / 4,096-delivery defaults. */
    recentDeliveryLimit?: {
        maxAgeMs: number;
        maxEntries: number;
    };
}): BaleBusFollowerDurableAdmissionPort<TContext>;
export interface BaleBusFollowerInputCustodyBundle<TContext> {
    acceptHandoff(input: {
        sourceRecoveryKey: string;
        recipientBindingKey: string;
        source: {
            journalBindingKey: string;
            tokenSha256: string;
            updateId: number;
        };
        handoffId: string;
    }, ctx: TContext): unknown;
    wakeSource(input: BaleBusFollowerDurableAdmissionResult & {
        recipientBindingKey: string;
        sourceRecoveryKey: string;
        sourceClaim: {
            acquisitionId: string;
            handoffId: string;
        };
    }, ctx: TContext): void;
    resolveForwardReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
}
export declare function createBaleBusFollowerInputCustodyPorts<TContext>(deps: {
    getInputCustodyBus(): BaleBusFollowerInputCustodyBundle<TContext> | undefined;
}): {
    isSourceReferenceAdmissionEnabled: () => boolean;
    handleInputCustodyHandoff(envelope: Extract<BaleBusEnvelope, {
        kind: "leader.offerInputCustodyHandoff";
    }>, ctx: TContext): unknown;
    sourceReferenceAdmission: BaleBusFollowerDurableAdmissionPort<TContext>;
    resolveInputCustodyReference(input: {
        sourceUpdateId: number;
        recipientBindingKey: string;
    }): {
        sourceRecoveryKey: string;
        source: {
            updateId: number;
            owner: {
                acquisitionId: string;
                handoffId: string;
            };
        };
    } | undefined;
};
export declare function createBaleBusFollowerSourceReferenceAdmissionRuntime<TContext>(deps: {
    wakeSource: (input: BaleBusFollowerDurableAdmissionResult & {
        recipientBindingKey: string;
        sourceRecoveryKey: string;
        sourceClaim: {
            acquisitionId: string;
            handoffId: string;
        };
    }, ctx: TContext) => Promise<void> | void;
}): BaleBusFollowerDurableAdmissionPort<TContext>;
export declare function createBaleBusForwardedUpdateReceiverRuntime<TContext>(deps: BaleBusForwardedUpdateReceiverRuntimeDeps<TContext>): BaleBusForwardedUpdateReceiverRuntime;
export {};
