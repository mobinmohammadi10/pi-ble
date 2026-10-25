/**
 * Bale thread binding helpers
 * Zones: multi-instance bus, Bale UI threads, durable Workspace state
 * Owns live mappings, Workspace bindings and guarded Restore transitions; routing and transport effects stay outside.
 */
import { type BaleTarget } from "./target.ts";
import { type BaleApiCallOptions } from "./bale-api.ts";
import { type BaleLockContext, type BaleLockRuntime, type BaleOwnedStatePublicationOptions, type BaleOwnedStatePublicationResult, type BaleRuntimeStateMutation } from "./locks.ts";
import * as ThreadReconciler from "./thread-reconciler.ts";
import { type BaleWorkspaceBindingIdentity } from "./workspace-identity.ts";
import { type BaleWorkspaceSlotOccupancy } from "./workspace-slots.ts";
export { createBaleWorkspaceBindingIdentity, createBaleWorkspaceDirectoryKey, normalizeBaleSessionId, normalizeBaleWorkspacePath, type BaleWorkspaceBindingIdentity, } from "./workspace-identity.ts";
export type BaleTopicTargetStatus = "active" | "offline" | "stale" | "pending" | "starting" | "probe-required" | "failed";
export type BaleTopicSyncStatus = "open" | "closed" | "deleted" | "unknown";
export type BaleThreadOwner = {
    kind: "leader";
    cwd?: string;
    instanceId?: string;
    baleProfile?: string;
} | {
    kind: "manual-follower";
    instanceId: string;
    baleProfile?: string;
} | {
    kind: "pending-topic";
    chatId: number;
    threadId: number;
} | {
    kind: "legacy";
    key: string;
};
export interface BaleThreadReservation {
    target: BaleTarget & {
        threadId: number;
    };
    slot: string;
    reason: string;
    createdAtMs: number;
    updatedAtMs: number;
    expiresAtMs?: number;
    instanceId?: string;
    lastReconcileAction?: string;
}
export interface BaleThreadPendingProvision {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    profileKey?: string;
    workspaceBindingKey?: string;
    status?: "in-flight" | "ambiguous";
    threadName?: string;
    displayTitle?: string;
    slot?: string;
    target?: BaleTarget & {
        threadId: number;
    };
    startedAtMs: number;
    expiresAtMs?: number;
    leaderEpoch?: number | string;
}
export type BaleThreadCleanupIntent = ThreadReconciler.BaleThreadCleanupIntent;
export type BaleProvisionRecoveryFile = Record<string, {
    instanceId: string;
    profileKey?: string;
    leaderEpoch?: number | string;
    target: BaleTarget & {
        threadId: number;
    };
}>;
export interface BaleTopicSyncObservation {
    target: BaleTarget & {
        threadId: number;
    };
    syncStatus: BaleTopicSyncStatus;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}
