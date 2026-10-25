/**
 * Workspace slot rotation
 * Zones: bale, workspace identity, lifecycle
 * Owns fail-closed protection, demand-driven pressure retirement, exact-intent admission,
 * successor recovery, and fenced one-shot deletion before durable slot reuse.
 */
import type { BaleJournalNamespaceInspection, BaleUpdateJournalDeadQueueOwnerRecoveryInput, BaleUpdateJournalDeadQueueOwnerRecoveryResult, BaleUpdateJournalEntry, BaleUpdateJournalQueueOwnerIdentity } from "./journal.ts";
import { type BaleTarget } from "./target.ts";
import { type BaleWorkspaceThreadDeletionTransport } from "./bale-api.ts";
import type { BaleTopicTargetStore, BaleWorkspaceExternalProtectionEvidence, BaleWorkspaceJournalSource, BaleWorkspaceProtectionState, BaleWorkspaceRetirementIntent, BaleWorkspaceThreadBinding } from "./threads.ts";
import { type BaleWorkspaceAdmissionLedger, type BaleWorkspaceAdmissionScope, type BaleWorkspaceDeletionPermit } from "./workspace-admission.ts";
export interface BaleWorkspaceOperationGate {
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}
export declare function createBaleWorkspaceOperationGate(): BaleWorkspaceOperationGate;
export type BaleWorkspaceOperationRunner = <T>(input: {
    operationId: string;
    operationKind: string;
    scopes: readonly BaleWorkspaceAdmissionScope[];
}, operation: () => Promise<T>) => Promise<T>;
export interface BaleWorkspaceOperationRuntime extends BaleWorkspaceOperationGate {
    run: BaleWorkspaceOperationRunner;
}
export declare function createBaleWorkspaceOperationRuntime(input?: {
    getWorkspaceAdmission?: () => Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission"> | undefined;
    onReleaseError?: (error: unknown, operationKind: string) => void;
}): BaleWorkspaceOperationRuntime;
export interface BaleWorkspaceJournalProtectionCapture {
    sources: BaleWorkspaceJournalProtectionSource[];
    complete: boolean;
}
interface BaleWorkspaceJournalReader {
    recoveryKey?: string;
    journal: {
        read: () => {
            entries: readonly {
                update: unknown;
            }[];
            exists?: boolean;
        };
    };
    readForProtection?: () => {
        entries: readonly {
            update: unknown;
        }[];
        exists?: boolean;
    };
}
export declare function captureBaleWorkspaceJournalProtectionSources(input: {
    binding: BaleWorkspaceThreadBinding;
    resolveLeader: () => BaleWorkspaceJournalReader | undefined;
    createFollowerResolver: (journalBindingKey: string) => () => BaleWorkspaceJournalReader | undefined;
    createSessionResolver?: (recipientBindingKey: string, sessionId: string) => () => BaleWorkspaceJournalReader | undefined;
    withJournalReference?: <T>(binding: BaleWorkspaceJournalReader, operation: () => T) => T;
    discovery?: {
        paths: readonly string[];
        complete: boolean;
        createResolver: (path: string) => () => BaleWorkspaceJournalReader | undefined;
    };
    /** Snapshot-scoped reuse of binding-independent (shared/discovered) source reads. */
    sharedSourceReads?: Map<string, BaleWorkspaceJournalProtectionSource>;
}): BaleWorkspaceJournalProtectionCapture;
export type BaleWorkspaceJournalProtectionSource = {
    kind: "available";
    scope: {
        kind: "shared";
    } | {
        kind: "binding";
        bindingKey: string;
        journalBindingKey: string;
        sessionId?: string;
    } | {
        kind: "discovered";
        path: string;
    };
    entries: readonly {
        update: unknown;
    }[];
    /** Positive filesystem presence is distinct from a complete namespace with a missing historical family. */
    exists?: boolean;
} | {
    kind: "unknown";
    scope: {
        kind: "shared";
    } | {
        kind: "binding";
        bindingKey: string;
        journalBindingKey: string;
        sessionId?: string;
    } | {
        kind: "discovered";
        path: string;
    };
};
export declare function resolveBaleWorkspaceAcceptedWorkProtection(input: {
    binding: BaleWorkspaceThreadBinding;
    localAcceptedTargets: readonly {
        chatId: number;
        threadId?: number;
    }[];
    journalSources: readonly BaleWorkspaceJournalProtectionSource[];
    sourcesComplete: boolean;
    /** Relocation cannot infer execution ownership from the original Bale message target. */
    requireBindingProvenance?: boolean;
}): BaleWorkspaceProtectionState;
export type BaleWorkspaceJournalPruneResult = {
    kind: "committed";
    binding: BaleWorkspaceThreadBinding;
    removedKeys: string[];
    removedSources?: BaleWorkspaceJournalSource[];
} | {
    kind: "blocked";
    reason: "incomplete-evidence" | "writer-not-quiescent" | "state-changed" | "publication-refused";
};
export declare function pruneBaleWorkspaceJournalEvidence(input: {
    store: Pick<BaleTopicTargetStore, "commitWorkspaceJournalEvidence" | "persistWorkspaceJournalEvidence">;
    binding: BaleWorkspaceThreadBinding;
    /** Capture fresh source evidence after admission, not a snapshot taken before the lease. */
    capture: () => BaleWorkspaceJournalProtectionCapture;
    runExclusive: BaleWorkspaceOperationGate["runExclusive"];
    getJournalWriterProtection: (journalBindingKey: string) => BaleWorkspaceProtectionState;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    admission: Pick<BaleWorkspaceAdmissionLedger, "acquireAdmission" | "releaseAdmission">;
    isCurrent?: () => boolean;
    onAdmissionReleaseError?: (error: unknown) => void;
}): Promise<BaleWorkspaceJournalPruneResult>;
export declare function captureBaleWorkspaceExternalProtection(input: {
    binding: BaleWorkspaceThreadBinding;
    requireBindingProvenance?: boolean;
    getLiveOwnerProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceProtectionState;
    getLocalAcceptedTargets: (binding: BaleWorkspaceThreadBinding) => {
        targets: readonly BaleTarget[];
        complete: boolean;
    };
    captureJournalSources: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceJournalProtectionCapture;
    getDeliveryAuthorityProtection?: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceProtectionState;
}): BaleWorkspaceExternalProtectionEvidence;
interface BaleWorkspaceProtectionObserverDeps {
    listFollowers: () => readonly {
        target?: BaleTarget;
    }[];
    getActiveTurnTarget: () => BaleTarget | undefined;
    getQueuedItems: () => readonly {
        chatId: number;
        target?: BaleTarget;
    }[];
    resolveLeaderJournal: () => BaleWorkspaceJournalReader | undefined;
    createFollowerJournalResolver: (journalBindingKey: string) => () => BaleWorkspaceJournalReader | undefined;
    createSessionJournalResolver?: (recipientBindingKey: string, sessionId: string) => () => BaleWorkspaceJournalReader | undefined;
    discoverFollowerJournals?: () => {
        paths: readonly string[];
        complete: boolean;
    };
    /** Strict read-only namespace evidence; it never substitutes for writer closure. */
    inspectJournalNamespace?: () => BaleJournalNamespaceInspection;
    createJournalPathResolver?: (path: string) => () => BaleWorkspaceJournalReader | undefined;
    withJournalReference?: <T>(binding: BaleWorkspaceJournalReader, operation: () => T) => T;
    getJournalWriterProtection?: (journalBindingKey: string) => BaleWorkspaceProtectionState;
    getDeliveryAuthorityProtection?: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceProtectionState;
}
export interface BaleWorkspaceProtectionObserver {
    capture: ((binding: BaleWorkspaceThreadBinding, options?: {
        requireBindingProvenance?: boolean;
    }) => BaleWorkspaceExternalProtectionEvidence) & {
        withSnapshot?: <T>(capture: () => T) => T;
    };
    captureJournalSources: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceJournalProtectionCapture;
    getJournalWriterProtection: (journalBindingKey: string) => BaleWorkspaceProtectionState;
}
/** Shared read-only observer: protection and metadata pruning use the same scoped evidence path. */
export declare function createBaleWorkspaceProtectionObserver(deps: BaleWorkspaceProtectionObserverDeps): BaleWorkspaceProtectionObserver;
/** Callable protection view retained for callers that need no metadata observation ports. */
export declare function createBaleWorkspaceExternalProtectionCapture(deps: BaleWorkspaceProtectionObserverDeps): BaleWorkspaceProtectionObserver["capture"];
export declare function createBaleWorkspaceJournalEvidencePruner(deps: BaleWorkspaceOperationGate & {
    store: BaleTopicTargetStore;
    getAdmission: () => BaleWorkspaceAdmissionLedger | undefined;
    getLeaderEpoch: () => number | string | undefined;
    protection: Pick<BaleWorkspaceProtectionObserver, "captureJournalSources" | "getJournalWriterProtection">;
}): (binding: BaleWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<BaleWorkspaceJournalPruneResult>;
export declare function isCurrentBaleWorkspaceBinding(store: Pick<BaleTopicTargetStore, "listWorkspaceBindings">, expected: BaleWorkspaceThreadBinding): boolean;
export interface BaleWorkspaceDeadQueueJournalBinding {
    recoveryKey?: string;
    readForProtection?: () => {
        entries: readonly BaleUpdateJournalEntry[];
    };
    journal: {
        recoverDeadQueueOwner: (input: BaleUpdateJournalDeadQueueOwnerRecoveryInput) => BaleUpdateJournalDeadQueueOwnerRecoveryResult;
    };
}
export type BaleWorkspaceDeadQueueReclamation = {
    kind: "not-needed";
} | {
    kind: "recovered";
    receipts: number;
    updateIds: number[];
} | {
    kind: "blocked";
    reason: "authority-changed" | "live-owner" | "local-work" | "incomplete-source" | "unsupported-custody" | "owner-alive" | "owner-unverifiable" | "mutation-refused" | "protection-retained";
};
/**
 * Demand-only preparation for pressure retirement. Every removed group is still
 * owned by the journal's exact dead-owner CAS; this function never clears local
 * queue memory or turns unknown evidence into deletion authority.
 */
export declare function createBaleWorkspaceDeadOwnerQueueReclaimer(deps: {
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    getActiveTurnTarget: () => BaleTarget | undefined;
    getQueuedItems: () => readonly {
        chatId: number;
        target?: BaleTarget;
    }[];
    resolveLeaderJournal: () => BaleWorkspaceDeadQueueJournalBinding | undefined;
    createFollowerJournalResolver: (journalBindingKey: string) => () => BaleWorkspaceDeadQueueJournalBinding | undefined;
    createSessionJournalResolver?: (recipientBindingKey: string, sessionId: string) => () => BaleWorkspaceDeadQueueJournalBinding | undefined;
    discoverFollowerJournals?: () => {
        paths: readonly string[];
        complete: boolean;
    };
    createJournalPathResolver?: (path: string) => () => BaleWorkspaceDeadQueueJournalBinding | undefined;
    withJournalReference?: <T>(binding: BaleWorkspaceDeadQueueJournalBinding, operation: () => T) => T;
    getRecoveryOwner: () => BaleUpdateJournalQueueOwnerIdentity;
    getQueueOwnerLiveness: (owner: {
        processId: number;
        processBirthId: string;
    }) => "alive" | "dead" | "unverifiable";
    isBindingCurrent: (binding: BaleWorkspaceThreadBinding) => boolean;
    onMutationError?: (error: unknown) => void;
}): (binding: BaleWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<BaleWorkspaceDeadQueueReclamation>;
export type BaleWorkspaceRetirementAdoption = {
    kind: "adopted";
    intent: BaleWorkspaceRetirementIntent;
} | {
    kind: "blocked";
    reason: "intent-conflict" | "profile-changed" | "binding-changed" | "protection-changed" | "commit-rejected";
};
export declare function adoptBaleWorkspaceRetirementIntent(input: {
    store: Pick<BaleTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "replaceWorkspaceRetirementIntent">;
    intent: BaleWorkspaceRetirementIntent;
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<BaleWorkspaceRetirementAdoption>;
export type BaleWorkspaceRetirementExecution = {
    kind: "retired";
    bindingKey: string;
    slot: string;
} | {
    kind: "cancelled";
    reason: "delete-rejected";
} | {
    kind: "retained";
    reason: "stale-intent" | "protection-changed" | "admission-active" | "fence-conflict" | "delete-unconfirmed" | "delete-rejected" | "authority-changed" | "commit-rejected" | "fence-release-unconfirmed";
};
export type BaleWorkspaceRetirementAbsence = "absent" | "present" | "unknown";
export declare function executeBaleWorkspaceRetirement(input: {
    store: Pick<BaleTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "commitWorkspaceRetirement" | "removeWorkspaceRetirementIntent" | "markStaleByTarget" | "persist">;
    admission: Pick<BaleWorkspaceAdmissionLedger, "getOwner" | "read" | "acquireRetirementFence" | "adoptRetirementFence" | "issueDeletionPermit" | "confirmRetirementAbsence" | "confirmRetirementRejection" | "completeRejectedRetirementFence" | "releaseUnissuedRetirementFence" | "completeRetirementFence">;
    intent: BaleWorkspaceRetirementIntent;
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    deleteForumTopic: (permit: BaleWorkspaceDeletionPermit, body: {
        chat_id: number;
        message_thread_id: number;
    }, options: {
        maxAttempts: 1;
    }) => Promise<unknown>;
    confirmTargetAbsent?: (target: BaleTarget & {
        threadId: number;
    }) => Promise<BaleWorkspaceRetirementAbsence>;
}): Promise<BaleWorkspaceRetirementExecution>;
export type BaleWorkspaceRetirementPreparation = {
    kind: "ready";
    intent: BaleWorkspaceRetirementIntent;
} | {
    kind: "not-needed";
    reason: "free-capacity";
} | {
    kind: "blocked";
    reason: "invalid-state" | "protected-capacity" | "state-changed" | "existing-intent-conflict" | "stale-intent";
};
export interface BaleWorkspaceRetirementPreparationDeps {
    store: Pick<BaleTopicTargetStore, "captureWorkspaceSlotOccupancy" | "listWorkspaceBindings" | "listWorkspaceRetirementIntents" | "upsertWorkspaceRetirementIntent" | "removeWorkspaceRetirementIntent" | "persist">;
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    getNowMs?: () => number;
}
export declare function prepareBaleWorkspaceRetirement(deps: BaleWorkspaceRetirementPreparationDeps): Promise<BaleWorkspaceRetirementPreparation>;
export type BaleWorkspaceRetirementLifecycleResult = BaleWorkspaceRetirementExecution | Extract<BaleWorkspaceRetirementPreparation, {
    kind: "not-needed";
}> | {
    kind: "blocked";
    stage: "preparation" | "adoption";
    reason: string;
};
export declare function runBaleWorkspaceRetirementLifecycle(input: {
    store: BaleWorkspaceRetirementPreparationDeps["store"] & Pick<BaleTopicTargetStore, "replaceWorkspaceRetirementIntent" | "commitWorkspaceRetirement" | "markStaleByTarget">;
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    getLeaderEpoch: () => number | string | undefined;
    getProfileKey: () => string;
    isCurrent?: () => boolean;
    getNowMs?: () => number;
    runExclusive: <T>(operation: () => Promise<T>) => Promise<T>;
    admission: Parameters<typeof executeBaleWorkspaceRetirement>[0]["admission"];
    deleteForumTopic: Parameters<typeof executeBaleWorkspaceRetirement>[0]["deleteForumTopic"];
    confirmTargetAbsent?: Parameters<typeof executeBaleWorkspaceRetirement>[0]["confirmTargetAbsent"];
}): Promise<BaleWorkspaceRetirementLifecycleResult>;
export type BaleWorkspaceCapacityRunner = <T>(operation: () => Promise<T>) => Promise<T>;
export interface BaleWorkspaceSlotRotationPorts extends BaleWorkspaceOperationGate {
    getAdmission: () => BaleWorkspaceAdmissionLedger | undefined;
    deleteThread: BaleWorkspaceThreadDeletionTransport;
    pruneJournalEvidence?: (binding: BaleWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<BaleWorkspaceJournalPruneResult>;
    reclaimDeadOwnerQueuedWork?: (binding: BaleWorkspaceThreadBinding, isCurrent: () => boolean) => Promise<BaleWorkspaceDeadQueueReclamation>;
}
/** Retry allocation once, only after the failed operation released all ordinary leases. */
export declare function createBaleWorkspaceSlotRotation(input: BaleWorkspaceSlotRotationPorts & {
    store: BaleTopicTargetStore;
    getLeaderEpoch: () => number | string | undefined;
    getExternalProtection: (binding: BaleWorkspaceThreadBinding) => BaleWorkspaceExternalProtectionEvidence;
    recordEvent: (message: string, details: Record<string, unknown>) => void;
    onSlotReused?: (bindingKey: string, isCurrent: () => boolean) => Promise<void>;
}): BaleWorkspaceCapacityRunner;
export {};
