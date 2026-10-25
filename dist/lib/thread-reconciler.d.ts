/**
 * Bale thread lifecycle reconciler
 * Zones: bale, multi-instance bus, synchronization control plane
 * Owns pure planning for Bale thread/tab lifecycle reconciliation and destructive topic cleanup authority
 * Excludes live Bale API calls, inbound routing, menu rendering, and direct thread-store persistence
 */
import type { BaleTarget } from "./target.ts";
type ThreadTarget = BaleTarget & {
    threadId: number;
};
type ThreadRecordStatus = "active" | "offline" | "stale" | "pending" | "starting" | "probe-required" | "failed";
export interface ThreadReconciliationRecord {
    target: ThreadTarget;
    status: ThreadRecordStatus;
    instanceId?: string;
    profileKey?: string;
    ownerKind?: "leader" | "manual-follower" | "pending-topic" | "legacy";
}
export interface ThreadReconciliationReservation {
    target: ThreadTarget;
    expiresAtMs?: number;
}
export interface ThreadReconciliationObservation {
    target: ThreadTarget;
    syncStatus: "open" | "closed" | "deleted" | "unknown";
    observedAtMs: number;
}
export interface BaleThreadPendingProvision {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    slot?: string;
    target?: BaleTarget & {
        threadId: number;
    };
    startedAtMs: number;
    expiresAtMs?: number;
    leaderEpoch?: number | string;
}
export interface BaleThreadCleanupIntent {
    id: string;
    owner: "leader" | "manual-follower";
    instanceId: string;
    runtimeGeneration: string;
    profileKey?: string;
    target: ThreadTarget;
    requestedAtMs: number;
}
export interface BaleUnboundThreadMessageObservation {
    target: BaleTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    leaderEpoch?: number | string;
}
export interface BaleReservedThreadMessageObservation {
    target: BaleTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    leaderEpoch?: number | string;
}
export interface ReplacedInstanceBindingInput {
    instanceId: string;
    replacementTarget: ThreadTarget;
}
export interface PreviousLeaderCleanupInput {
    currentInstanceId: string;
}
export type ThreadReconciliationAction = {
    kind: "mark-topic-active";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "observed-open";
} | {
    kind: "mark-topic-stale";
    target: BaleTarget & {
        threadId: number;
    };
    syncStatus: "closed" | "deleted";
    reason: "observed-closed" | "observed-deleted";
} | {
    kind: "close-delete-unbound-topic";
    target: BaleTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    reason: "unbound-user-message";
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-reserved-topic";
    target: BaleTarget & {
        threadId: number;
    };
    observedAtMs: number;
    messageId?: number;
    reason: "reserved-user-message" | "startup-reservation";
    leaderEpoch?: number | string;
} | {
    kind: "close-stale-replaced-topic";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "replaced-instance-binding";
    instanceId?: string;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-replaced-follower-topic";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "replaced-follower";
    instanceId?: string;
    messageId?: number;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-previous-leader-topic";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "previous-leader";
    instanceId?: string;
    messageId?: number;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-graceful-shutdown-topic";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "graceful-shutdown";
    cleanupIntentId: string;
    instanceId: string;
    runtimeGeneration: string;
    leaderEpoch?: number | string;
} | {
    kind: "cancel-superseded-graceful-shutdown-cleanup";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "replacement-registration";
    cleanupIntentId: string;
    instanceId: string;
    runtimeGeneration: string;
    leaderEpoch?: number | string;
} | {
    kind: "close-delete-expired-pending-provision-topic";
    target: BaleTarget & {
        threadId: number;
    };
    reason: "expired-pending-provision";
    pendingProvisionId: string;
    instanceId?: string;
    leaderEpoch?: number | string;
};
export type ThreadReconciliationPhase = "stable" | "provisioning" | "sync-required" | "cleanup-required";
export type ThreadReconciliationEvent = "settled" | "pending-provision" | "sync-required" | "cleanup-required";
export interface ThreadReconciliationMachineState {
    phase: ThreadReconciliationPhase;
    event: ThreadReconciliationEvent;
    atMs: number;
    leaderEpoch?: number | string;
    pendingProvisionCount: number;
    syncActionCount: number;
    cleanupActionCount: number;
}
export interface ThreadReconciliationTransition {
    from: ThreadReconciliationPhase;
    to: ThreadReconciliationPhase;
    event: ThreadReconciliationEvent;
    atMs: number;
}
export interface ThreadReconciliationPlan {
    actions: ThreadReconciliationAction[];
    state?: ThreadReconciliationMachineState;
    transition?: ThreadReconciliationTransition;
}
export interface ThreadReconciliationApplyResult {
    changed: boolean;
    incompleteActions?: ThreadReconciliationAction[];
}
export interface ThreadReconciliationApplyPorts {
    /** Private-chat temporary tabs support deletion, not forum closing. */
    skipCloseBeforeDelete?: boolean;
    isCleanupTargetProtected?: (target: ThreadTarget, action: ThreadReconciliationAction) => boolean;
    callApi?: <TResponse>(method: string, body: Record<string, unknown>) => Promise<TResponse>;
    markActiveByTarget?: (target: ThreadTarget) => boolean;
    markStaleByTarget?: (target: ThreadTarget, syncStatus?: "closed" | "deleted", lastSyncError?: string) => boolean;
    persist?: () => Promise<void>;
    removePendingProvisionById?: (id: string) => boolean;
    removeCleanupIntentById?: (id: string) => boolean;
    getCurrentLeaderEpoch?: () => number | string | undefined;
    recordRuntimeEvent?: (category: string, error: unknown, details?: Record<string, unknown>) => void;
}
export interface ThreadReconciliationInput {
    nowMs: number;
    currentLeaderEpoch?: number | string;
    records: readonly ThreadReconciliationRecord[];
    reservations?: readonly ThreadReconciliationReservation[];
    observations?: readonly ThreadReconciliationObservation[];
    pendingProvisions?: readonly BaleThreadPendingProvision[];
    pendingCleanups?: readonly BaleThreadCleanupIntent[];
    unboundMessages?: readonly BaleUnboundThreadMessageObservation[];
    reservedMessages?: readonly BaleReservedThreadMessageObservation[];
    proactiveReservationCleanup?: boolean;
    replacedBindings?: readonly ReplacedInstanceBindingInput[];
    previousLeaderCleanup?: PreviousLeaderCleanupInput;
    previousState?: ThreadReconciliationMachineState;
    freshCreationGraceMs?: number;
}
/** A Thread record still claims its slot/target while active, starting or pending. */
export declare function isCurrentThreadRecord(record: {
    readonly status: string;
}): boolean;
/** Pure Bot API vocabulary for a deleted/missing Thread; callers own their HTTP-status policy. */
export declare function isBaleTopicDeletedErrorMessage(message: string): boolean;
/** Pure Bot API vocabulary for a closed Thread; closure is not deletion evidence. */
export declare function isBaleTopicClosedErrorMessage(message: string): boolean;
export interface ThreadReconciliationRuntime {
    getState: () => ThreadReconciliationMachineState | undefined;
    recordPlan: (plan: ThreadReconciliationPlan) => void;
    plan: (input: Omit<ThreadReconciliationInput, "previousState">) => ThreadReconciliationPlan;
}
export declare function createThreadReconciliationRuntime(deps: {
    recordRuntimeEvent: (category: string, message: unknown, details?: Record<string, unknown>) => void;
    scheduleSnapshotPersist: () => void;
}): ThreadReconciliationRuntime;
/** Momentary preparation evidence only: not an action, lease, issued effect or reusable deletion grant. */
export interface BaleLiveRebindCleanupPreparation {
    status: "prepared";
    operationId: string;
    target: ThreadTarget;
    recipientTarget: ThreadTarget;
    leaderEpoch: string;
}
export declare function prepareLiveRebindThreadCleanup(input: {
    operationId: string;
    oldTarget: ThreadTarget;
    recipientTarget: ThreadTarget;
    leaderEpoch: string;
    targetProtected: boolean;
    /** Narrow body-free current-work projection; no cached idle or historical disposition proof. */
    work: Readonly<{
        sessionBusy: boolean;
        targetWork: boolean;
        deliveryPending: boolean;
        unknown: boolean;
    }> | undefined;
}): BaleLiveRebindCleanupPreparation | undefined;
export type BaleLiveRebindCleanupOutcome = "confirmed" | "failed" | "unknown";
/**
 * One unretried deletion for an already issued live-rebind cleanup grant. Success or confirmed absence is `confirmed`;
 * protection or authority loss before the request and a definite request rejection are `failed`; every other outcome is
 * `unknown`. The caller owns the durable issue marker and terminal record; this never repeats or rolls back.
 */
export declare function issueLiveRebindThreadCleanup(prepared: BaleLiveRebindCleanupPreparation, ports: {
    /** Throws when the issuer's current recipient/work/ownership authority no longer holds. */
    assertCurrent(): void;
    deleteTopic(target: ThreadTarget): Promise<unknown>;
    classifyFailure(error: unknown): "absent" | "rejected" | "unknown";
}): Promise<BaleLiveRebindCleanupOutcome>;
export declare function applyThreadReconciliationPlan(plan: ThreadReconciliationPlan, ports: ThreadReconciliationApplyPorts): Promise<ThreadReconciliationApplyResult>;
export declare function planThreadReconciliation(input: ThreadReconciliationInput): ThreadReconciliationPlan;
export {};