export interface BaleTopicTargetRecord {
    /** Legacy string key derived from `owner`; always present in memory, never persisted. */
    profileKey: string;
    owner?: BaleThreadOwner;
    target: BaleTarget & {
        threadId: number;
    };
    status: BaleTopicTargetStatus;
    createdAtMs: number;
    updatedAtMs: number;
    threadName?: string;
    /** Explicit per-Workspace display override set by the operator. */
    manualThreadName?: string;
    instanceId?: string;
    slot?: string;
    lastError?: string;
    syncStatus?: BaleTopicSyncStatus;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
    rerouteConfirmedAtMs?: number;
}
export interface BaleThreadIdentityRecord {
    profileKey: string;
    threadName?: string;
    slot?: string;
    updatedAtMs: number;
}
export interface BaleWorkspaceJournalSource {
    sessionId: string;
    recipientBindingKey: string;
}
export interface BaleWorkspaceThreadBinding {
    cwd: string;
    workspaceKey: string;
    /** Exact durable Pi session identity; absent only on legacy cwd-only bindings. */
    sessionId?: string;
    /** Full SHA-256 index component for session-qualified bindings. */
    sessionKey?: string;
    instanceSlot: string;
    bindingKey: string;
    target: BaleTarget & {
        threadId: number;
    };
    /** Stable generated identity retained for compatibility and recovery. */
    threadName?: string;
    /** Explicit display override; absence selects the profile's automatic mode. */
    manualThreadName?: string;
    slot?: string;
    /** Last title acknowledged by Bale; never replaces the stable name. */
    displayTitle?: string;
    /** Historical follower-journal routing keys that may retain accepted work. */
    journalBindingKeys?: string[];
    /** Exact session-qualified journal addresses; retained across session re-key. */
    journalSources?: BaleWorkspaceJournalSource[];
    /** True only when the historical journal-key set is proven complete. */
    journalBindingsComplete?: true;
    /** Sticky once this directory has multiple retained bindings. */
    showSlotSuffix?: boolean;
    /** First continuously proven no-owner transition; absent means active or unproven. */
    inactiveSinceMs?: number;
    updatedAtMs: number;
}
export type BaleWorkspaceDisplayBinding = Pick<BaleWorkspaceThreadBinding, "bindingKey" | "cwd" | "slot" | "threadName" | "manualThreadName" | "showSlotSuffix">;
export interface BaleWorkspaceRetirementIntent {
    id: string;
    reason: "pressure";
    profileKey: string;
    binding: BaleWorkspaceThreadBinding;
    leaderEpoch: number | string;
    requestedAtMs: number;
}
export type BaleWorkspaceProtectionState = "clear" | "protected" | "unknown";
export interface BaleWorkspaceExternalProtectionEvidence {
    liveOwner: BaleWorkspaceProtectionState;
    acceptedWork: BaleWorkspaceProtectionState;
    deliveryAuthority: BaleWorkspaceProtectionState;
}
/** Per-binding probe; `withSnapshot` lets one occupancy capture share binding-independent evidence reads. */
export type BaleWorkspaceExternalProtectionCapture = ((binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence) & {
    withSnapshot?: <T>(capture: () => T) => T;
};
export interface BaleWorkspaceSlotOccupancySnapshot {
    bindings: BaleWorkspaceSlotOccupancy[];
    reservedSlots: string[];
}
export type BaleBotThreadMode = "unknown" | "enabled" | "disabled";
export interface BaleBotStateSnapshot {
    threadMode: BaleBotThreadMode;
    updatedAtMs?: number;
    lastSlot?: string;
    lastReconcileAction?: string;
}
export interface BaleWorkspaceRelocationRequest {
    operationId: string;
    binding: BaleWorkspaceThreadBinding;
    owner: BaleTopicTargetRecord;
    target: BaleTarget & {
        threadId: number;
    };
}
export interface BaleWorkspaceRestoreRequest extends BaleWorkspaceRelocationRequest {
    source: {
        journalBindingKey: string;
        updateIds: number[];
    };
}
export interface BaleWorkspaceRestoreExecutor {
    instanceId: string;
    leaderEpoch: string;
}
export interface BaleWorkspaceRestoreAuthority {
    executor: BaleWorkspaceRestoreExecutor;
    operatorUserId: number;
    /** Exact profile, transport, session, source and Workspace-admission authority. */
    isCurrent: () => boolean;
}
export type BaleWorkspaceRestoreRecipient = {
    kind: "leader" | "follower";
    instanceId: string;
    sessionId: string;
    generation: string;
};
/** Retained queue admission is nonterminal; queue-completed requires positive journal-owner disposition. */
export type BaleWorkspaceRestoreSourceSettlement = {
    journalBindingKey: string;
    updateIds: number[];
} & ({
    kind: "completed";
} | {
    kind: "queued" | "queue-completed";
    receiptId: string;
    queueKind: "prompt" | "control";
});
/** Positive execution/recipient acceptance, retained before source disposition; never a source-removal ACK. */
export type BaleWorkspaceRestoreSourceAcceptance = {
    journalBindingKey: string;
    updateId: number;
    /** SHA-256 of the exact journal entry captured by its worker owner, not a routed message projection. */
    sourceSha256: string;
    recipient: BaleWorkspaceRestoreRecipient;
} & ({
    kind: "completed";
} | {
    kind: "forwarded";
    deliveryId: string;
    recipientBindingKey: string;
} | {
    kind: "queued";
    receiptId: string;
    queueKind: "prompt" | "control";
    queueOwnerSha256: string;
});
export interface BaleWorkspaceRestoreIntent {
    request: BaleWorkspaceRestoreRequest;
    operatorUserId: number;
    executor: BaleWorkspaceRestoreExecutor;
    revision: number;
    createdAtMs: number;
    updatedAtMs: number;
    phase: "relocated" | "recipient-issued" | "ready";
    committedAtMs: number;
    recipient?: BaleWorkspaceRestoreRecipient;
    readyRecipient?: BaleWorkspaceRestoreRecipient;
    routing?: {
        acceptances?: BaleWorkspaceRestoreSourceAcceptance[];
        settlements: BaleWorkspaceRestoreSourceSettlement[];
        cleanup?: "issued" | "completed" | "not-issued";
    };
}
/** Live same-session metadata, never a legacy scoped ACK or permission to dispatch/delete. */
export type BaleWorkspaceLiveRebindIntent = Pick<BaleWorkspaceRestoreIntent, "request" | "operatorUserId" | "executor" | "revision" | "createdAtMs" | "updatedAtMs"> & {
    kind: "live-rebind";
    /** Versioned native input gate: terminal cleanup does not itself authorize or settle input. */
    inputRelease?: "held" | "issued" | "accepted";
    /** A session-replacing producer must not drop earlier old-target protection or carry its delete grant forward. */
    oldTargetProtected?: true;
    recipient: BaleWorkspaceRestoreRecipient;
} & ({
    phase: "rebound";
    cleanup?: never;
} | {
    phase: "released";
    cleanup?: "issued";
} | {
    phase: "finished";
    cleanup: "confirmed" | "failed" | "unknown" | "not-issued";
});
/** Immutable source membership, not readiness, cancellation, or proof of complete Thread coverage. */
export interface BaleTemporaryThreadInput {
    journalBindingKey: string;
    updateIds: number[];
}
/** Journal-owned donor discard evidence: retained manual cancellation or body-free chooser expiry, never recipient cancellation. */
export interface BaleTemporaryThreadCancellationEvidence {
    journalBindingKey: string;
    updateId: number;
    operatorAuthorityId: string;
}
/** A bot-created routing tab with an exact creation source; it owns no Pi binding or slot. */
export interface BaleTemporaryThreadEntry {
    source: {
        journalBindingKey: string;
        updateId: number;
    };
    /** Append-only known source groups. Missing legacy metadata never proves that the creation source was alone. */
    inputs?: BaleTemporaryThreadInput[];
    /** Whole known groups with positively observed donor cancellation or expiry; never recipient cancellation or deletion authority. */
    cancelledInputs?: BaleTemporaryThreadInput[];
    /** Whole known groups whose Forward was positively completed by the journal owner; never deletion authority alone. */
    completedInputs?: BaleTemporaryThreadInput[];
    /** Whole known groups whose Forward was durably issued before local handling/queueing or follower RPC; never delivery proof or a retry grant. */
    forwardedInputs?: BaleTemporaryThreadInput[];
    /** Published at creation only: every subsequent Forward path must record issuance; missing legacy coverage stays unknown. */
    forwardProtocol?: "one-shot-v1";
    /** Published before the sole cleanup attempt; uncertainty survives executor adoption and restart. */
    cleanupIssued?: true;
    operatorUserId: number;
    executor: BaleWorkspaceRestoreExecutor;
    /** Unique title token; the only identity an unacknowledged creation may later be matched by. */
    token: string;
    /** `creating` is published before the one creation request, so after a crash its outcome is unknown. */
    phase: "creating" | "created";
    target?: BaleTarget & {
        threadId: number;
    };
    revision: number;
    createdAtMs: number;
    updatedAtMs: number;
}
/** Canonical target classification only; a bound target still needs live same-session readiness proof. */
export type BaleTemporaryThreadTargetObservation = {
    kind: "bound";
    binding: BaleWorkspaceThreadBinding;
} | {
    kind: "temporary";
} | {
    kind: "unknown";
};
interface BaleWorkspaceRestoreSnapshot {
    version: 1;
    profileName: string;
    tokenSha256: string;
    revision: number;
    operations: BaleWorkspaceRestoreIntent[];
    liveRebindings?: BaleWorkspaceLiveRebindIntent[];
    temporaryThreads?: BaleTemporaryThreadEntry[];
}
/** Scope-bound Workspace operations; raw snapshot mutation is private to the store. */
export interface BaleWorkspaceRestore {
    list(): BaleWorkspaceRestoreIntent[];
    listLiveRebindings(): BaleWorkspaceLiveRebindIntent[];
    /** Caller has saved and held the selected input; this publishes the binding, not dispatch readiness. */
    commitLiveRebind(request: BaleWorkspaceRestoreRequest, recipient: BaleWorkspaceRestoreRecipient, authority: BaleWorkspaceRestoreAuthority, options?: {
        holdInput: true;
    }): Promise<BaleWorkspaceLiveRebindIntent | undefined>;
    /** Caller proves local apply for release or current live clearance for cleanup; unknown issuance never repeats. */
    advanceLiveRebind(expected: BaleWorkspaceLiveRebindIntent, step: "release" | "issue-cleanup" | "issue-input" | "accept-input" | "protect-old-target" | Extract<BaleWorkspaceLiveRebindIntent, {
        phase: "finished";
    }>["cleanup"], authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceLiveRebindIntent | undefined;
    commit(request: BaleWorkspaceRestoreRequest, authority: BaleWorkspaceRestoreAuthority): Promise<BaleWorkspaceRestoreIntent | undefined>;
    adopt(expected: BaleWorkspaceRestoreIntent, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    issueRecipient(expected: BaleWorkspaceRestoreIntent, recipient: BaleWorkspaceRestoreRecipient, authority: BaleWorkspaceRestoreAuthority): {
        issued: true;
        intent: BaleWorkspaceRestoreIntent;
    } | undefined;
    confirmReady(expected: BaleWorkspaceRestoreIntent, acknowledged: BaleWorkspaceRestoreRecipient, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    confirmInspectedReady(expected: BaleWorkspaceRestoreIntent, observed: BaleWorkspaceRestoreRecipient, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    issueRouting(expected: BaleWorkspaceRestoreIntent, authority: BaleWorkspaceRestoreAuthority): {
        issued: true;
        intent: BaleWorkspaceRestoreIntent;
    } | undefined;
    recordSourceAcceptance(expected: BaleWorkspaceRestoreIntent, evidence: BaleWorkspaceRestoreSourceAcceptance, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    recordSourceSettlement(expected: BaleWorkspaceRestoreIntent, evidence: BaleWorkspaceRestoreSourceSettlement, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    issueCleanup(expected: BaleWorkspaceRestoreIntent, authority: BaleWorkspaceRestoreAuthority): {
        issued: true;
        intent: BaleWorkspaceRestoreIntent;
    } | undefined;
    recordCleanup(expected: BaleWorkspaceRestoreIntent, result: {
        target: BaleWorkspaceRestoreRequest["target"];
        kind: "completed" | "not-issued";
    }, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    retire(expected: BaleWorkspaceRestoreIntent, authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    /** Caller proves exact operator abandonment of every original; no dispatch grant may exist. */
    retireAbandoned(expected: BaleWorkspaceRestoreIntent, abandonedUpdateIds: readonly number[], authority: BaleWorkspaceRestoreAuthority): BaleWorkspaceRestoreIntent | undefined;
    listTemporaryThreads(): BaleTemporaryThreadEntry[];
    /** Caller holds admission for effectful use. Fresh exact read grants no adoption, routing, disposition or deletion. */
    inspectTemporaryThreadTarget(expected: BaleTemporaryThreadEntry, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadTargetObservation | undefined;
    /** Read-only veto for an already-granted in-flight attempt; never another grant, disposable classification or deletion ACK. */
    isTemporaryThreadCleanupCurrent(expected: BaleTemporaryThreadEntry, authority: BaleWorkspaceRestoreAuthority): boolean;
    /**
     * Publishes `creating` before the caller's single creation request; an existing source entry is returned, never
     * recreated. `group` records an album as the tab's one creating input; it must start at the source update.
     */
    reserveTemporaryThread(source: BaleTemporaryThreadEntry["source"], token: string, authority: BaleWorkspaceRestoreAuthority, group?: BaleTemporaryThreadInput): {
        reserved: boolean;
        entry: BaleTemporaryThreadEntry;
    } | undefined;
    /** Caller proves a fresh owner-authenticated implicit Bale creation and exact live source under profile admission.
     * Registers that observed unbound target without issuing or fabricating a Bot API creation. */
    registerImplicitTemporaryThread(input: BaleTemporaryThreadInput, target: BaleTarget & {
        threadId: number;
    }, token: string, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    /** Records the exact acknowledged creation target; it never reopens a created entry. */
    acknowledgeTemporaryThread(expected: BaleTemporaryThreadEntry, target: BaleTarget & {
        threadId: number;
    }, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    adoptTemporaryThread(expected: BaleTemporaryThreadEntry, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    /** Caller supplies exact live source/group authority; duplicate membership is read-only, never a new dispatch grant. */
    recordTemporaryThreadInput(expected: BaleTemporaryThreadEntry, input: BaleTemporaryThreadInput, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    /** Records a positively completed Forward group; the caller proves every source of the group completed. */
    /** Publishes the one-time Forward issuance fact before any RPC; a duplicate, cancelled, completed or Restore-owned group is refused. */
    recordTemporaryThreadForwardIssued(expected: BaleTemporaryThreadEntry, input: BaleTemporaryThreadInput, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    recordTemporaryThreadInputCompletion(expected: BaleTemporaryThreadEntry, input: BaleTemporaryThreadInput, authority: BaleWorkspaceRestoreAuthority): BaleTemporaryThreadEntry | undefined;
    recordTemporaryThreadInputCancellation(expected: BaleTemporaryThreadEntry, input: BaleTemporaryThreadInput, authority: BaleWorkspaceRestoreAuthority, inspect: (updateId: number) => BaleTemporaryThreadCancellationEvidence | undefined): BaleTemporaryThreadEntry | undefined;
    /** Body-free chooser expiry may terminate an uncertain donor Forward/Restore, never accepted recipient work or a bound target. */
    recordTemporaryThreadInputExpiry(expected: BaleTemporaryThreadEntry, input: BaleTemporaryThreadInput, authority: BaleWorkspaceRestoreAuthority, inspect: (updateId: number) => BaleTemporaryThreadCancellationEvidence | undefined): BaleTemporaryThreadEntry | undefined;
    /** Caller holds profile admission and proves fresh source/protection clearance; publication grants one attempt, never retry. */
    issueTemporaryThreadCleanup(expected: BaleTemporaryThreadEntry, authority: BaleWorkspaceRestoreAuthority): {
        issued: true;
        entry: BaleTemporaryThreadEntry;
    } | undefined;
    /** Caller proves source settlement or cancellation and target disposition; this releases protection only. */
    /** `completed` names one newly completed group; every other known group must already be cancelled or completed. */
    retireTemporaryThread(expected: BaleTemporaryThreadEntry, authority: BaleWorkspaceRestoreAuthority, completed?: BaleTemporaryThreadInput): BaleTemporaryThreadEntry | undefined;
    /** New-world restart: atomically forgets this operator's Restore intents and temporary entries from previous runtime instances.
     * Caller may preserve exact unbound temporary tokens for clock-bearing sources. Committed bindings stay; nothing is rolled back, replayed or deleted here. */
    forgetPreviousWorld(authority: BaleWorkspaceRestoreAuthority, preserveTemporaryTokens?: readonly string[]): {
        operations: BaleWorkspaceRestoreIntent[];
        temporaryThreads: BaleTemporaryThreadEntry[];
        liveRebindings?: BaleWorkspaceLiveRebindIntent[];
    } | undefined;
}
export interface BaleWorkspaceRestoreOptions {
    profileName: string;
    tokenSha256: string;
    isCurrentScope?: () => boolean;
    maxBytes?: number;
    getNowMs?: () => number;
    legacyPath?: string;
    onPublicationBoundary?: (boundary: "after-write-before-rename" | "after-rename") => void;
}
export interface BaleSessionReplacementIntent {
    continuity: "workspace-thread" | "classic-chat";
    cwd: string;
    profileName: string;
    sourceSessionId: string;
    sourceUpdateId: number;
    target: BaleTarget;
    messageId: number;
    slot?: string;
    threadName?: string;
    createdAtMs: number;
    expiresAtMs: number;
    /**
     * Present only when the leader published the intent for a registered
     * follower. Successor re-key and settlement must come from this exact
     * follower runtime or its authenticated same-process session handoff.
     */
    sourceInstanceId?: string;
}
export interface BaleTopicTargetFile {
    version: 1;
    source: "snapshot";
    writtenAtMs: number;
    bot: BaleBotStateSnapshot;
    threads: BaleTopicTargetRecord[];
    identities?: BaleThreadIdentityRecord[];
    workspaceBindings?: BaleWorkspaceThreadBinding[];
    workspaceRetirements?: BaleWorkspaceRetirementIntent[];
    workspaceRestore?: BaleWorkspaceRestoreSnapshot;
    sessionReplacement?: BaleSessionReplacementIntent;
    reservations?: BaleThreadReservation[];
    pendingProvisions?: BaleThreadPendingProvision[];
    pendingCleanups?: BaleThreadCleanupIntent[];
    syncObservations?: BaleTopicSyncObservation[];
}
export interface BaleTopicTargetStore {
    load: () => Promise<void>;
    /** Discard process-local projections and reload owner-published state. */
    refresh?: () => Promise<void>;
    /** Optional caller fence supplements, never replaces, captured publication authority. */
    persist: (isCurrent?: () => boolean) => Promise<void>;
    invalidateTarget: (target: BaleTarget, isCurrent: () => boolean, lastSyncError: string) => Promise<boolean>;
    /** Caller proves owner detachment; this does not assert Bale Thread absence. */
    detachTargetOwner: (expected: BaleTopicTargetRecord, isCurrent: () => boolean) => Promise<boolean>;
    /** Caller holds Workspace admission; publication uses this store's exact transport-owner fence. */
    workspaceRestore: (options: BaleWorkspaceRestoreOptions) => BaleWorkspaceRestore;
    /** Read-only precondition under caller-owned admission; not registration or transport authority. */
    assertWorkspaceRestoreRegistration: (candidate: {
        target: BaleTarget;
        bindingKey?: string;
        slot?: string;
    }) => void;
    /** Runs synchronous live publication under the same evidence transaction; caller retains authentication/admission. */
    commitWorkspaceRestoreRegistration: (candidate: Parameters<BaleTopicTargetStore["assertWorkspaceRestoreRegistration"]>[0], publish: () => void) => void;
    /** Read-only canonical observation; the callback must finish synchronously under the snapshot transaction. */
    withWorkspaceRestoreSnapshot: (expected: BaleWorkspaceRestoreIntent | BaleWorkspaceLiveRebindIntent, observe: (snapshot: Readonly<Pick<BaleTopicTargetFile, "threads" | "workspaceBindings">>) => undefined) => void;
    /** Exact synchronous live-operation snapshot, including a current publication frame; no mutation, lock or authority grant. */
    withWorkspaceLiveRebindSnapshot: (expected: BaleWorkspaceLiveRebindIntent, observe: (snapshot: Readonly<Pick<BaleTopicTargetFile, "threads" | "workspaceBindings">>) => undefined) => void;
    /** Current live-origin ownership veto; effect callers still require Workspace admission. False is not work/recipient/deletion authority. */
    hasPreDispatchRebindEvidence: () => boolean;
    listProtectedLiveRebindTargets: () => BaleTarget[];
    isWorkspaceLiveRebindCleanupTargetProtected: (expected: BaleWorkspaceLiveRebindIntent) => boolean;
    /** Read-only captured identity with an optional exact manual-name result fence; no transport/session/admission grant or lock. */
    captureWorkspaceThreadRenameObservation: (binding: BaleWorkspaceThreadBinding, owner: BaleTopicTargetRecord) => (expectedManualThreadName?: string) => boolean;
    /** Captured read-only identity and exact absent-manual-name/automatic-title result fences; no authority grant or lock. */
    captureWorkspaceThreadResetObservation: (binding: BaleWorkspaceThreadBinding, owner: BaleTopicTargetRecord) => {
        isCurrent: () => boolean;
        isResultCurrent: (automaticTitle: string) => boolean;
    };
    /** Fresh strict disk read of acknowledged temporary-tab targets; throws rather than guessing absence. */
    listTemporaryThreadTargets: () => BaleTarget[];
    list: () => BaleTopicTargetRecord[];
    getFollowerRecoveryHintByTarget?: (target: BaleTarget) => {
        slot?: string;
        threadName?: string;
    } | undefined;
    listReservations: () => BaleThreadReservation[];
    listPendingProvisions: () => BaleThreadPendingProvision[];
    resetPendingProvisionForConnect: (expected: BaleThreadPendingProvision, isCurrent: () => boolean) => Promise<boolean>;
    listPendingCleanups: () => BaleThreadCleanupIntent[];
    listSyncObservations: () => BaleTopicSyncObservation[];
    reserveThread: (reservation: BaleThreadReservation) => void;
    upsertPendingProvision: (provision: BaleThreadPendingProvision) => void;
    recordPendingProvisionTargetRecovery: (provision: BaleThreadPendingProvision, target: BaleTarget & {
        threadId: number;
    }) => Promise<boolean>;
    removePendingProvision: (id: string) => boolean;
    upsertPendingCleanup: (intent: BaleThreadCleanupIntent) => void;
    removePendingCleanup: (id: string) => boolean;
    getBotState: () => BaleBotStateSnapshot;
    setBotState: (state: Partial<BaleBotStateSnapshot>) => void;
    setStatusSnapshot: (snapshot: {
        runtime?: Record<string, unknown>;
        liveRoster?: Record<string, unknown>;
        diagnostics?: Record<string, unknown>;
    }) => void;
    /** Writes the non-canonical status projection to its own file; it never touches canonical state or grants authority. */
    persistStatus: () => Promise<void>;
    getByProfileKey: (profileKey: string) => BaleTopicTargetRecord | undefined;
    getActiveByInstanceId: (instanceId: string) => BaleTopicTargetRecord | undefined;
    getIdentityByProfileKey: (profileKey: string) => BaleThreadIdentityRecord | undefined;
    forgetIdentityByProfileKey: (profileKey: string) => boolean;
    listWorkspaceBindings: () => BaleWorkspaceThreadBinding[];
    getWorkspaceBindingByTarget: (target: BaleTarget, sessionId?: string) => BaleWorkspaceThreadBinding | undefined;
    getSessionReplacementIntent: () => BaleSessionReplacementIntent | undefined;
    commitSessionReplacementIntent: (intent: BaleSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    removeSessionReplacementIntent: (expected: BaleSessionReplacementIntent, isCurrent: () => boolean) => Promise<boolean>;
    listWorkspaceRetirementIntents: () => BaleWorkspaceRetirementIntent[];
    /** Metadata subset CAS only: callers prove exact-source/writer evidence; independent snapshot roots are untouched. */
    commitWorkspaceJournalEvidence: (expected: BaleWorkspaceThreadBinding, journalBindingKeys: readonly string[], complete: boolean, journalSources?: readonly BaleWorkspaceJournalSource[]) => BaleWorkspaceThreadBinding | undefined;
    /** Acknowledge publication of the exact current metadata frame; never roll it back after an uncertain write. */
    persistWorkspaceJournalEvidence: (expected: BaleWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<boolean>;
    upsertWorkspaceRetirementIntent: (intent: BaleWorkspaceRetirementIntent) => boolean;
    removeWorkspaceRetirementIntent: (expected: BaleWorkspaceRetirementIntent) => boolean;
    replaceWorkspaceRetirementIntent: (expected: BaleWorkspaceRetirementIntent, replacement: BaleWorkspaceRetirementIntent, isCurrent: () => boolean) => Promise<boolean>;
    commitWorkspaceRetirement: (expected: BaleWorkspaceRetirementIntent, isCurrent: () => boolean) => Promise<boolean>;
    commitInactiveWorkspaceCleanup: (expected: BaleWorkspaceThreadBinding | {
        cwd: string;
        workspaceKey: string;
        sessionId?: string;
        sessionKey?: string;
        instanceSlot: string;
        slot: string | null;
        bindingKey: string;
        target: {
            chatId: number;
            threadId: number;
        };
        inactiveSinceMs: number;
        bindingUpdatedAtMs: number;
    }, isCurrent: () => boolean) => Promise<boolean>;
    /** Caller must separately prove no external live owner, accepted work, or delivery authority. */
    captureWorkspaceSlotOccupancy: (getExternalProtection: BaleWorkspaceExternalProtectionCapture, options?: {
        expectedRetirement?: BaleWorkspaceRetirementIntent;
    }) => BaleWorkspaceSlotOccupancySnapshot;
    /**
     * Fallback for a full A-Z pool: strips the display letter from the least recently used
     * binding (and its current Thread record) and persists, so a fresh allocation can take it.
     * Metadata only: the Thread, journals and accepted work stay untouched, and a binding or
     * letter held by a claim, reservation, provision, cleanup or retirement is never chosen.
     */
    reuseLeastRecentlyUsedWorkspaceSlot: (isCurrent: () => boolean) => Promise<{
        kind: "free";
    } | {
        kind: "reused";
        bindingKey: string;
        slot: string;
    } | undefined>;
    hasWorkspaceBinding: (cwd: string, sessionId?: string) => boolean;
    setWorkspaceDisplayTitle: (expected: BaleWorkspaceThreadBinding, title: string) => boolean;
    markWorkspaceBindingInactiveByTarget: (target: BaleTarget, inactiveSinceMs?: number) => boolean;
    markWorkspaceBindingActiveByTarget: (target: BaleTarget) => boolean;
    getWorkspaceBinding: (cwd: string, instanceSlot?: string, sessionId?: string) => BaleWorkspaceThreadBinding | undefined;
    claimWorkspaceIdentity: (cwd: string, instanceId: string, previousInstanceId?: string, options?: {
        existingBindingOnly?: boolean;
        sessionId?: string;
        provisionProfileKey?: string;
        /** Explicit same-process session handoff from `previousInstanceId`; never inferred. */
        sessionHandoff?: boolean;
        onCapacityUnavailable?: () => void;
    }) => BaleWorkspaceBindingIdentity | undefined;
    /**
     * Re-keys one retained Thread binding from a retired session to its successor at the same slot and target,
     * so the tab keeps a single owner. Fails without mutation when the source binding or slot identity is absent.
     */
    adoptWorkspaceThreadBindingForSession: (cwd: string, sourceSessionId: string, sessionId: string, target: BaleTarget) => boolean;
    releaseWorkspaceClaim: (instanceId: string) => boolean;
    upsertWorkspaceBinding: (binding: BaleWorkspaceThreadBinding, claimInstanceId?: string) => BaleWorkspaceThreadBinding | undefined;
    upsert: (record: BaleTopicTargetRecord) => BaleTopicTargetRecord;
    markOfflineByInstanceId: (instanceId: string) => number;
    markStaleByTarget: (target: BaleTarget, syncStatus?: BaleTopicSyncStatus, lastSyncError?: string) => boolean;
    markActiveByTarget: (target: BaleTarget) => boolean;
    renameByTarget: (target: BaleTarget, threadName: string, options?: {
        updateDisplayTitle: boolean;
    }) => BaleTopicTargetRecord | undefined;
    /** Publish a manual-name candidate without first retaining it in the dirty local projection. */
    renameByTargetAndPersist: (target: BaleTarget, threadName: string, options: {
        updateDisplayTitle: boolean;
    }, isCurrent: () => boolean) => Promise<BaleTopicTargetRecord | undefined>;
    clearManualNameByTarget: (target: BaleTarget, automaticTitle: string) => BaleTopicTargetRecord | undefined;
    /** Stage exact manual-name removal and automatic display metadata in the existing publication candidate. */
    clearManualNameByTargetAndPersist: (target: BaleTarget, automaticTitle: string, isCurrent: () => boolean) => Promise<BaleTopicTargetRecord | undefined>;
    allocateSlot: (profileKey: string, preferredSlot?: string, workspaceBindingKey?: string, options?: {
        excludeCurrentRecord?: boolean;
    }) => string | undefined;
    /** Claim the first reusable inactive thread for an instance, linking it to instanceId. */
    claimReusableTarget: (instanceId: string, threadName?: string) => BaleTopicTargetRecord | undefined;
}
export declare function createBaleCleanupTargetProtection(store: Pick<BaleTopicTargetStore, "list"> & Partial<Pick<BaleTopicTargetStore, "listReservations" | "listPendingProvisions" | "listPendingCleanups" | "listTemporaryThreadTargets" | "listProtectedLiveRebindTargets">>, departingRecord?: BaleTopicTargetRecord): NonNullable<ThreadReconciler.ThreadReconciliationApplyPorts["isCleanupTargetProtected"]>;
export interface BaleTopicTargetStoreOptions {
    path: string | (() => string);
    baleProfile?: string | (() => string | undefined);
    getNowMs?: () => number;
    canPersist?: () => boolean;
    commitPersist?: (commit: () => void) => boolean;
    consolidated?: Pick<BaleConsolidatedWorkspaceStorageOptions, "captureAuthority" | "publishIfOwned">;
    getExternalReservedSlots?: () => readonly string[];
}
export interface BaleTopicTargetProvisionerDeps {
    topicChatId: number;
    store: Pick<BaleTopicTargetStore, "list" | "getByProfileKey" | "getActiveByInstanceId" | "getIdentityByProfileKey" | "forgetIdentityByProfileKey" | "upsert" | "markStaleByTarget" | "allocateSlot" | "claimReusableTarget" | "listWorkspaceBindings" | "listPendingProvisions" | "upsertPendingProvision" | "recordPendingProvisionTargetRecovery" | "removePendingProvision" | "listSyncObservations" | "listPendingCleanups" | "persist">;
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    topicNameTemplate?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: BaleWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    claimPendingTargets?: boolean;
}
export interface BaleTopicTargetRenamerDeps {
    store: Pick<BaleTopicTargetStore, "list" | "listWorkspaceBindings" | "listPendingProvisions"> & {
        renameByTarget: (...args: Parameters<BaleTopicTargetStore["renameByTarget"]>) => ReturnType<BaleTopicTargetStore["renameByTarget"]> | Promise<ReturnType<BaleTopicTargetStore["renameByTarget"]>>;
    };
    callApi: <TResponse>(method: string, body: Record<string, unknown>, options?: BaleApiCallOptions) => Promise<TResponse>;
    assertAuthority?: () => void;
    shouldRenameDisplayedTitle?: () => boolean;
    topicNameTemplate?: string;
}
export interface BaleTopicTargetProvisionRequest {
    instanceId: string;
    owner?: BaleThreadOwner;
    /** Legacy string key derived from `owner`; always present in memory. */
    profileKey: string;
    threadName?: string;
    preferredSlot?: string;
    workspaceBindingKey?: string;
    workspaceCwd?: string;
}
/** Pending creation evidence cannot bypass an exact target's unresolved cleanup or closure. */
export declare function assertBalePendingTopicRecoveryAllowed(store: Pick<BaleTopicTargetStore, "listPendingProvisions" | "listPendingCleanups" | "listSyncObservations">, target: BaleTarget): void;
/** Settle creation-title evidence with the exact Workspace claim; caller fences and persists. */
export declare function commitBaleWorkspaceProvisionBinding(input: {
    store: Pick<BaleTopicTargetStore, "upsertWorkspaceBinding" | "setWorkspaceDisplayTitle" | "listPendingProvisions" | "removePendingProvision" | "listPendingCleanups" | "listSyncObservations">;
    binding: BaleWorkspaceThreadBinding;
    instanceId: string;
    profileKey: string;
    displayTitle?: string;
}): BaleWorkspaceThreadBinding;
export interface BaleTopicTargetRenameRequest {
    target: BaleTarget & {
        threadId: number;
    };
    threadName: string;
    slot?: string;
}
export interface BaleTopicTargetProvisionResult {
    target: BaleTarget & {
        threadId: number;
    };
    reused: boolean;
    record: BaleTopicTargetRecord;
    displayTitle?: string;
}
export declare const BALE_LEADER_SESSION_HANDOFF_TTL_MS = 30000;
export interface BaleLeaderSessionHandoff {
    pid: number;
    instanceId: string;
    createdAtMs: number;
    profileKey: string;
    target: BaleTarget & {
        threadId: number;
    };
    slot?: string;
    threadName?: string;
}
export declare function getBaleLeaderSessionHandoff(): BaleLeaderSessionHandoff | undefined;
export declare function setBaleLeaderSessionHandoff(handoff: BaleLeaderSessionHandoff | undefined): void;
export declare function getBaleThreadOwnerKey(owner: BaleThreadOwner): string;
export declare function getBaleThreadOwnerFromProfileKey(profileKey: string): BaleThreadOwner;
export declare function normalizeBaleSessionReplacementIntent(value: unknown): BaleSessionReplacementIntent | undefined;
export declare const isBaleWorkspaceRestoreRecipient: (value: unknown) => value is BaleWorkspaceRestoreRecipient;
export declare function isBaleWorkspaceRestoreRequest(value: unknown): value is BaleWorkspaceRestoreRequest;
/** Stable acceptance scope, not a removal ACK; adoption and mutable progress cannot change it. */
export declare function getBaleWorkspaceRestoreSourceCompletionSha256(operation: BaleWorkspaceRestoreIntent, acceptance: BaleWorkspaceRestoreSourceAcceptance): string;
export declare function getBaleTemporaryThreadInputs(entry: BaleTemporaryThreadEntry): BaleTemporaryThreadInput[];
/** Every known group is durably cancelled or Forward-completed; still not deletion authority by itself. */
export declare function isBaleTemporaryThreadFullyResolved(entry: BaleTemporaryThreadEntry): boolean;
/** Canonical issuance is distinct from cleanup completion, source disposition and peer dispatch readiness. */
export declare function isBaleLiveRebindInputAuthorized(value: BaleWorkspaceLiveRebindIntent): boolean;
/** The unified section accepts only lossless current-format Workspace evidence, never tolerant legacy repair. */
export declare function parseBaleWorkspaceStateSection(value: unknown, profile: string): BaleTopicTargetFile | undefined;
export declare function resolveBaleWorkspaceProvisionRecoveryPath(statePath: string, profileName?: string, layout?: "consolidated"): string;
export interface BaleConsolidatedWorkspaceStorageOptions {
    getPath: () => string;
    getProfile: () => string | undefined;
    /** Exact owner/context/session grant captured before the caller's first await. */
    captureAuthority: () => (() => boolean) | undefined;
    publishIfOwned: NonNullable<BaleLockRuntime<BaleLockContext>["publishStateSectionIfOwned"]>;
}
export type BaleWorkspaceStatePublication = <T>(mutate: (current: unknown) => BaleRuntimeStateMutation<T>, publication?: Partial<Pick<BaleOwnedStatePublicationOptions, "onPublicationBoundary" | "publishRename" | "isCurrent">>) => BaleOwnedStatePublicationResult<T>;
/** Prepared Workspace IO adapter; transition/CAS policy remains with the existing Threads owner. */
export declare function createBaleConsolidatedWorkspaceStorage(options: BaleConsolidatedWorkspaceStorageOptions): {
    readRaw: () => unknown;
    read: () => BaleTopicTargetFile | undefined;
    capturePublication(): BaleWorkspaceStatePublication | undefined;
};
export declare function isSameBaleProcessInstance(left: string | undefined, right: string | undefined): boolean;
/** Resolving selects a scope-bound view of the existing Workspace owner; it creates no files. */
export declare function createBaleWorkspaceRestoreResolver(deps: {
    getProfileName: () => string | undefined;
    getBotToken: () => string | undefined;
    threadStore: Pick<BaleTopicTargetStore, "workspaceRestore">;
    agentDir?: string;
}): () => BaleWorkspaceRestore | undefined;
export declare function createBaleTopicTargetStore(options: BaleTopicTargetStoreOptions): BaleTopicTargetStore;
export interface BalePromoteFollowerBindingToLeaderDeps {
    store: BaleTopicTargetStore;
    instanceId: string;
    cwd?: string;
    sessionId?: string;
    baleProfile?: string;
    target?: BaleTarget;
    slot?: string;
    threadName?: string;
    nowMs?: number;
}
export declare function promoteBaleFollowerBindingToLeader(deps: BalePromoteFollowerBindingToLeaderDeps): Promise<BaleTopicTargetRecord | undefined>;
export interface BaleOwnTopicProvisionDeps {
    getAllowedUserId: () => number | undefined;
    instanceId: string;
    cwd?: string;
    baleProfile?: string;
    requestedThreadName?: string;
    preferredSlot?: string;
    workspaceBindingKey?: string;
    resolveInitialWorkspaceDisplayTitle?: (binding: BaleWorkspaceDisplayBinding) => string | undefined;
    getNowMs?: () => number;
    getRandom?: () => number;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    getThreadReconciliationMachineState?: () => ThreadReconciler.ThreadReconciliationMachineState | undefined;
    recordThreadReconciliationPlan?: (plan: ThreadReconciler.ThreadReconciliationPlan) => void;
    store: BaleTopicTargetStore;
    callApi: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    recordEvent: (category: string, message: string, details?: Record<string, unknown>) => void;
}
export interface BaleOwnTopicProvisionResult {
    target: BaleTarget & {
        threadId: number;
    };
    slot: string;
    threadName?: string;
    displayTitle?: string;
    reused: boolean;
}
/**
 * Provision a topic for the bus leader's own use (slot A).
 * This is a thread-binding primitive; sync policy decides when startup/connect
 * should call it to ensure the leader has a visible working thread.
 */
export declare function provisionOwnBusTopic(deps: BaleOwnTopicProvisionDeps): Promise<BaleOwnTopicProvisionResult | undefined>;
export interface BaleInstanceThreadIdentityCandidate {
    target?: BaleTarget;
    slot?: string;
    threadName?: string;
}
export declare function resolveBaleInstanceThreadIdentity(options: {
    target?: BaleTarget;
    follower?: BaleInstanceThreadIdentityCandidate;
    leader?: BaleInstanceThreadIdentityCandidate;
    record?: BaleTopicTargetRecord;
}): BaleInstanceThreadIdentityCandidate;
export interface BaleWorkspaceThreadRenameAuthority {
    context: unknown;
    sessionId?: string;
    sessionGeneration: number;
    cwd?: string;
    profileName?: string;
    botToken?: string;
    operatorUserId?: number;
    leaderEpoch?: string | number;
    ownsDirectDelivery: boolean;
    followerRegistered: boolean;
    localTarget?: BaleTarget;
    localSlot?: string;
}
interface BaleWorkspaceThreadNameRecipientDeps {
    store: BaleTopicTargetStore;
    instanceId: string;
    target: BaleTarget;
    assertAuthority: () => void;
    getAuthority: () => BaleWorkspaceThreadRenameAuthority;
}
/** Prepared recipient identity/result fences; callers retain Workspace admission and transport effects. */
export declare function createBaleWorkspaceThreadRenameRecipient(deps: BaleWorkspaceThreadNameRecipientDeps): {
    assertAuthority: () => void;
    assertResult: (result: BaleTopicTargetRecord) => void;
};
/** Exact automatic-title/absent-name result fences, separate from recipient identity and issued effects. */
export declare function createBaleWorkspaceThreadResetRecipient(deps: BaleWorkspaceThreadNameRecipientDeps): {
    assertAuthority: () => void;
    assertResult: (automaticTitle: string) => void;
};
export interface BaleLeaderThreadStateRuntime {
    getTarget(): BaleTarget | undefined;
    getIdentity(): BaleInstanceThreadIdentityCandidate | undefined;
    set(input: BaleInstanceThreadIdentityCandidate & {
        target: BaleTarget;
    }): void;
    clear(): void;
}
export declare function createBaleLeaderThreadStateRuntime(): BaleLeaderThreadStateRuntime;
export interface BaleCurrentInstanceThreadRuntime {
    findRecord(): BaleTopicTargetRecord | undefined;
    getRecord(): BaleTopicTargetRecord | undefined;
    getIdentity(target?: BaleTarget): BaleInstanceThreadIdentityCandidate;
    getRestorationIdentity(): BaleInstanceThreadIdentityCandidate;
}
export interface BaleCurrentInstanceThreadRuntimeDeps {
    instanceId: string;
    listRecords(): readonly BaleTopicTargetRecord[];
    getPreferredTarget(): BaleTarget | undefined;
    getFollower(): (BaleInstanceThreadIdentityCandidate & {
        registered: boolean;
    }) | undefined;
    getLeader(): BaleInstanceThreadIdentityCandidate | undefined;
}
export declare function createBaleCurrentInstanceThreadRuntime(deps: BaleCurrentInstanceThreadRuntimeDeps): BaleCurrentInstanceThreadRuntime;
export declare function findCurrentBaleInstanceThreadRecord(options: {
    records: readonly BaleTopicTargetRecord[];
    instanceId: string;
    preferredTarget?: BaleTarget;
}): BaleTopicTargetRecord | undefined;
export interface BaleThreadStatusProjectionRuntime {
    getBusRole(): "leader" | "follower" | undefined;
    getBusFollowers(): ReturnType<typeof listBaleThreadStatusFollowers>;
    getLocalBus(): {
        leaderSocketPath: string;
        leaderTransport: "socket" | "pipe";
        followerSocketPath: string;
        followerTransport: "socket" | "pipe";
        followerRegistered: boolean;
        followerTarget?: BaleTarget;
        followerSlot?: string;
        followerThreadName?: string;
        leaderProtocol?: {
            protocolVersion: number;
            runtimeBuild: string;
            capabilities: string[];
        };
    };
    getTopicTargets(): ReturnType<typeof listBaleThreadStatusTargets>;
    getThreadReservations(): ReturnType<typeof listBaleThreadStatusReservations>;
    getTopicSyncObservations(): ReturnType<typeof listBaleThreadStatusObservations>;
    getInstanceSlot(): string | undefined;
    getInstanceThreadName(): string | undefined;
}
export interface BaleThreadStatusProjectionRuntimeDeps {
    getThreadMode(): "unknown" | "enabled" | "disabled";
    isBusPollingStarted(): boolean;
    isFollowerRegistered(): boolean;
    listFollowers(): readonly BaleThreadStatusFollowerView[];
    listRecords(): readonly BaleTopicTargetRecord[];
    listReservations(): readonly BaleThreadReservation[];
    listSyncObservations(): readonly BaleTopicSyncObservation[];
    getLeaderSocketPath(): string;
    getFollowerSocketPath(): string;
    getTransportKind(path: string): "socket" | "pipe";
    getFollowerTarget(): BaleTarget | undefined;
    getFollowerSlot(): string | undefined;
    getFollowerThreadName(): string | undefined;
    getLeaderProtocol?(): {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    } | undefined;
    getCurrentIdentity(): BaleInstanceThreadIdentityCandidate;
    getDisplayTitle?: (target: BaleTarget) => string | undefined;
}
export declare function createBaleThreadStatusProjectionRuntime(deps: BaleThreadStatusProjectionRuntimeDeps): BaleThreadStatusProjectionRuntime;
export interface BaleCurrentThreadAssemblyDeps {
    instanceId: string;
    listRecords: BaleCurrentInstanceThreadRuntimeDeps["listRecords"];
    listWorkspaceBindings?: () => readonly BaleWorkspaceThreadBinding[];
    /** Display-mode title for a binding whose tab has no acknowledged title yet (fresh, moved or reclaimed). */
    resolveAutomaticDisplayTitle?: (binding: BaleWorkspaceThreadBinding) => string | undefined;
    getFollowerDisplayTitle?: () => string | undefined;
    getActiveTurnTarget(): BaleTarget | undefined;
    getFollowerTarget(): BaleTarget | undefined;
    isFollowerRegistered(): boolean;
    getFollowerSlot(): string | undefined;
    getFollowerThreadName(): string | undefined;
    getLeaderIdentity(): BaleInstanceThreadIdentityCandidate | undefined;
    getLeaderTarget(): BaleTarget | undefined;
    getLeaderProtocol?: BaleThreadStatusProjectionRuntimeDeps["getLeaderProtocol"];
    status: Pick<BaleThreadStatusProjectionRuntimeDeps, "getThreadMode" | "isBusPollingStarted" | "listFollowers" | "listReservations" | "listSyncObservations" | "getLeaderSocketPath" | "getFollowerSocketPath" | "getTransportKind">;
}
export interface BaleCurrentThreadAssembly {
    getDisplayTitle: (target: BaleTarget) => string | undefined;
    current: BaleCurrentInstanceThreadRuntime;
    status: BaleThreadStatusProjectionRuntime;
}
/** Own current-thread preference and its matching status projection. */
export declare function createBaleCurrentThreadAssembly(deps: BaleCurrentThreadAssemblyDeps): BaleCurrentThreadAssembly;
export interface BaleThreadStatusFollowerView {
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: BaleTarget;
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
}
export declare function listBaleThreadStatusFollowers(options: {
    followers: readonly BaleThreadStatusFollowerView[];
    records: readonly BaleTopicTargetRecord[];
}): Array<{
    instanceId: string;
    cwd?: string;
    lastHeartbeatMs: number;
    target?: BaleTarget;
    protocol?: {
        protocolVersion: number;
        runtimeBuild: string;
        capabilities: string[];
    };
    slot?: string;
    threadName?: string;
    status?: string;
}>;
export declare function listBaleThreadStatusTargets(records: readonly BaleTopicTargetRecord[]): Array<{
    instanceId?: string;
    status: BaleTopicTargetStatus;
    target: BaleTarget & {
        threadId: number;
    };
    slot?: string;
    threadName?: string;
    syncStatus?: BaleTopicSyncStatus;
    lastSyncObservedAtMs?: number;
    lastSyncProbeAtMs?: number;
    lastSyncError?: string;
    lastReconcileAction?: string;
}>;
export declare function listBaleThreadStatusReservations(reservations: readonly BaleThreadReservation[]): Array<{
    target: BaleTarget & {
        threadId: number;
    };
    slot: string;
    reason: string;
    instanceId?: string;
    expiresAtMs?: number;
    lastReconcileAction?: string;
}>;
export declare function listBaleThreadStatusObservations(observations: readonly BaleTopicSyncObservation[]): Array<{
    target: BaleTarget & {
        threadId: number;
    };
    syncStatus: BaleTopicSyncStatus;
    observedAtMs: number;
    instanceId?: string;
    slot?: string;
    lastSyncError?: string;
    lastReconcileAction?: string;
}>;
export declare function getBaleTargetFromApiBody(body: unknown): (BaleTarget & {
    threadId: number;
}) | undefined;
export declare function isBaleTopicTargetStaleError(error: unknown): boolean;
export declare function isBaleTopicModeUnavailableError(error: unknown): boolean;
export declare function createBaleTopicTargetRenamer(deps: BaleTopicTargetRenamerDeps): (request: BaleTopicTargetRenameRequest) => Promise<BaleTopicTargetRecord | undefined>;
/** Caller holds profile Workspace admission; only an explicit connect grants a fresh creation attempt. */
export declare function resetBaleConnectionProvisioning(input: {
    store: BaleTopicTargetStore;
    owner: BaleThreadPendingProvision["owner"];
    instanceId: string;
    profileKey: string;
    isCurrent: () => boolean;
    recordEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
}): Promise<void>;
export declare function createBaleTopicTargetProvisioner(deps: BaleTopicTargetProvisionerDeps): (request: BaleTopicTargetProvisionRequest) => Promise<BaleTopicTargetProvisionResult>;
